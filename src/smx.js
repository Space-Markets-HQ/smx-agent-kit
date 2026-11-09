// Talks to SMX through the published smx-mcp server over stdio, exactly as any outside agent would.
// smx-mcp never signs or holds keys; it returns unsigned transactions.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const SERVER = join(dirname(require.resolve("smx-mcp/package.json")), "dist", "index.js");

export async function connectSmx() {
  // Pass only what smx-mcp needs. Never the wallet key or anything else in .env.
  const ALLOW = /^(PATH|HOME|TMPDIR|TEMP|TMP|LANG|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_USE_ENV_PROXY|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|SMX_RPC|SMX_ORIGIN|SMX_API|SMX_INDEXER|SMX_HTTP_TIMEOUT_MS)$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ALLOW.test(k)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" });
  const client = new Client({ name: "smx-agent-kit", version: "0.1.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.map((c) => c.text).join(" ") ?? "";
    if (r.isError) throw Object.assign(new Error(`${name}: ${text}`), { data: r.structuredContent });
    return r.structuredContent ?? JSON.parse(text);
  };
  return {
    // include_unlisted: launch books with no orders yet are hidden from the default listing ("never-traded").
    listMarkets: async () => (await call("smx_list_markets", { include_unlisted: true })).markets,
    buildOrder: (a) => call("smx_build_order", a),
    close: () => client.close(),
  };
}
