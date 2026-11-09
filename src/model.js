// Fair value for one ladder rung: P(at least `needed` qualifying events by the deadline).
// Known scheduled flights are Bernoulli trials with a slip model; unannounced flights are a Poisson background.
import { countDone, upcoming, usable } from "./feed.js";

const DAY = 86_400_000;

/** P(a scheduled flight with this NET has flown by deadline T). */
export function pFlownBy(netMs, T, now, m) {
  const net = Math.max(netMs, now); // a NET in the past with no liftoff recorded has slipped to "now"
  if (T < net) return 0;
  return m.pScheduledFlies * (m.pOnNet + (1 - m.pOnNet) * (1 - Math.exp(-(T - net) / (m.slipDaysMean * DAY))));
}

/** Distribution of a Poisson(mu) plus independent Bernoulli(p_i) trials; returns P(N >= k). */
export function pAtLeast(k, mu, ps) {
  if (k <= 0) return 1;
  let dist = Array.from({ length: k }, (_, i) => Math.exp(-mu) * mu ** i / [...Array(i).keys()].reduce((f, j) => f * (j + 1), 1));
  for (const p of ps) {
    const next = Array(k).fill(0);
    for (let i = 0; i < k; i++) { next[i] += dist[i] * (1 - p); if (i + 1 < k) next[i + 1] += dist[i] * p; }
    dist = next;
  }
  return Math.max(0, 1 - dist.reduce((a, b) => a + b, 0));
}

const matches = (e, f) => (!f.site || e.site === f.site) && (!f.plans || (e.plans ?? []).includes(f.plans));

/** Fair YES price in cents for a rung with deadline `deadlineIso`, plus the reasoning. */
export function fairValue(ladder, deadlineIso, allEvents, model, now = new Date()) {
  const events = usable(allEvents, now);
  const T = Date.parse(deadlineIso), t0 = now.getTime();
  const done = countDone(events, ladder.count, new Date(Math.min(t0, T))); // events after the deadline never count
  const need = ladder.needed - done;
  const [lo, hi] = model.clampCents;
  if (need <= 0) return { cents: hi, p: 1, done, need: 0, why: `already happened ${done} time(s); priced at ${hi}c to leave room for resolution checks` };
  if (T <= t0) return { cents: lo, p: 0, done, need, why: "deadline passed without enough events" };
  const attempts = upcoming(events, now).filter((e) => matches(e, ladder.attemptFilter ?? {}));
  const ps = attempts.map((e) => pFlownBy(Date.parse(e.eventTime), T, t0, model) * ladder.pSuccessPerAttempt);
  const mu = ladder.backgroundAttemptsPerDay * ((T - t0) / DAY) * ladder.pSuccessPerAttempt;
  const p = pAtLeast(need, mu, ps);
  const cents = Math.min(hi, Math.max(lo, Math.round(p * 100)));
  const why = `${done} done, ${need} needed; ${attempts.length} scheduled attempt(s) [${attempts.map((e, i) => `F${e.flight} NET ${e.eventTime.slice(0, 10)} p=${ps[i].toFixed(2)}`).join(", ")}], background mu=${mu.toFixed(2)}`;
  return { cents, p, done, need, why };
}
