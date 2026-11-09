// Pure trading decision: compare fair value with the visible book and pick at most one order.
// Book prices are YES-terms basis points (5000 = 50c). Orders are always buys, of YES or of NO.

const MIN_ORDER_CENTS = 100; // SMX minimum: shares x price >= 1 test USDC

/** Smallest whole number of shares that meets the 1 test USDC minimum at this price. */
export const minShares = (limitCents) => Math.ceil(MIN_ORDER_CENTS / limitCents);

export function decide({ fairCents, bestBidBps, bestAskBps }, t) {
  const ask = bestAskBps ? bestAskBps / 100 : null;
  const bid = bestBidBps ? bestBidBps / 100 : null;
  let order = null;
  if (ask !== null && ask <= fairCents - t.edgeCents)
    order = { outcome: "Yes", action: "buy", limitPrice: Math.round(ask), reason: `YES ask ${ask}c is at least ${t.edgeCents}c below fair ${fairCents}c` };
  else if (bid !== null && bid >= fairCents + t.edgeCents)
    order = { outcome: "No", action: "buy", limitPrice: Math.round(100 - bid), reason: `YES bid ${bid}c is at least ${t.edgeCents}c above fair ${fairCents}c, so NO is cheap at ${100 - bid}c` };
  if (!order) return { order: null, reason: `no edge: fair ${fairCents}c, bid ${bid ?? "none"}, ask ${ask ?? "none"}, edge ${t.edgeCents}c` };
  if (order.limitPrice < 1 || order.limitPrice > 99) return { order: null, reason: `limit ${order.limitPrice}c is off the 1-99c grid` };
  const qty = minShares(order.limitPrice);
  if (qty > t.maxSharesPerOrder) return { order: null, reason: `${qty} shares needed for the 1 USDC minimum at ${order.limitPrice}c, above the ${t.maxSharesPerOrder}-share cap` };
  return { order: { ...order, qty }, reason: order.reason };
}

/** Caps from the journal: max orders per UTC day overall and per market. */
export function capsAllow(journal, marketId, t, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const today = journal.filter((j) => j.kind === "order-sent" && j.at.slice(0, 10) === day);
  if (today.length >= t.maxOrdersPerDay) return `daily cap reached (${t.maxOrdersPerDay} orders)`;
  if (today.filter((j) => j.marketId === marketId).length >= t.maxOrdersPerMarketPerDay) return `per-market daily cap reached on ${marketId}`;
  return null;
}
