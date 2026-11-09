#!/usr/bin/env node
// Clears crossed batches on books we have orders in, then claims our fills. Both calls are
// permissionless on SMX; this just does what the keeper would. Base Sepolia only.
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { makeSigner } from "./signer.js";

const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.SMX_RPC ?? "https://sepolia.base.org") });
const ob = parseAbi([
  "function isCrossed() view returns (bool)", "function clearableAt() view returns (uint40)", "function batchNonce() view returns (uint256)",
  "function clearBatch()", "function fills(uint256 orderId, uint256 batchNonce) view returns (address trader, uint96 filledQty)",
  "function claim(uint256 orderId, uint256 batchNonce) returns (uint256 payout)",
]);
const signer = makeSigner(process.env.SMX_AGENT_KEY, process.env.SMX_BUILDER_CODE);
const log = (e) => console.log("  ", JSON.stringify(e));
const step = (name, to, functionName, args = []) => ({ step: name, to, data: encodeFunctionData({ abi: ob, functionName, args }), value: "0x0", chainId: 84532 });

const journalUrl = new URL("../data/journal.jsonl", import.meta.url);
const sent = (existsSync(journalUrl) ? readFileSync(journalUrl, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((j) => j.kind === "order-sent" && j.account);
const accounts = [...new Set(sent.map((j) => j.account))];
if (!accounts.length) console.log("Nothing to settle: no placed orders in data/journal.jsonl yet.");
for (const account of accounts) {
  const h = await fetch(`https://smx-indexer-preview.fly.dev/v1/accounts/${account}/history`).then((r) => r.json());
  const byBook = new Map();
  for (const o of h.orders ?? []) {
    const m = sent.find((j) => j.marketId === o.market && j.account === account);
    if (!m) continue;
    const book = (await (await fetch(`https://smx-indexer-preview.fly.dev/v1/markets`)).json()).markets.find((x) => x.id === o.market)?.book;
    if (book) byBook.set(book, [...(byBook.get(book) ?? []), { id: o.orderId, market: o.market }]);
  }
  for (const [book, orders] of byBook) {
    console.log(`${orders[0].market} (book ${book})`);
    const [crossed, at] = await Promise.all([pub.readContract({ address: book, abi: ob, functionName: "isCrossed" }), pub.readContract({ address: book, abi: ob, functionName: "clearableAt" })]);
    if (crossed && Number(at) <= Date.now() / 1000) {
      try { await signer.runStep(step("clearBatch", book, "clearBatch"), log); } catch (e) { console.log(`   clear skipped: ${e.message}`); }
    } else console.log(`   no batch due (crossed=${crossed})`);
    const nonce = Number(await pub.readContract({ address: book, abi: ob, functionName: "batchNonce" }));
    for (const o of orders) for (let n = 1; n <= nonce; n++) {
      const [, qty] = await pub.readContract({ address: book, abi: ob, functionName: "fills", args: [BigInt(o.id), BigInt(n)] });
      if (qty > 0n) { console.log(`   order ${o.id} filled ${qty} in batch ${n}; claiming`); await signer.runStep(step(`claim ${o.id}/${n}`, book, "claim", [BigInt(o.id), BigInt(n)]), log); }
    }
  }
}
