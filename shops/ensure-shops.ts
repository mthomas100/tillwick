// ensure-shops — IDEMPOTENT x402 seller bring-up (town-alive audit A2 blocker 3): a fleet run spawned by
// the GUI Start button had NO shops listening (spawn-fleet.ts spawns citizens only; `npm run shops` was a
// separate manual step) — so even a willing, funded buyer's `buy` would have died on ECONNREFUSED :4031-35.
//
// This probes each registered shop port (GET /shop, short timeout) and spawns ONLY the missing ones,
// detached, teeing output to sim/data/agents/shop-<id>.log (the observer's tail-f convention). Safe to call
// every run: an already-listening shop is left alone (no double-bind, no stacked processes — the probe IS
// the double-spawn guard, unlike pgrep this also respects a shop run by hand in a terminal). Never throws;
// returns what it found/started so the caller can log it.
//
// Wiring (hook-spec to main): spawn-fleet.ts calls `await ensureShops()` right before spawning citizens.
// Also runnable standalone: `npx tsx shops/ensure-shops.ts`.

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SHOP_PORT } from "./registry.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // shops/
const ROOT = dirname(HERE); // repo root
const LOG_DIR = join(ROOT, "sim", "data", "agents");
const PROBE_TIMEOUT_MS = 1200;

export type EnsureShopsResult = {
  alreadyUp: string[]; // shops that answered the probe
  started: string[]; // shops we spawned this call
  failed: string[]; // shops that neither answered nor spawned cleanly
};

/** Is a shop already answering on its port? (GET /shop is the free, unpaywalled catalog route.) */
async function isUp(port: number): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`http://localhost:${port}/shop`, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Bring up any shop not already listening. Idempotent + best-effort; never throws. */
export async function ensureShops(): Promise<EnsureShopsResult> {
  const result: EnsureShopsResult = { alreadyUp: [], started: [], failed: [] };
  mkdirSync(LOG_DIR, { recursive: true });
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  for (const [shop, port] of Object.entries(SHOP_PORT)) {
    try {
      if (await isUp(port)) {
        result.alreadyUp.push(shop);
        continue;
      }
      const out = createWriteStream(join(LOG_DIR, `shop-${shop}.log`), { flags: "a" });
      out.write(`\n=== ${shop} shop started ${new Date().toISOString()} (ensure-shops) ===\n`);
      const child = spawn(tsx, ["shops/shop-server.ts"], {
        cwd: ROOT,
        env: { ...process.env, SHOP: shop, PORT: String(port) },
        detached: true, // survives the caller (spawn-fleet) exiting — shops are cheap, harmless listeners
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (d) => out.write(d));
      child.stderr?.on("data", (d) => out.write(d));
      child.unref();
      result.started.push(shop);
    } catch {
      result.failed.push(shop);
    }
  }
  return result;
}

// ---- CLI -------------------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const r = await ensureShops();
    console.log(`[ensure-shops] up: ${r.alreadyUp.join(", ") || "(none)"} · started: ${r.started.join(", ") || "(none)"} · failed: ${r.failed.join(", ") || "(none)"}`);
    if (r.started.length) {
      // give the fresh listeners a beat, then re-probe so the operator sees a truthful final state.
      await new Promise((res) => setTimeout(res, 1500));
      const verify: string[] = [];
      for (const [shop, port] of Object.entries(SHOP_PORT)) if (await isUp(port)) verify.push(shop);
      console.log(`[ensure-shops] listening now: ${verify.join(", ") || "(none)"} of ${Object.keys(SHOP_PORT).length}`);
    }
  })();
}
