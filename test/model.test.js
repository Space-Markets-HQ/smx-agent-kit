import { test } from "node:test";
import assert from "node:assert/strict";
import { pAtLeast, pFlownBy, fairValue } from "../src/model.js";
import { validateEvent, loadEvents } from "../src/feed.js";
import { decide, capsAllow, minShares } from "../src/decide.js";
import { builderSuffix, withSuffix } from "../src/signer.js";
import cfg from "../config/ladders.json" with { type: "json" };

const NOW = new Date("2026-11-08T13:00:00Z");
const ev = (o) => ({ observedAt: "2026-11-01T00:00:00Z", vehicle: "starship", summary: "x", source: { url: "https://example.com", publisher: "x" }, confidence: "reported", ...o });
const ladder = (name) => cfg.ladders.find((l) => l.name.includes(name));

test("pAtLeast matches Poisson and Bernoulli edge cases", () => {
  assert.equal(pAtLeast(0, 5, []), 1);
  assert.ok(Math.abs(pAtLeast(1, 1, []) - (1 - Math.exp(-1))) < 1e-12);
  assert.ok(Math.abs(pAtLeast(1, 0, [0.5, 0.5]) - 0.75) < 1e-12);
  assert.ok(Math.abs(pAtLeast(2, 0, [0.5, 0.5]) - 0.25) < 1e-12);
});

test("slip model: zero before NET, rises after, capped by pScheduledFlies", () => {
  const m = cfg.model, net = Date.parse("2026-11-13T00:00:00Z"), now = NOW.getTime();
  assert.equal(pFlownBy(net, net - 1, now, m), 0);
  const a = pFlownBy(net, net + 5 * 864e5, now, m), b = pFlownBy(net, net + 60 * 864e5, now, m);
  assert.ok(a > 0 && b > a && b <= m.pScheduledFlies);
});

test("ladder rungs are monotonic in the deadline", () => {
  const events = loadEvents();
  for (const l of cfg.ladders) {
    const ps = ["2026-12-31", "2027-01-31", "2027-03-31", "2027-06-30"].map((d) => fairValue(l, `${d}T04:59:59Z`, events, cfg.model, NOW).p);
    for (let i = 1; i < ps.length; i++) assert.ok(ps[i] >= ps[i - 1], `${l.name} not monotonic`);
  }
});

test("completed events price at the cap; unverified events are ignored", () => {
  const two = [ev({ id: "a-1", type: "liftoff", flight: "15", eventTime: "2026-11-13T12:00:00Z" }), ev({ id: "a-2", type: "liftoff", flight: "16", eventTime: "2026-12-01T12:00:00Z" })];
  const after = new Date("2026-12-02T00:00:00Z");
  assert.equal(fairValue(ladder("twice"), "2026-12-31T04:59:59Z", two, cfg.model, after).cents, cfg.model.clampCents[1]);
  const fake = [ev({ id: "c-1", type: "ship-catch", flight: "15", eventTime: "2026-11-05T00:00:00Z", confidence: "unverified" })];
  assert.ok(fairValue(ladder("catch"), "2027-01-31T04:59:59Z", fake, cfg.model, NOW).cents < 90);
});

test("a liftoff before the count window does not count", () => {
  const old = [ev({ id: "o-1", type: "liftoff", flight: "14", eventTime: "2026-09-28T00:00:00Z" })];
  assert.equal(fairValue(ladder("twice"), "2026-12-31T04:59:59Z", old, cfg.model, NOW).done, 0);
});

test("seed feed is valid and every event has a source", () => {
  const events = loadEvents();
  assert.ok(events.length >= 1);
  for (const e of events) assert.deepEqual(validateEvent(e), []);
  assert.ok(validateEvent({ ...events[0], source: { url: "nope" } }).includes("source"));
});

test("decide: buys YES under fair, NO over fair, holds otherwise", () => {
  const t = cfg.trading;
  assert.equal(decide({ fairCents: 40, bestBidBps: 2000, bestAskBps: 3000 }, t).order.outcome, "Yes");
  const no = decide({ fairCents: 20, bestBidBps: 4800, bestAskBps: 5200 }, t).order;
  assert.deepEqual([no.outcome, no.limitPrice, no.qty], ["No", 52, 2]);
  assert.equal(decide({ fairCents: 50, bestBidBps: 4800, bestAskBps: 5200 }, t).order, null);
  assert.equal(decide({ fairCents: 50, bestBidBps: null, bestAskBps: null }, t).order, null);
  const tiny = decide({ fairCents: 20, bestBidBps: null, bestAskBps: 900 }, t);
  assert.equal(tiny.order, null); // 12 shares needed at 9c, above the 10-share cap
  assert.match(tiny.reason, /cap/);
});

test("minimum order size and caps", () => {
  assert.equal(minShares(52), 2);
  assert.equal(minShares(9), 12);
  const t = { ...cfg.trading, maxOrdersPerDay: 5 }, at = "2026-11-08T01:00:00Z";
  const j = [{ kind: "order-sent", marketId: "A", at }];
  assert.match(capsAllow(j, "A", t, NOW), /per-market/);
  assert.equal(capsAllow(j, "B", t, NOW), null);
  const five = Array.from({ length: 5 }, (_, i) => ({ kind: "order-sent", marketId: `M${i}`, at }));
  assert.match(capsAllow(five, "Z", t, NOW), /daily cap/);
});

test("Builder Code suffix matches the Base docs example and is appended", () => {
  const s = builderSuffix("bc_b7k3p9da");
  assert.equal(s, "0x62635f62376b33703964610b0080218021802180218021802180218021");
  assert.equal(withSuffix("0xabcd", s), "0xabcd" + s.slice(2));
  assert.equal(withSuffix("0xabcd", null), "0xabcd");
});

test("seed feed: Flight 15 counts as a scheduled ship-catch attempt today", () => {
  const f = fairValue(ladder("catch"), "2027-04-01T03:59:59Z", loadEvents(), cfg.model, new Date("2026-11-08T13:00:00Z"));
  assert.match(f.why, /1 scheduled attempt/);
});

test("events after a market's deadline never count toward it", () => {
  const late = [ev({ id: "l-1", type: "ship-catch", flight: "16", eventTime: "2027-02-15T00:00:00Z" })];
  const after = new Date("2027-03-01T00:00:00Z");
  const f = fairValue(ladder("catch"), "2027-02-01T04:59:59Z", late, cfg.model, after);
  assert.equal(f.done, 0);
  assert.equal(f.cents, cfg.model.clampCents[0]);
});
