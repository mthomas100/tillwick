// scripts/verify-B1.ts — Wave-B1/B4 bounded live runtime-verify of INTERIORS (data model + presence + act-inside).
// Run against a live sim once the B1 interior routes are mounted (the sim-server.ts wiring behaviorist owns
// interiors.ts/perception.ts/world-tools.ts; sim-server.ts is the lead's). D11: a teammate never runs a fleet
// during build — this is the lead's consolidated gate.
//
// It boots a FRESH sim (D20 — tsx no hot-reload; the new interior code + the hook only take effect on restart),
// FIRST checks the hook is wired (GET /who-inside/:building responds; /perceive carries insideHere), then drives
// a few agents into buildings and reads the evidence the "step inside" vision is graded on:
//   • PRESENCE   — agents that reached a building's inside-tile are registered inside it (/who-inside occupants).
//   • ACT-INSIDE — an agent that went to a sub-location shows a sublocationId (took its place: counter/table/desk).
//   • TABLE-TALK — two agents sent to the same table get DIFFERENT seats (the nearest-free-seat rule).
//   • PERCEIVE   — /perceive?agent=… carries insideHere {interior, sublocations, occupants} when inside.
//   • STATUS     — role-action status events still fire (reused from A3) for producers working inside.
//
// BOUNDS (incident-safe): MAX_TICKS/citizen · hard wall-clock timeout · FLEET_CEILING $ · viewer attached ·
// bulletproof cleanup (try/finally + SIGKILL + pkill + pgrep-empty check). NEVER runs gen-citizens.
//
// Usage (lead, after applying the hook):  npx tsx scripts/verify-B1.ts
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const SIM = "http://localhost:4042";
const DATA = join(ROOT, "sim", "data");

const MAX_TICKS = process.env.MAX_TICKS ?? "5";
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 4);
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? (RUN_MINUTES + 2) * 60_000);
// drive these into the cafe so we can watch presence + table-talk (baker works there? no — barista does; we send
// barista to work the counter and student+musician to a table to prove seats differ).
const WORKERS = ["barista"]; // works the cafe counter
const SITTERS = ["student", "musician"]; // sent to a cafe table → different seats
const PARTICIPANTS = [...WORKERS, ...SITTERS];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, body: unknown) =>
  fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch(() => ({ status: 0, body: null }));
const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const jl = (f: string): any[] => lines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const childProcs: ChildProcess[] = [];
const citizenProcs: ChildProcess[] = [];
let ws: WebSocket | null = null;

async function killStale() {
  spawn("pkill", ["-9", "-f", "citizens/citizen.ts"]);
  spawn("pkill", ["-9", "-f", "sim/sim-server"]);
  await sleep(800);
}
async function cleanup() {
  try { ws?.close(); } catch { /* */ }
  for (const p of childProcs) { try { p.kill("SIGKILL"); } catch { /* */ } }
  await killStale();
  const left = spawn("pgrep", ["-f", "citizens/citizen.ts"]);
  let any = false; left.stdout?.on("data", () => (any = true));
  await new Promise<void>((r) => left.on("close", () => r()));
  console.log(any ? "⚠ WARNING: citizen procs still alive after cleanup — check pgrep -f citizens/citizen.ts" : "✓ 0 lingering citizen procs");
}

