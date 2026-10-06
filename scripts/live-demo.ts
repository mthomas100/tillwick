// scripts/live-demo.ts — a BOUNDED, GOVERNED live run on the ALREADY-RUNNING sim (:4042).
// Attaches a viewer (satisfies pause-on-no-viewer), enables the 5 funded merchants, starts a bounded
// run, spawns the citizens (Haiku), streams usage, then cleans up the CITIZENS — leaving the sim UP so
// the operator can keep watching the final state at http://localhost:4042/?art=limezu.
// Safe by construction: duration cap + MAX_TICKS + the W0 fleet ceiling; never an unbounded loop.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
// #17: the observer's tail-f reads sim/data/agents/<id>.log — the SUPERVISOR must tee each citizen's pretty
// stdout there (citizen.ts only writes <id>.jsonl via auditWrite; the supervisor owns <id>.log, like run-all.ts).
const LOG_DIR = join(ROOT, "sim", "data", "agents");
const SIM = "http://localhost:4042";
const ALL = ["baker", "barista", "grocer", "courier", "smith", "student", "musician", "regular"];
// DEMO_AGENTS="baker,barista,grocer" runs a SUBSET (fewer agents = less shared-pool throttle + more ticks each
// in the window — see ledger D18). Default = the 5 funded merchants. Everyone not in the list is disabled.
const MERCHANTS = (process.env.DEMO_AGENTS ?? "baker,barista,grocer,courier,smith").split(",").map((s) => s.trim()).filter(Boolean);
const OFF = ALL.filter((id) => !MERCHANTS.includes(id));
const DURATION_MIN = Number(process.env.DEMO_MIN ?? 3);
const MAX_TICKS = Number(process.env.DEMO_MAX_TICKS ?? 6);
const HARD_TIMEOUT_MS = DURATION_MIN * 60_000 + 30_000;

const post = (p: string, b: unknown) =>
  fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const citizens: ChildProcess[] = [];
let ws: WebSocket | null = null;
async function cleanup() {
  try { ws?.close(); } catch { /* */ }
  for (const c of citizens) { try { c.kill("SIGKILL"); } catch { /* */ } }
  spawn("pkill", ["-9", "-f", "citizens/citizen.ts"]);
  await sleep(800);
}

async function main() {
  if (!(await get("/meta"))) { console.error("✗ sim not up on :4042 — boot it first: npm run sim"); process.exit(1); }
  console.log("✓ sim up on :4042");

  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });
  console.log("✓ viewer attached (pause-on-no-viewer satisfied)");

  for (const id of OFF) await post("/control", { action: "set-agent", id, enabled: false });
  for (const id of MERCHANTS) await post("/control", { action: "set-agent", id, enabled: true });
  await post("/control", { action: "start", duration: { kind: "minutes", value: DURATION_MIN } });
  console.log(`✓ run started — ${MERCHANTS.length} merchants enabled · ${DURATION_MIN}-min cap · MAX_TICKS=${MAX_TICKS}/citizen · fleet ceiling $5`);

  mkdirSync(LOG_DIR, { recursive: true }); // #17: ensure sim/data/agents/ exists so the tee (and the observer's tail) work on a cold demo
  for (const id of MERCHANTS) {
    // #17: TEE the citizen's pretty stdout/stderr to sim/data/agents/<id>.log (so `tail -f <id>.log` — the
    // observer's LEFT pane — streams live) AND to the demo's own stdout. Mirrors run-all.ts:54-67 exactly; the
    // old `stdio:"inherit"` sent output ONLY to the demo's combined stdout, leaving <id>.log empty (musician.log
    // was 0 bytes). Default stdio (pipes) so child.stdout/stderr are readable here.
    const out = createWriteStream(join(LOG_DIR, `${id}.log`), { flags: "a" });
    out.write(`\n=== ${id} started ${new Date().toISOString()} (live-demo) ===\n`);
    const c = spawn("npx", ["tsx", "citizens/citizen.ts", id], {
      cwd: ROOT,
      env: { ...process.env, SIM_URL: SIM, MAX_TICKS: String(MAX_TICKS), TICK_MS: "7000", CITIZEN_MODEL: "claude-haiku-4-5-20251001" },
    });
    c.stdout?.on("data", (d) => { out.write(d); process.stdout.write(`[${id}] ${d}`); });
    c.stderr?.on("data", (d) => { out.write(d); process.stderr.write(`[${id}!] ${d}`); });
    citizens.push(c);
    await sleep(900); // stagger spawns — gentle on the shared pool
  }
  console.log(`\n✓ spawned ${MERCHANTS.length} Haiku citizens. WATCH LIVE: http://localhost:4042/?art=limezu\n`);

  const t0 = Date.now();
  const done = () => citizens.every((c) => c.exitCode !== null || c.signalCode !== null);
  while (Date.now() - t0 < HARD_TIMEOUT_MS && !done()) {
    const u = await get("/usage");
    if (u?.fleet) process.stdout.write(`\r  fleet: ${u.fleet.ticks} ticks · $${(u.fleet.apiEquivUsd ?? 0).toFixed(3)} API-equiv (ceiling $${u.ceilingUsd ?? 5})    `);
    await sleep(3000);
  }
  console.log("\n\n✓ run complete (duration elapsed or all citizens reached MAX_TICKS)");
  const u = await get("/usage");
  console.log("FLEET USAGE:", JSON.stringify(u?.fleet));
}

main()
  .catch((e) => console.error("DEMO ERROR:", (e as Error).message))
  .finally(async () => {
    console.log("⏳ cleanup: stopping citizens (LEAVING the sim up for viewing)…");
    await cleanup();
    await post("/control", { action: "stop" });
    console.log("✓ citizens stopped, 0 lingering; sim still serving :4042 — keep watching the town.");
    process.exit(0);
  });
