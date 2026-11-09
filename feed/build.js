// Builds feed/out/starship.json: the document a paid x402 endpoint (e.g. GET /agent/feed/starship) would serve.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEvents } from "../src/feed.js";

const events = loadEvents().sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
const doc = {
  feed: "smx-starship-signals",
  schemaVersion: 1,
  schema: "https://smx.space/feed/starship-event.schema.json",
  generatedAt: new Date().toISOString(),
  count: events.length,
  notice: "Testnet. Information only, not advice. Every event links its source; 'unverified' events need a human check. Not affiliated with or endorsed by SpaceX or the FAA.",
  events,
};
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL("./out/starship.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
console.log(`feed/out/starship.json: ${events.length} events`);