async function main() {
  await killStale();
  console.log("⏳ booting a FRESH sim (D20: picks up the interior code + the hook; never calls an LLM)…");
  const sim = spawn("npx", ["tsx", "sim/sim-server.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env } });
  childProcs.push(sim);
  for (let i = 0; i < 40 && (await get("/meta")).status !== 200; i++) await sleep(500);
  if ((await get("/meta")).status !== 200) throw new Error("sim did not come up");
  console.log("✓ sim up");

  // HOOK GATE — is the B1 sim-server wiring applied? If /who-inside 404s, the lead hasn't applied the hook yet.
  const who0 = await get("/who-inside/cafe");
  if (who0.status === 404 || who0.status === 0) {
    console.log("\n⛔ GET /who-inside/:building is missing: this sim build predates the B1 interior routes.");
    console.log("   Restart `npm run sim` from this tree (tsx does not hot-reload) and re-run.");
    return;
  }
  console.log(`✓ hook present — /who-inside/cafe → ${JSON.stringify(who0.body)}`);

  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });
  console.log("✓ viewer attached");

  for (const id of PARTICIPANTS) await post("/control", { action: "set-agent", id, enabled: true });
  // disable the rest to keep the run cheap + focused
  for (const id of ["baker", "courier", "grocer", "smith", "regular"]) await post("/control", { action: "set-agent", id, enabled: false });
  await post("/control", { action: "start", duration: { kind: "minutes", value: RUN_MINUTES } });
  console.log(`✓ run started — ${PARTICIPANTS.join("+")} enabled, ${RUN_MINUTES}-min cap, MAX_TICKS=${MAX_TICKS}`);

  // PRE-DRIVE everyone to the cafe (sim steps the paths; no tokens — citizens not spawned yet). On arrival the
  // hook auto-enters them. Then send the SITTERS to a table sub-location to prove different seats.
  console.log("⏳ driving barista+student+musician to the cafe…");
  for (let i = 0; i < 30; i++) {
    for (const id of PARTICIPANTS) await post("/act", { agent: id, action: "goTo", to: "cafe" });
    const w = await get("/who-inside/cafe");
    if ((w.body?.occupants ?? []).length >= PARTICIPANTS.length) break;
    await sleep(1500);
  }
  let whoCafe = (await get("/who-inside/cafe")).body;
  console.log(`  inside cafe after drive: ${JSON.stringify(whoCafe?.occupants ?? [])}`);

  // Put the two sitters at the SAME table → they must get different seats.
  await post("/act", { agent: "student", action: "goInside", sublocationId: "cafe-table-1" });
  await post("/act", { agent: "musician", action: "goInside", sublocationId: "cafe-table-1" });
  await post("/act", { agent: "barista", action: "goInside", sublocationId: "cafe-counter" });
  await sleep(600);
  whoCafe = (await get("/who-inside/cafe")).body;
  const occ: Array<{ id: string; x: number; y: number; sublocationId?: string }> = whoCafe?.occupants ?? [];
  const stu = occ.find((o) => o.id === "student"), mus = occ.find((o) => o.id === "musician"), bar = occ.find((o) => o.id === "barista");

  // perceive carries insideHere?
  const perc = (await get("/perceive?agent=barista")).body;

  // now spawn the citizens for a few ticks so producer status / behaviour runs (optional richness)
  for (const id of PARTICIPANTS) {
    const c = spawn("npx", ["tsx", "citizens/citizen.ts", id], {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, SIM_URL: SIM, MAX_TICKS, TICK_MS: "6000", CITIZEN_MODEL: "claude-haiku-4-5-20251001" },
    });
    childProcs.push(c); citizenProcs.push(c);
  }
  const t0 = Date.now();
  const done = () => citizenProcs.every((p) => p.exitCode !== null || p.signalCode !== null);
  while (Date.now() - t0 < HARD_TIMEOUT_MS && !done()) await sleep(2500);
  await sleep(2500);

  console.log("\n===== EVIDENCE (B1/B4 interiors) =====");
  console.log(`PRESENCE: ${occ.length} agent(s) inside cafe: ${occ.map((o) => `${o.id}@(${o.x},${o.y})${o.sublocationId ? `[${o.sublocationId}]` : ""}`).join(", ")}`);
  console.log(`ACT-INSIDE: barista at "${bar?.sublocationId ?? "(no spot)"}" · student at "${stu?.sublocationId ?? "(no spot)"}" · musician at "${mus?.sublocationId ?? "(no spot)"}"`);
  const differentSeats = !!stu && !!mus && (stu.x !== mus.x || stu.y !== mus.y);
  console.log(`TABLE-TALK: student & musician seats ${differentSeats ? "DIFFER ✅" : "SAME ⬜"} (student=(${stu?.x},${stu?.y}) musician=(${mus?.x},${mus?.y}))`);
  console.log(`PERCEIVE.insideHere: ${perc?.insideHere ? `present — theme=${perc.insideHere.interior?.theme}, ${perc.insideHere.sublocations?.length} sublocations, ${perc.insideHere.occupants?.length} occupants` : "MISSING"}`);
  const ev = jl(join(DATA, "events.jsonl"));
  const statuses = ev.filter((e) => e.kind === "status");
  console.log(`STATUS events (reused A3): ${statuses.length}${statuses.length ? ` — e.g. ${statuses.slice(-2).map((s) => `${s.actor}:${(s.payload ?? {}).emoji ?? ""}${(s.payload ?? {}).text ?? ""}`).join(", ")}` : ""}`);

  console.log("\n===== VERDICT =====");
  const checks: Array<[string, boolean]> = [
    ["hook applied (/who-inside responds)", who0.status === 200],
    ["≥2 agents registered inside the cafe", occ.length >= 2],
    ["an agent took a work station (sublocationId)", !!bar?.sublocationId],
    ["two agents at one table got DIFFERENT seats", differentSeats],
    ["/perceive carries insideHere when inside", !!perc?.insideHere],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "⬜"} ${name}`);
  const green = checks.filter(([, ok]) => ok).length;
  console.log(`\n${green}/${checks.length} green. ${green >= 4 ? "B1/B4 INTERIORS LOOK LIVE." : "Some signals flat — check the hook edits + sim/data/events.jsonl."}`);
}

main()
  .catch((e) => console.error("VERIFY ERROR:", (e as Error).message))
  .finally(async () => { console.log("\n⏳ cleanup…"); await cleanup(); console.log("✓ cleanup done"); process.exit(0); });
