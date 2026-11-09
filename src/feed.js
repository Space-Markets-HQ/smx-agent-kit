// Starship signal feed: load, validate and query the append-only events file.
import { readFileSync, existsSync } from "node:fs";

const TYPES = new Set(["liftoff", "ship-catch", "booster-catch", "scheduled", "scrub", "licence", "hazard-notice", "static-fire", "rollout", "source-changed", "note"]);
const CONF = new Set(["official", "reported", "unverified"]);
const iso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

/** Returns a list of problems; empty means the event is valid. */
export function validateEvent(e) {
  const p = [];
  if (!e || typeof e !== "object") return ["not an object"];
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(e.id ?? "")) p.push("id");
  if (!iso(e.observedAt)) p.push("observedAt");
  if (!TYPES.has(e.type)) p.push("type");
  if (e.vehicle !== "starship") p.push("vehicle");
  if (typeof e.summary !== "string" || !e.summary || e.summary.length > 280) p.push("summary");
  if (!e.source || !/^https?:\/\//.test(e.source.url ?? "") || !e.source.publisher) p.push("source");
  if (!CONF.has(e.confidence)) p.push("confidence");
  if (e.eventTime !== undefined && !iso(e.eventTime)) p.push("eventTime");
  if (["liftoff", "ship-catch", "booster-catch", "scheduled"].includes(e.type) && !iso(e.eventTime)) p.push("eventTime required for " + e.type);
  return p;
}

export function loadEvents(path = new URL("../feed/events.jsonl", import.meta.url)) {
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const events = rows.map((l, i) => {
    let e;
    try { e = JSON.parse(l); } catch { throw new Error(`events.jsonl line ${i + 1}: not JSON`); }
    const bad = validateEvent(e);
    if (bad.length) throw new Error(`events.jsonl line ${i + 1} (${e.id ?? "?"}): bad ${bad.join(", ")}`);
    return e;
  });
  const ids = new Set();
  for (const e of events) { if (ids.has(e.id)) throw new Error(`duplicate event id ${e.id}`); ids.add(e.id); }
  // Drop events that a later event supersedes.
  const superseded = new Set(events.map((e) => e.supersedes).filter(Boolean));
  return events.filter((e) => !superseded.has(e.id));
}

/** Events the reference agent trusts: not unverified, and observed by `now`. */
export function usable(events, now = new Date()) {
  const future = events.filter((e) => Date.parse(e.observedAt) > now.getTime());
  if (future.length) console.warn(`feed: ignoring ${future.length} event(s) with observedAt in the future: ${future.map((e) => e.id).join(", ")}`);
  return events.filter((e) => e.confidence !== "unverified" && Date.parse(e.observedAt) <= now.getTime());
}

/** Completed events of a type in [since, now], optionally only at one site. */
export function countDone(events, { type, since, site }, now = new Date()) {
  return events.filter((e) => e.type === type && (!site || e.site === site) &&
    Date.parse(e.eventTime) >= Date.parse(since) && Date.parse(e.eventTime) <= now.getTime()).length;
}

/** Latest scheduled attempt per flight, still in the future or recently past (not yet flown). */
export function upcoming(events, now = new Date()) {
  const flown = new Set(events.filter((e) => e.type === "liftoff").map((e) => e.flight));
  const byFlight = new Map();
  for (const e of events.filter((x) => x.type === "scheduled" && !flown.has(x.flight))) {
    const prev = byFlight.get(e.flight);
    if (!prev || Date.parse(e.observedAt) > Date.parse(prev.observedAt)) byFlight.set(e.flight, e);
  }
  return [...byFlight.values()].sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime));
}
