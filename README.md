# smx-agent-kit

A reference trading agent and a Starship signal feed for **SMX** event markets. Fork it, point it at your own model, and trade the same books as everyone else.

**Testnet only: Base Sepolia (chain id 84532).** Test USDC has no monetary value. SMX is not available to US persons or in restricted jurisdictions. Not affiliated with or endorsed by SpaceX or the FAA. Information only, not advice.

## What it does

```
feed/events.jsonl ──► model.js ──► fair value per rung ──► decide.js ──► smx-mcp ──► your wallet signs ──► Base Sepolia
 (sourced Starship        (scheduled flights +           (trade only on clear     (unsigned txs)
  events)                  background rate)               edge, inside caps)
```

1. **Reads** every SMX book through [`smx-mcp`](https://www.npmjs.com/package/smx-mcp), the same MCP server any outside agent uses.
2. **Prices** each rung of the Starship ladders (two liftoffs, first Florida liftoff, first Ship catch) from the signal feed. Known flights count as attempts that may slip; unannounced flights are a background rate.
3. **Trades** only when the book is at least `edgeCents` away from fair value, at the minimum size, within hard caps.
4. **Builds** each order itself (`src/build.js`) against the Factory that matches the book's registry, and asks testnet auto-approve to admit the wallet on that Factory. smx-mcp is used for reads.
5. **Signs** with your own key. The signer only sends known SMX calls to SMX contracts (the two Factories, test USDC, your own Accounts, registry-listed books), never ETH value, and stops at a gas budget per run (`SMX_MAX_GAS_ETH`, default 0.0002). The smx-mcp subprocess never sees your key. SMX never signs and there is no relayer.

Dry run is the default. Nothing is signed unless you pass `--live`.

## Quick start

```bash
npm install
npm test                 # offline checks
npm run markets          # every tradeable market and its book
npm run agent            # dry run: prints fair values and the orders it would place
```

To trade on testnet:

```bash
npm run wallet:new       # writes a throwaway key to .env (git-ignored)
# send that address a little Base Sepolia ETH for gas from any Base Sepolia faucet
npm run agent:live       # requests access, deploys your Account, mints test USDC, places orders
```

A new wallet runs through `requestAccess`, testnet auto-approval, `deployAccount`, test USDC mint, approve and deposit before its first order. All of it is built locally and signed locally.

After an order crosses, `npm run settle` clears the batch if it is due and claims your fills. It does not do post-resolution settlement (`claimSettlement`); that comes when a market resolves.

Exit codes: `agent:live` exits 1 if an order fails, so schedulers see it.

## Caps (config/ladders.json)

| Setting | Default |
|---|---|
| `edgeCents` | 8 |
| `maxSharesPerOrder` | 10 |
| `maxOrdersPerDay` | 1 |
| `maxOrdersPerMarketPerDay` | 1 |

Orders are sized to the SMX minimum (shares × price ≥ 1 test USDC). Every decision and transaction is logged to `data/journal.jsonl`.

## Use it on any SMX market

The agent reads, builds, signs and settles on every SMX market, on both deployments. It only trades where it has a fair value:

- **Starship ladders:** priced by the built-in model from the Starship signal feed (below).
- **Any other market:** add your own view to `config/views.json`:

```json
{ "views": { "moon-race-us-china-test-v2": { "fairCents": 55, "note": "my view: US first" } } }
```

`npm run markets` lists every tradeable market with its current book. A market with no model and no view is never traded.

## The model is an example

The numbers under `model` and each ladder's `backgroundAttemptsPerDay` and `pSuccessPerAttempt` are **placeholder assumptions** that make the code run. They are not SMX's view. Replace them, or replace `src/model.js` with your own `fairValue(ladder, deadline, events, model)`.

## Starship signal feed

`feed/events.jsonl` is append-only. One line is one sourced fact (see `feed/schema.json`):

```json
{"id":"f15-scheduled-2026-11-13","observedAt":"2026-11-08T13:00:00Z","type":"scheduled","vehicle":"starship","flight":"15","site":"starbase","eventTime":"2026-11-13T00:00:00Z","plans":["ship-catch","booster-catch"],"summary":"…","source":{"url":"…","publisher":"Starlust","published":"2026-11-06"},"confidence":"reported"}
```

- **Types:** `liftoff`, `ship-catch`, `booster-catch`, `scheduled`, `scrub`, `licence`, `hazard-notice`, `static-fire`, `rollout`, `source-changed`, `note`.
- **Confidence:** `official` (operator or regulator), `reported` (named press), `unverified` (needs a human check; the agent ignores these).
- **Corrections** are new events with `supersedes`.
- `npm run feed:watch` hashes the pages in `feed/sources.json` (FAA Starship page, SpaceX updates, Cameron County closures). A change adds an `unverified` event telling a human to read the page.
- `npm run feed:build` writes `feed/out/starship.json`, the document an x402 paid endpoint would serve.

## Base Builder Codes

Set `SMX_BUILDER_CODE=bc_…` (from dashboard.base.org) and every transaction carries the ERC-8021 attribution suffix, built with `ox/erc8021`. Solidity ignores trailing calldata, so contract behaviour is unchanged. Check your first suffixed transaction on Basescan before relying on it.

## Layout

```
src/agent.js     main loop (dry run / --live)
src/model.js     fair value: Poisson background + scheduled attempts with slip
src/decide.js    edge check, sizing, caps
src/feed.js      load, validate and query the event feed
src/smx.js       smx-mcp client over stdio
src/signer.js    viem signer, Base Sepolia only, Builder Code suffix
feed/            schema, events, watcher, feed builder
config/          ladders, model assumptions, caps
```

Wrappers for agent frameworks (Coinbase AgentKit, Bankr, Olas, Virtuals) go in `wrappers/` and reuse `src/`.

## Licence

MIT, Space Markets, Inc. The licence covers this code, not SMX or SMI data, which come under the terms at smx.space.
