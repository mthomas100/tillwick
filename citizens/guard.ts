import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Address } from "viem";
import { loadCitizens, usdc } from "../lib.js";
import { sumToday, has } from "../economy/ledger.js";

// The purchase-decision GUARD (Seam E, a spend-cap control
// flow). Judgment lives in the LLM (evaluate_purchase); the CONSTRAINT lives here, in code, and can
// VETO a buy. Wired two ways in citizen.ts: (1) inside evaluate_purchase so the model sees mayBuy, and
// (2) as options.canUseTool on the `buy` tool so the cap holds even if the model skips evaluate_purchase.

const HERE = dirname(fileURLToPath(import.meta.url)); // citizens/
const ROOT = dirname(HERE); // repo root

type Caps = { reserveUSDC: number; maxPurchaseUSDC: number; dailyCapUSDC: number };
type Config = { enabled: boolean; dryRun: boolean; default: Caps; citizens: Record<string, Caps> };

const CONFIG_FILE = join(ROOT, "economy.config.json");

// Read config FRESH on every call so cap/kill-switch edits hot-reload without a citizen restart.
// (Previously this JSON was static-imported once at module load, which made economy.config.json edits
// require restarting all 5 citizens to take effect — a footgun during a live demo.) The file is tiny
// and canBuy already does a network balance read, so a sync re-read here is negligible.
function loadConfig(): Config {
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
}

let addrCache: Record<string, Address> | null = null;
function addressOf(id: string): Address {
  if (!addrCache) {
    addrCache = {};
    for (const c of loadCitizens()) addrCache[c.id] = c.address;
  }
  const a = addrCache[id];
  if (!a) throw new Error(`no wallet for citizen "${id}"`);
  return a;
}

export type GuardResult = {
  ok: boolean;
  balance: number;
  why?: string;
  checks?: Record<string, boolean>;
};

// Can citizen `id` buy `item` at `price` USDC on `turn`? Reads LIVE balance (one viem readContract) +
// in-memory ledger sums. Runs in the citizen process — never touches the sim's tick loop.
export async function canBuy(
  id: string,
  item: string,
  price: number,
  turn: number,
): Promise<GuardResult> {
  const cfg = loadConfig(); // fresh read each call — hot-reloadable caps/kill-switch
  if (!cfg.enabled) return { ok: false, balance: 0, why: "economy disabled (kill switch)" };
  if (cfg.dryRun) return { ok: false, balance: 0, why: "dry run — decision only, no settlement" };

  const caps = cfg.citizens[id] ?? cfg.default;
  let balance = 0;
  try {
    balance = await usdc(addressOf(id));
  } catch (e) {
    return { ok: false, balance: 0, why: `balance read failed: ${(e as Error).message}` };
  }

  const checks = {
    affordable: balance - price >= caps.reserveUSDC, // reserve floor — can't zero the wallet
    underCap: price <= caps.maxPurchaseUSDC, // per-purchase ceiling
    underDaily: sumToday(id) + price <= caps.dailyCapUSDC, // daily ceiling
    notDup: !has(`${id}|${item}|${turn}`), // idempotency (one buy of an item per turn)
  };
  const ok = Object.values(checks).every(Boolean);
  const why = ok
    ? undefined
    : !checks.affordable
      ? `would breach reserve (bal ${balance}, reserve ${caps.reserveUSDC})`
      : !checks.underCap
        ? `over per-purchase cap ($${price} > $${caps.maxPurchaseUSDC})`
        : !checks.underDaily
          ? `over daily cap (spent $${sumToday(id)} today)`
          : "duplicate buy this turn";
  return { ok, balance, why, checks };
}
