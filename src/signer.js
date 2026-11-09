// Signs and sends the unsigned steps smx-mcp returns, from YOUR wallet only (Base Sepolia, chain 84532).
// Optional Base Builder Code: an ERC-8021 suffix appended to every transaction's calldata for attribution.
import { createPublicClient, createWalletClient, concat, getAddress, http, parseAbi, parseEther, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { Attribution } from "ox/erc8021";

const RPC = process.env.SMX_RPC ?? "https://sepolia.base.org";
const factoryAbi = parseAbi(["function access(address) view returns (uint8)", "function accountOf(address) view returns (address)", "function marketRegistry() view returns (address)"]);
const regAbi = parseAbi(["function marketRegistry() view returns (address)"]);

// Guardrails: the signer only sends known SMX calls to known SMX contracts, within a gas budget.
const FACTORIES = ["0x409cFe0157aE3Ec2C321F97422a4bFc539c4b28a", "0x1F138B48CF923097e7166c01Ee97719a0CfEE214"].map((a) => getAddress(a));
const USDC = getAddress("0x5882C96199e09771b01cFDC51eDea1D5814fc4E1");
const sel = (sig) => toFunctionSelector(sig).toLowerCase();
const ALLOWED = {
  factory: [sel("requestAccess()"), sel("deployAccount()")],
  usdc: [sel("mint(address,uint256)"), sel("approve(address,uint256)")],
  account: [sel("deposit(uint256)"), sel("submitOrder(address,uint8,uint64,uint128)"), sel("cancelOrder(address,uint256)")],
  book: [sel("clearBatch()"), sel("claim(uint256,uint256)")],
};
const GAS_BUDGET_WEI = parseEther(process.env.SMX_MAX_GAS_ETH ?? "0.0002"); // per run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ERC-8021 suffix for a Base Builder Code (e.g. bc_xxxxxxxx), or null when no code is set. */
export const builderSuffix = (code) => (code ? Attribution.toDataSuffix({ codes: [code] }) : null);

/** Appends the suffix to calldata. Solidity ignores trailing calldata, so the call itself is unchanged. */
export const withSuffix = (data, suffix) => (suffix ? concat([data, suffix]) : data);

export function makeSigner(privateKey, builderCode) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? "")) throw new Error("SMX_AGENT_KEY must be a 0x-prefixed 32-byte hex key (use a throwaway testnet wallet).");
  const account = privateKeyToAccount(privateKey);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const suffix = builderSuffix(builderCode);
  let spentWei = 0n;
  const regs = new Set();
  const regsReady = Promise.all(FACTORIES.map((f) => pub.readContract({ address: f, abi: factoryAbi, functionName: "marketRegistry" }).then((r) => regs.add(getAddress(r)))));

  /** Throws unless `to` is an SMX contract we expect and the call is on its allowlist. */
  async function check(step) {
    await regsReady;
    const to = getAddress(step.to), fn = step.data.slice(0, 10).toLowerCase();
    let kind = null;
    if (FACTORIES.includes(to)) kind = "factory";
    else if (to === USDC) kind = "usdc";
    else {
      const own = await Promise.all(FACTORIES.map((f) => pub.readContract({ address: f, abi: factoryAbi, functionName: "accountOf", args: [account.address] })));
      if (own.map((a) => getAddress(a)).includes(to)) kind = "account";
      else {
        const reg = await pub.readContract({ address: to, abi: regAbi, functionName: "marketRegistry" }).catch(() => null);
        if (reg && regs.has(getAddress(reg))) kind = "book";
      }
    }
    if (!kind) throw new Error(`${step.step}: refusing to send to ${to}, not a known SMX contract`);
    if (!ALLOWED[kind].includes(fn)) throw new Error(`${step.step}: refusing call ${fn} on ${kind} ${to}, not an allowed SMX function`);
    if (kind === "usdc" && fn === sel("approve(address,uint256)")) {
      const spender = getAddress(`0x${step.data.slice(34, 74)}`);
      const own = await Promise.all(FACTORIES.map((f) => pub.readContract({ address: f, abi: factoryAbi, functionName: "accountOf", args: [account.address] })));
      if (!own.map((a) => getAddress(a)).includes(spender)) throw new Error(`${step.step}: refusing USDC approval to ${spender}, not your own SMX Account`);
    }
    if (BigInt(step.value ?? 0) !== 0n) throw new Error(`${step.step}: refusing to send ETH value`);
  }

  async function runStep(step, log) {
    if (step.offchain) {
      // Testnet access approval: POST, then wait until Factory.access(wallet) == 2.
      const r = await fetch(step.url, { method: step.method, headers: { "content-type": "application/json" }, body: JSON.stringify(step.body) });
      log({ kind: "step", step: step.step, http: r.status });
      return { offchain: true };
    }
    if (step.chainId !== baseSepolia.id) throw new Error(`refusing chain ${step.chainId}`);
    await check(step);
    if (spentWei >= GAS_BUDGET_WEI) throw new Error(`gas budget for this run used up (${GAS_BUDGET_WEI} wei, set SMX_MAX_GAS_ETH to change)`);
    const data = withSuffix(step.data, suffix);
    // Simulate first: a revert costs nothing here, and the error selector says why.
    try { await pub.call({ account, to: step.to, data, value: BigInt(step.value ?? 0) }); }
    catch (e) { const sel = /0x[0-9a-f]{8}/i.exec(`${e.cause?.data ?? ""} ${e.message}`)?.[0]; throw new Error(`${step.step} would revert${sel ? ` (${sel})` : ""}; not sent`); }
    const hash = await wallet.sendTransaction({ to: step.to, data, value: BigInt(step.value ?? 0), gas: step.gas ? BigInt(step.gas) : undefined });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    spentWei += rc.gasUsed * rc.effectiveGasPrice;
    log({ kind: "step", step: step.step, tx: hash, status: rc.status, block: Number(rc.blockNumber) });
    if (rc.status !== "success") throw new Error(`${step.step} reverted: ${hash}`);
    return { hash, to: step.to };
  }

  async function waitForAccess(factory, tries = 20) {
    for (let i = 0; i < tries; i++) {
      if (Number(await pub.readContract({ address: factory, abi: factoryAbi, functionName: "access", args: [account.address] })) === 2) return true;
      await sleep(3000);
    }
    return false;
  }

  return { address: account.address, suffix, runStep, waitForAccess };
}
