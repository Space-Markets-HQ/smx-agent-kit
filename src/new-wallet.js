#!/usr/bin/env node
// Creates a throwaway Base Sepolia wallet in .env (testnet only; never put real funds on it).
import { existsSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const envUrl = new URL("../.env", import.meta.url);
if (existsSync(envUrl)) { console.log(".env already exists; not overwriting."); process.exit(1); }
const key = generatePrivateKey();
const { address } = privateKeyToAccount(key);
writeFileSync(envUrl, `# Throwaway Base Sepolia testnet wallet. Never fund with real assets.\nSMX_AGENT_KEY=${key}\nSMX_AGENT_WALLET=${address}\n# SMX_BUILDER_CODE=bc_xxxxxxxx\n`, { mode: 0o600 });
console.log(`New testnet wallet ${address} written to .env`);
console.log("It needs a little Base Sepolia ETH for gas (from a Base Sepolia faucet). Test USDC is minted by the agent itself.");
