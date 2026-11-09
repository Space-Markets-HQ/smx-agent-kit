// Deployment-aware order builder. SMX has two deployments on Base Sepolia, each with its own Factory:
// an SMX Account only trades books in its own Factory's registry (else NotMarket(), 0xc4bbea69).
// smx-mcp 0.2.1 always uses the legacy Factory, so this builds the same unsigned steps against the
// Factory that matches each book's registry. Order math and ABIs are reused from smx-mcp.
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { accountAbi, factoryAbi, GAS, orderMath, usdcAbi } from "smx-mcp/dist/order-build.js";

const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.SMX_RPC ?? "https://sepolia.base.org") });
const USDC = "0x5882C96199e09771b01cFDC51eDea1D5814fc4E1"; // SMX test USDC (both deployments)
export const FACTORIES = [
  "0x409cFe0157aE3Ec2C321F97422a4bFc539c4b28a", // legacy deployment
  "0x1F138B48CF923097e7166c01Ee97719a0CfEE214", // launch deployment (day-one Starship books)
];
const regAbi = parseAbi(["function marketRegistry() view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
let registryToFactory = null;

/** The Factory whose registry lists this book (checked on chain, not assumed). */
export async function factoryForBook(book) {
  if (!registryToFactory) {
    registryToFactory = new Map();
    for (const f of FACTORIES) registryToFactory.set(getAddress(await pub.readContract({ address: f, abi: regAbi, functionName: "marketRegistry" })), f);
  }
  const reg = getAddress(await pub.readContract({ address: book, abi: regAbi, functionName: "marketRegistry" }));
  const f = registryToFactory.get(reg);
  if (!f) throw new Error(`no known Factory for registry ${reg}`);
  return f;
}

const tx = (step, to, abi, functionName, args, gas) => ({ step, to: getAddress(to), data: encodeFunctionData({ abi, functionName, args }), value: "0x0", chainId: 84532, gas: `0x${gas.toString(16)}` });

/**
 * Next unsigned steps for one order. Returns { steps, blocked }:
 * blocked is set when the wallet still needs admission to this Factory (access must be 2).
 */
export async function buildSteps({ book, wallet, outcome, action, qty, limitPrice }) {
  const factory = await factoryForBook(book);
  const [access, acct] = await Promise.all([
    pub.readContract({ address: factory, abi: factoryAbi, functionName: "access", args: [wallet] }),
    pub.readContract({ address: factory, abi: factoryAbi, functionName: "accountOf", args: [wallet] }),
  ]);
  const account = acct && acct !== ZERO ? getAddress(acct) : null;
  if (!account) {
    if (Number(access) === 0) return { factory, steps: [tx("requestAccess", factory, factoryAbi, "requestAccess", [], GAS.requestAccess)], blocked: null };
    if (Number(access) !== 2) {
      // Testnet auto-approve. Name the Factory: the service checks the legacy one otherwise.
      const r = await fetch("https://www.smx.space/app/__approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: wallet, chainId: 84532, factory }) });
      for (let i = 0; i < 30; i++) {
        if (Number(await pub.readContract({ address: factory, abi: factoryAbi, functionName: "access", args: [wallet] })) === 2) break;
        await new Promise((s) => setTimeout(s, 3000));
      }
      if (Number(await pub.readContract({ address: factory, abi: factoryAbi, functionName: "access", args: [wallet] })) !== 2)
        return { factory, steps: [], blocked: `auto-approve did not admit the wallet on Factory ${factory} (HTTP ${r.status}: ${(await r.text()).slice(0, 120)})` };
    }
    return { factory, steps: [tx("deployAccount", factory, factoryAbi, "deployAccount", [], GAS.deployAccount)], blocked: null };
  }
  const m = orderMath(outcome, action, qty, limitPrice);
  const [avail, reserved, walletUsdc, allowance] = await Promise.all([
    pub.readContract({ address: account, abi: accountAbi, functionName: "availableBalance" }),
    pub.readContract({ address: account, abi: accountAbi, functionName: "reserved" }),
    pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [wallet] }),
    pub.readContract({ address: USDC, abi: usdcAbi, functionName: "allowance", args: [wallet, account] }),
  ]);
  const free = avail > reserved ? avail - reserved : 0n;
  const need = m.collateralMicro + m.maxFeeMicro;
  const short = need > free ? need - free : 0n;
  const steps = [];
  if (short > 0n) {
    if (walletUsdc < short) steps.push(tx("mintTestUsdc", USDC, usdcAbi, "mint", [wallet, short - walletUsdc], GAS.mint));
    if (allowance < short) steps.push(tx("approve", USDC, usdcAbi, "approve", [account, short], GAS.approve));
    steps.push(tx("deposit", account, accountAbi, "deposit", [short], GAS.deposit));
  }
  steps.push(tx("submitOrder", account, accountAbi, "submitOrder", [getAddress(book), m.userSide, m.userPrice, BigInt(qty)], GAS.submitOrder));
  return { factory, account, steps, blocked: null };
}
