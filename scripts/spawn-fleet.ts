// scripts/spawn-fleet.ts — a HEADLESS, BOUNDED fleet supervisor, fired by the sim's POST /control "start".
//
// The GUI ⚙ control panel's Start button flips the sim's RUN-STATE (runState.start(d)) but the citizen
// "brains" are EXTERNAL processes — without something to spawn them, Start moved nothing. live-demo.ts used
// to be the only launcher (and it ALSO calls /control start). This is the trimmed, headless variant the sim
// itself fires: it does NOT touch run-state (the operator already started the run) — it reads GET /run-state
// for the ENABLED roster + the active duration, spawns one Haiku citizen per enabled id (teeing each one's
// stdout/stderr to sim/data/agents/<id>.log, exactly as live-demo does), then SELF-MANAGES off run-state:
// it polls GET /run-state and the moment the run goes stopped / terminally-paused (or the duration elapses)
// it SIGKILLs every citizen it spawned and exits. No PID tracking needed in the sim.
//
// SAFETY (INC-2026-06-18 was a citizen-fleet token-drain): the run is bounded by the REQUIRED duration as a
// HARD cap, the sim's $5 fleet ceiling + pause-on-no-viewer governor still apply, MAX_TICKS caps each citizen,
// and there is NO unbounded loop. A double-spawn guard (pgrep) refuses to stack a second fleet. NEVER
// regenerates wallets (no gen-citizens). Auth comes from the environment (citizens/auth.ts).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureShops } from "../shops/ensure-shops.js"; // T0-weave S5

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const LOG_DIR = join(ROOT, "sim", "data", "agents"); // #17: the observer's tail-f reads <id>.log — the supervisor owns it
const SIM = process.env.SIM_URL ?? "http://localhost:4042";
const TICK_MS = Number(process.env.TICK_MS ?? 7000);
const POLL_MS = 3000; // how often we re-check run-state to decide whether to tear the fleet down
const HARD_CAP_MS = Number(process.env.SPAWN_FLEET_HARD_CAP_MS ?? 60 * 60_000); // absolute backstop (1h) even if run-state never reports stopped

type Roster = Array<{ id: string; enabled: boolean; model: string }>;
type RunStateSnap = {
  status?: "running" | "paused" | "stopped";
  reason?: string | null;
  duration?: { kind: string; value: number | null } | null;
  remainingMs?: number | null;
  roster?: Roster;
};

const get = (p: string): Promise<RunStateSnap | null> =>
  fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Derive a per-citizen MAX_TICKS from the active duration so each brain self-terminates near the run's end
// even if it outlives the run-state poll (belt-and-braces with the SIGKILL teardown). For minutes durations,
// ticks ≈ minutes*60 / (TICK_MS/1000), plus a small margin. For game-days / forever we fall back to a generous
// (but still finite) cap — the run-state teardown is the real stop in those cases.
function deriveMaxTicks(rs: RunStateSnap): number {
  const d = rs.duration;
  if (d && d.kind === "minutes" && typeof d.value === "number") {
    return Math.max(1, Math.ceil((d.value * 60_000) / TICK_MS) + 2);
  }
  if (d && d.kind === "game-days" && typeof d.value === "number") {
    // game-days runs are governed by the sim clock; cap each citizen generously but finitely.
    return Math.max(1, Math.ceil((d.value * 1440 * 60_000) / TICK_MS));
  }
  return Number(process.env.SPAWN_FLEET_FOREVER_MAX_TICKS ?? 500); // "forever" — finite backstop; real stop is run-state
}

const citizens: ChildProcess[] = [];
function killAll() {
  for (const c of citizens) { try { c.kill("SIGKILL"); } catch { /* */ } }
  try { spawn("pkill", ["-9", "-f", "citizens/citizen.ts"]); } catch { /* */ }
}

