import { createPublicClient, http, formatUnits, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Shared helpers for the Tillwick treasury tooling.
export const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (6 decimals)
export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

const HERE = dirname(fileURLToPath(import.meta.url)); // repo root

export type Citizen = { id: string; address: Address; privateKey: `0x${string}` };

export function loadCitizens(): Citizen[] {
  const p = join(HERE, "citizens.local.json");
  if (!existsSync(p)) throw new Error(`No citizens yet — run \`npm run gen-citizens\` first (${p}).`);
  return JSON.parse(readFileSync(p, "utf8")) as Citizen[];
}

// Treasury key: TREASURY_PRIVATE_KEY env (a funded testnet wallet; never commit it).
export function treasuryKey(): `0x${string}` {
  if (process.env.TREASURY_PRIVATE_KEY) return process.env.TREASURY_PRIVATE_KEY as `0x${string}`;
  throw new Error("No treasury key. Set TREASURY_PRIVATE_KEY in .env (your funded wallet).");
}

export function treasuryAccount() {
  return privateKeyToAccount(treasuryKey());
}

export async function usdc(addr: Address): Promise<number> {
  const raw = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
  return Number(formatUnits(raw, 6));
}
