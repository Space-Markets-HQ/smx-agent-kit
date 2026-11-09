// Page watcher: hashes each source page's visible text. A change appends an 'unverified'
// source-changed event so a human can read the page and record what actually changed.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const { sources } = JSON.parse(readFileSync(new URL("./sources.json", import.meta.url), "utf8"));
const stateUrl = new URL("../data/watch-state.json", import.meta.url);
mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const state = existsSync(stateUrl) ? JSON.parse(readFileSync(stateUrl, "utf8")) : {};

const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

for (const s of sources) {
  try {
    const r = await fetch(s.url, { headers: { "user-agent": "smx-agent-kit feed watcher" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.log(`${s.id}: HTTP ${r.status}, skipped`); continue; }
    const hash = createHash("sha256").update(text(await r.text())).digest("hex");
    const prev = state[s.id]?.hash;
    const now = new Date().toISOString();
    if (prev && prev !== hash) {
      const ev = { id: `${s.id}-changed-${now.slice(0, 19).replace(/[:T]/g, "-").toLowerCase()}`, observedAt: now, type: "source-changed", vehicle: "starship",
        summary: `${s.publisher} page changed. Read it and record any real event.`, source: { url: s.url, publisher: s.publisher }, confidence: "unverified", addedBy: "watcher" };
      appendFileSync(new URL("./events.jsonl", import.meta.url), JSON.stringify(ev) + "\n");
      console.log(`${s.id}: CHANGED -> ${ev.id}`);
    } else console.log(`${s.id}: ${prev ? "no change" : "baseline saved"}`);
    state[s.id] = { hash, checkedAt: now };
  } catch (e) { console.log(`${s.id}: ${e.message}`); }
}
writeFileSync(stateUrl, JSON.stringify(state, null, 2) + "\n");