async function main() {
  // DOUBLE-SPAWN GUARD — never stack a second fleet on top of a live one (protects the budget).
  // Our own children are spawned AFTER this check, so this only sees a PRE-EXISTING fleet.
  try {
    const running = execFileSync("pgrep", ["-f", "citizens/citizen.ts"], { encoding: "utf8" }).trim();
    if (running) {
      console.log(`[spawn-fleet] a citizen fleet is ALREADY running (pids: ${running.split("\n").join(",")}) — refusing to stack a second. Exiting.`);
      process.exit(0);
    }
  } catch { /* pgrep exits non-zero when nothing matches → no fleet → proceed */ }

  const rs = await get("/run-state");
  if (!rs) { console.error("[spawn-fleet] ✗ sim not reachable on /run-state — aborting (no fleet spawned)."); process.exit(1); }
  if (rs.status !== "running") {
    console.log(`[spawn-fleet] run-state is '${rs.status}' (not running) — nothing to spawn. Exiting.`);
    process.exit(0);
  }
  const enabled = (rs.roster ?? []).filter((e) => e.enabled);
  if (enabled.length === 0) { console.log("[spawn-fleet] no enabled citizens in the roster — nothing to spawn. Exiting."); process.exit(0); }

  // T0-weave S5: GUI-started runs had NO sellers listening — every buy was impossible. ensureShops is
  // idempotent (port-probe): a hand-run `npm run shops` is detected and respected, none started twice.
  try {
    const shops = await ensureShops();
    console.log(`[spawn-fleet] shops: ${JSON.stringify(shops)}`);
  } catch (err) {
    console.error(`[spawn-fleet] ensureShops failed (buys will fail gracefully): ${(err as Error).message}`);
  }

  const maxTicks = deriveMaxTicks(rs);
  console.log(`[spawn-fleet] starting ${enabled.length} citizen(s): ${enabled.map((e) => e.id).join(", ")} · MAX_TICKS=${maxTicks}/citizen · TICK_MS=${TICK_MS} · duration=${JSON.stringify(rs.duration)}`);

  mkdirSync(LOG_DIR, { recursive: true });
  for (const e of enabled) {
    // #17: TEE pretty stdout/stderr to sim/data/agents/<id>.log so the observer's `tail -f <id>.log` streams
    // live (citizen.ts only writes <id>.jsonl; the supervisor owns <id>.log). Mirrors live-demo.ts exactly.
    const out = createWriteStream(join(LOG_DIR, `${e.id}.log`), { flags: "a" });
    out.write(`\n=== ${e.id} started ${new Date().toISOString()} (spawn-fleet / GUI start) ===\n`);
    const c = spawn("npx", ["tsx", "citizens/citizen.ts", e.id], {
      cwd: ROOT,
      env: {
        ...process.env,
        SIM_URL: SIM,
        MAX_TICKS: String(maxTicks),
        TICK_MS: String(TICK_MS),
        CITIZEN_MODEL: e.model || "claude-haiku-4-5-20251001",
      },
    });
    c.stdout?.on("data", (d) => { out.write(d); process.stdout.write(`[${e.id}] ${d}`); });
    c.stderr?.on("data", (d) => { out.write(d); process.stderr.write(`[${e.id}!] ${d}`); });
    citizens.push(c);
    await sleep(6000); // T0-spine §6: 6s stagger de-syncs the first-tick cold-start herd on the shared Haiku pool (was 900ms → 8 simultaneous first ticks)
  }
  console.log(`[spawn-fleet] ✓ spawned ${citizens.length} Haiku citizen(s). Self-managing off GET /run-state.`);

  // SELF-MANAGE off run-state: exit + tear the fleet down the instant the run is no longer runnable
  // (stopped, or paused for a TERMINAL reason), the duration has elapsed, or all citizens have exited.
  const t0 = Date.now();
  const allExited = () => citizens.every((c) => c.exitCode !== null || c.signalCode !== null);
  for (;;) {
    await sleep(POLL_MS);
    if (allExited()) { console.log("[spawn-fleet] all citizens have exited (MAX_TICKS reached) — done."); break; }
    if (Date.now() - t0 >= HARD_CAP_MS) { console.log("[spawn-fleet] absolute hard cap reached — tearing down."); break; }
    const s = await get("/run-state");
    if (!s) continue; // a transient sim blip — keep the bounded children running; next poll re-checks
    if (s.status === "stopped") { console.log(`[spawn-fleet] run-state 'stopped' (${s.reason}) — tearing the fleet down.`); break; }
    // A run ends at the duration limit via runState → 'stopped', so 'stopped' is the primary signal. We do NOT
    // tear down on a transient pause (no-viewer / operator pause) — that's resumable; killing the brains would
    // make resume re-spawn nothing. The sim freezes the world + zero burn while paused (citizens gate on it).
    if (typeof s.remainingMs === "number" && s.remainingMs <= 0 && s.duration?.kind !== "forever") {
      console.log("[spawn-fleet] duration remainingMs<=0 — tearing the fleet down.");
      break;
    }
  }
}

main()
  .catch((e) => console.error("[spawn-fleet] ERROR:", (e as Error).message))
  .finally(async () => {
    killAll();
    await sleep(600);
    console.log("[spawn-fleet] ✓ fleet stopped, 0 lingering.");
    process.exit(0);
  });
