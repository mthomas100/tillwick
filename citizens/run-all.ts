import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCitizens } from "../lib.js";

// The supervisor: one OS process per citizen (crash + wallet isolation), staggered so all 5 don't hit
// the shared rate limit in the same instant. Each child's stdout/stderr is tee'd to sim/data/agents/<id>.log
// (the human-readable audit) AND to this console with an [id] prefix. A crashed child is restarted alone.
//   run: tsx citizens/run-all.ts        (start the sim + shops first)

const HERE = dirname(fileURLToPath(import.meta.url)); // citizens/
const ROOT = dirname(HERE); // repo root
const LOG_DIR = join(ROOT, "sim", "data", "agents");
mkdirSync(LOG_DIR, { recursive: true });

// Single-instance guard: refuse to start a SECOND supervisor. Two supervisors run every citizen twice
// on the same wallet — racing nonces + double-burning the shared rate limit (it once silently doubled
// spend and saturated the daily cap). A stale lock from a dead supervisor is detected + overwritten.
const LOCK = join(ROOT, "sim", "data", "run-all.lock");
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but unsignalable = alive; ESRCH = dead
  }
};
if (existsSync(LOCK)) {
  const prev = Number(readFileSync(LOCK, "utf8").trim());
  if (prev && pidAlive(prev)) {
    console.error(`[run-all] a citizens supervisor is already running (PID ${prev}); refusing to start a duplicate. Stop it first:  kill ${prev}`);
    process.exit(1);
  }
}
writeFileSync(LOCK, String(process.pid));
const releaseLock = () => {
  try {
    if (existsSync(LOCK) && Number(readFileSync(LOCK, "utf8").trim()) === process.pid) rmSync(LOCK);
  } catch {
    /* ignore */
  }
};
process.on("exit", releaseLock);

const ids = loadCitizens().map((c) => c.id);
const STAGGER_MS = Number(process.env.STAGGER_MS ?? 3000);
const RESTART_MS = Number(process.env.RESTART_MS ?? 5000);
const MAX_RESPAWNS = Number(process.env.MAX_RESPAWNS ?? 5); // cap crash-respawns per citizen — no amplification
const respawns: Record<string, number> = {};

function launch(id: string, delayMs: number): void {
  setTimeout(() => {
    const out = createWriteStream(join(LOG_DIR, `${id}.log`), { flags: "a" });
    out.write(`\n=== ${id} started ${new Date().toISOString()} ===\n`);
    const child = spawn("tsx", ["citizens/citizen.ts", id], {
      cwd: ROOT,
      env: { ...process.env }, // inherits the auth env (ANTHROPIC_API_KEY, or the subscription opt-in)
    });
    child.stdout.on("data", (d) => {
      out.write(d);
      process.stdout.write(`[${id}] ${d}`);
    });
    child.stderr.on("data", (d) => {
      out.write(d);
      process.stderr.write(`[${id}!] ${d}`);
    });
    child.on("exit", (code, signal) => {
      // Clean / intentional exit (code 0: circuit-breaker halt, MAX_TICKS/RUNTIME, operator) ⇒ do NOT respawn.
      if (code === 0) {
        const m = `[run-all] ${id} exited cleanly (code 0) — not respawning (intentional halt).`;
        out.write(`\n${m}\n`);
        console.log(m);
        return;
      }
      // Killed by a signal (supervisor shutdown / manual kill) ⇒ do NOT respawn.
      if (signal) {
        out.write(`\n[run-all] ${id} killed by ${signal} — not respawning.\n`);
        return;
      }
      // Unexpected crash ⇒ respawn with BACKOFF + a hard cap (the incident's "auto-restart amplifies" guard).
      respawns[id] = (respawns[id] ?? 0) + 1;
      if (respawns[id] > MAX_RESPAWNS) {
        const m = `[run-all] ${id} crashed ${respawns[id]}× — giving up (exceeds MAX_RESPAWNS=${MAX_RESPAWNS}).`;
        out.write(`\n${m}\n`);
        console.error(m);
        return;
      }
      const backoff = Math.min(60_000, RESTART_MS * 2 ** (respawns[id] - 1));
      const m = `[run-all] ${id} crashed (code ${code}); respawn ${respawns[id]}/${MAX_RESPAWNS} in ${backoff}ms`;
      out.write(`\n${m}\n`);
      console.error(m);
      launch(id, backoff);
    });
  }, delayMs);
}

ids.forEach((id, i) => launch(id, i * STAGGER_MS));
console.log(`[run-all] launching ${ids.length} citizens (${STAGGER_MS}ms stagger): ${ids.join(", ")}`);
console.log(`[run-all] logs → sim/data/agents/<id>.log · transcripts → <id>.jsonl`);

process.on("SIGINT", () => {
  releaseLock();
  console.log("\n[run-all] shutting down.");
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
