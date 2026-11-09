#!/usr/bin/env node
// SMX reference agent: read books -> price each rung from the Starship feed -> trade only on clear edge.
// Dry run by default. `--live` signs with SMX_AGENT_KEY (a throwaway Base Sepolia wallet) and sends.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { loadEvents } from "./feed.js";
import { fairValue } from "./model.js";
import { capsAllow, decide } from "./decide.js";
import { connectSmx } from "./smx.js";
import { buildSteps } from "./build.js";

const live = process.argv.includes("--live");
const cfg = JSON.parse(readFileSync(new URL("../config/ladders.json", import.meta.url), "utf8"));
const journalUrl = new URL("../data/journal.jsonl", import.meta.url);
mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const journal = existsSync(journalUrl) ? readFileSync(journalUrl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const log = (e) => { const row = { at: new Date().toISOString(), ...e }; journal.push(row); appendFileSync(journalUrl, JSON.stringify(row) + "\n"); };

let signer = null;
if (live) {
  const { makeSigner } = await import("./signer.js");
  signer = makeSigner(process.env.SMX_AGENT_KEY, process.env.SMX_BUILDER_CODE);
}
const wallet = signer?.address ?? process.env.SMX_AGENT_WALLET ?? null;

/** Build -> sign -> send against the Factory that matches the book, until submitOrder lands. */
async function place(m, order) {
  for (let round = 1; round <= 4; round++) {
    const b = await buildSteps({ book: m.orderBook, wallet, ...pick(order) });
    if (b.blocked) throw new Error(b.blocked);
    for (const step of b.steps) {
      const r = await signer.runStep(step, (e) => log({ marketId: m.id, factory: b.factory, ...e }));
      if (step.step === "submitOrder") return { ...r, account: b.account, factory: b.factory };
    }
  }
  throw new Error("order not placed after 4 build rounds");
}
const pick = ({ outcome, action, qty, limitPrice }) => ({ outcome, action, qty, limitPrice });

let stop = false;
const smx = await connectSmx();
const viewsUrl = new URL("../config/views.json", import.meta.url);
const views = existsSync(viewsUrl) ? JSON.parse(readFileSync(viewsUrl, "utf8")).views ?? {} : {};
const tradeable = (m) => (m.listed || m.excludedReason === "never-traded") && m.trading?.status === "open" && !m.outcome;
const book = (m) => `${m.bestBidBps ? m.bestBidBps / 100 : "-"} / ${m.bestAskBps ? m.bestAskBps / 100 : "-"}`;

/** One market: compare fair value with the book, then hold, plan or place one order. */
async function consider(m, fairCents, why) {
  const d = decide({ fairCents, bestBidBps: m.bestBidBps, bestAskBps: m.bestAskBps }, cfg.trading);
  console.log(`  ${m.id} (by ${m.resolutionDate.slice(0, 10)}): fair ${fairCents}c | book ${book(m)}`);
  console.log(`    ${why}`);
  if (!d.order) { console.log(`    hold: ${d.reason}`); return; }
  const capped = capsAllow(journal, m.id, cfg.trading);
  const o = d.order;
  console.log(`    ${capped ? "capped" : live ? "SEND" : "would"}: buy ${o.qty} ${o.outcome} @ ${o.limitPrice}c (${d.reason})${capped ? ` - ${capped}` : ""}`);
  if (capped) return;
  if (!live) { log({ kind: "order-planned", marketId: m.id, fairCents, ...o }); return; }
  try {
    const built = await place(m, o);
    log({ kind: "order-sent", marketId: m.id, wallet, fairCents, builderCode: process.env.SMX_BUILDER_CODE ?? null, house: process.env.SMX_HOUSE === "1", ...o, tx: built.hash, account: built.account, factory: built.factory });
    console.log(`    sent. Journal: data/journal.jsonl`);
  } catch (e) {
    log({ kind: "order-failed", marketId: m.id, error: e.message.split("\n")[0] });
    console.log(`    failed: ${e.message.split("\n")[0]}`);
    console.log("Stopping this run after a failed order. Fix the cause, then run again.");
    stop = true;
    process.exitCode = 1;
  }
}

try {
  const events = loadEvents();
  const all = await smx.listMarkets();
  const markets = new Map(all.map((m) => [m.id, m]));
  if (process.argv.includes("--list")) {
    console.log("Tradeable SMX markets (Base Sepolia testnet). Add a view in config/views.json to trade one the model doesn't cover.\n");
    for (const m of all.filter(tradeable)) console.log(`  ${m.id.padEnd(34)} ${String(m.title ?? "").slice(0, 60).padEnd(60)} book ${book(m)}  closes ${m.trading.closeAt?.slice(0, 10) ?? "?"}`);
    process.exit(0);
  }
  console.log(`SMX reference agent | ${live ? "LIVE (signing)" : "dry run"} | wallet ${wallet ?? "none"} | ${events.length} feed events | Base Sepolia testnet\n`);
  const covered = new Set();
  for (const ladder of cfg.ladders) {
    if (stop) break;
    console.log(`## ${ladder.name} (model)`);
    for (const id of ladder.markets) {
      if (stop) break;
      covered.add(id);
      const m = markets.get(id);
      if (!m) { console.log(`  ${id}: not found on chain, skipped`); continue; }
      if (!tradeable(m)) { console.log(`  ${id}: trading ${m.trading?.status ?? "?"}, skipped`); continue; }
      const fv = fairValue(ladder, m.resolutionDate, events, cfg.model);
      await consider(m, fv.cents, `model: ${fv.why}`);
    }
  }
  const viewed = Object.entries(views).filter(([id, v]) => !id.startsWith("_") && !covered.has(id) && Number.isInteger(v?.fairCents));
  if (viewed.length && !stop) console.log(`## Your views (config/views.json)`);
  for (const [id, v] of viewed) {
    if (stop) break;
    const m = markets.get(id);
    if (!m) { console.log(`  ${id}: not found on chain, skipped`); continue; }
    if (!tradeable(m)) { console.log(`  ${id}: trading ${m.trading?.status ?? "?"}, skipped`); continue; }
    if (v.fairCents < 1 || v.fairCents > 99) { console.log(`  ${id}: fairCents must be 1-99, skipped`); continue; }
    await consider(m, v.fairCents, `view: ${v.note ?? "your fair value"}`);
  }
  const skipped = all.filter((m) => tradeable(m) && !covered.has(m.id) && !viewed.some(([id]) => id === m.id)).length;
  console.log(`\n${skipped} other open market(s) have no model or view and were not traded. npm run markets lists them.`);
} catch (e) {
  console.error(`Stopped: ${e.message.split("\n")[0]}`);
  process.exitCode = 1;
} finally {
  await smx.close();
}
