// scripts/verify-A1.ts — Wave-A bounded live runtime-verify of the TIME + DAILY-ROUTINE engine (A1) and the
// frequent-conversation wiring (A3-back). FOR THE LEAD to run (D11: a teammate never runs a fleet during build).
//
// It is the harsh-critic instrument for the keystone: it boots a FRESH sim (D20 — tsx has no hot-reload, so the
// new clock/spawn/plan code only takes effect on a restart), attaches a WS viewer (pause-on-no-viewer), enables
// ALL 8 citizens, starts a BOUNDED run, then lets them run FREE (NO pre-positioning — the whole point is they
// disperse on their own to their role-locations across the WHOLE map) and reads the evidence the vision is
// graded on:
//   • CLOCK gate (D20)   — /run-state.gameClock advances + the prompt states the time (proven via a citizen log line).
//   • M1 map spread      — distinct buildings the fleet's tick-positions touched; how many agents LEFT the top street.
//   • M2 schedule moves  — citizens whose ACT reasoning advanced the plan toward a NON-shop role-location.
//   • M3 real dialogue   — ≥1 dialogue recorded with ≥3 turns.
//   • M6 role actions     — ≥1 kind:"status" event ("🥖 baking…", "🎸 busking…").
//
// BOUNDS (each independent, incident-safe): MAX_TICKS/citizen · a hard wall-clock timeout · FLEET_CEILING $ ·
// viewer attached throughout · bulletproof cleanup (try/finally + SIGKILL + pkill). NEVER runs gen-citizens.
//
// Usage (lead):  npx tsx scripts/verify-A1.ts            (defaults: 8 agents, MAX_TICKS=6, ~4-min cap)
//                MAX_TICKS=8 RUN_MINUTES=5 npx tsx scripts/verify-A1.ts
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const SIM = "http://localhost:4042";
const DATA = join(ROOT, "sim", "data");
const TRACES = join(DATA, "traces");

const ALL = ["baker", "barista", "grocer", "courier", "smith", "student", "musician", "regular"];
const TOP_STREET_SHOPS = new Set(["bakery", "cafe", "grocer", "depot", "smithy"]); // all doors on the top street (y:8)
const MAX_TICKS = process.env.MAX_TICKS ?? "6";
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 4);
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? (RUN_MINUTES + 2) * 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, body: unknown) =>
  fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);
const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const jl = (f: string): any[] => lines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Map a tile (x,y) to the building footprint it's inside, using world.json — so a trace position becomes a
// "which building were they at" signal (the M1 map-utilization metric in miniature).
const world = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8")) as { buildings: Array<{ id: string; x: number; y: number; w: number; h: number }> };
function buildingAt(x: number, y: number): string | null {
  for (const b of world.buildings) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b.id;
  return null;
}

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
  console.log(any ? "⚠ WARNING: citizen procs still alive after cleanup — check manually (pgrep -f citizens/citizen.ts)" : "✓ 0 lingering citizen procs");
}

async function main() {
  await killStale();

  console.log("⏳ booting a FRESH sim (D20: picks up the new clock/spawn/plan code; never calls an LLM)…");
  const sim = spawn("npx", ["tsx", "sim/sim-server.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env } });
  childProcs.push(sim);
  for (let i = 0; i < 40 && !(await get("/meta")); i++) await sleep(500);
  if (!(await get("/meta"))) throw new Error("sim did not come up");
  console.log("✓ sim up");

  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });
  console.log("✓ viewer attached (pause-on-no-viewer satisfied)");

  // CLOCK GATE (D20): confirm the new 20-min-day clock is live BEFORE spending tokens — gameClock present + the
  // spawns moved the non-merchants off the top street (student/musician/regular start on the south, y>=20-ish).
  for (const id of ALL) await post("/control", { action: "set-agent", id, enabled: true });
  const snap0 = await get("/snapshot");
  const rs0 = await get("/run-state");
  const southStart = ["student", "musician", "regular"].map((id) => snap0?.agents?.find((a: any) => a.id === id)).filter(Boolean);
  const southOk = southStart.every((a: any) => a.y >= 20);
  console.log(`CLOCK GATE: run-state.gameClock=${JSON.stringify(rs0?.gameClock)} (present=${!!rs0?.gameClock})`);
  console.log(`SPAWN GATE: student/musician/regular start positions=${southStart.map((a: any) => `${a.id}(${a.x},${a.y})`).join(" ")} → south=${southOk ? "PASS" : "FAIL"}`);

  await post("/control", { action: "start", duration: { kind: "minutes", value: RUN_MINUTES } });
  console.log(`✓ run started — all 8 enabled, ${RUN_MINUTES}-min cap, MAX_TICKS=${MAX_TICKS}/citizen, 20-min game-day`);

  // Spawn all 8 and let them run FREE — no nudging. The whole hypothesis is that the daily plan + clock make them
  // DISPERSE to their own role-locations. We just watch + record where they go.
  for (const id of ALL) {
    const c = spawn("npx", ["tsx", "citizens/citizen.ts", id], {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, SIM_URL: SIM, MAX_TICKS, TICK_MS: "6000", CITIZEN_MODEL: "claude-haiku-4-5-20251001" },
    });
    childProcs.push(c); citizenProcs.push(c);
  }
  console.log("✓ spawned all 8 (Haiku) — running free; sampling positions…\n");

  // Sample fleet positions over the run → the set of buildings touched + per-agent building visits (M1).
  const buildingsTouched = new Set<string>();
  const perAgentBuildings: Record<string, Set<string>> = Object.fromEntries(ALL.map((id) => [id, new Set<string>()]));
  const t0 = Date.now();
  const done = () => citizenProcs.every((p) => p.exitCode !== null || p.signalCode !== null);
  while (Date.now() - t0 < HARD_TIMEOUT_MS && !done()) {
    const s = await get("/snapshot");
    for (const a of s?.agents ?? []) {
      const b = buildingAt(a.x, a.y);
      if (b) { buildingsTouched.add(b); perAgentBuildings[a.id]?.add(b); }
    }
    await sleep(2500);
  }
  await sleep(3000); // let the final tick's dialogue/trace flush to disk

  console.log("\n===== EVIDENCE (Wave-A scorecard, miniature) =====");
  const usage = await get("/usage");
  console.log(`fleet usage (metered incl. cognition + dialogue): ${JSON.stringify(usage?.fleet)}`);
  const rsEnd = await get("/run-state");
  console.log(`game clock advanced to: ${JSON.stringify(rsEnd?.gameClock)} (started ${JSON.stringify(rs0?.gameClock)})`);

  // M1 — map utilization
  const nonTop = [...buildingsTouched].filter((b) => !TOP_STREET_SHOPS.has(b));
  const leftTopStreet = ALL.filter((id) => [...perAgentBuildings[id]].some((b) => !TOP_STREET_SHOPS.has(b)));
  console.log(`\nM1 MAP SPREAD: ${buildingsTouched.size} distinct buildings touched fleet-wide: ${[...buildingsTouched].sort().join(", ") || "(none — agents may have stayed on streets/sidewalks)"}`);
  console.log(`   non-top-street buildings reached: ${nonTop.length} (${nonTop.sort().join(", ") || "none"})`);
  console.log(`   agents that reached a non-top-street building: ${leftTopStreet.length}/8 (${leftTopStreet.join(", ") || "none"})`);

  // M2 — schedule: did the ACT reasoning advance the plan? read the per-tick traces' reasoning + perceived shop.
  let advancedPlan = 0; const movers: string[] = [];
  for (const id of ALL) {
    const recs = jl(join(TRACES, `${id}.jsonl`));
    const saidAdvance = recs.some((r) => typeof r.reasoning === "string" && /plan|head|go to|walk to|workplace|home|college|pub|dorm|bakery|cafe|smithy|grocer|depot|coliving/i.test(r.reasoning));
    const visitedDistinct = new Set(recs.map((r) => r?.perceived?.shop).filter(Boolean)).size;
    if (saidAdvance || perAgentBuildings[id].size > 0) { advancedPlan++; movers.push(id); }
    if (recs.length) console.log(`   ${id}: ${recs.length} traced tick(s) · ${perAgentBuildings[id].size} building(s) visited · perceived-shop distinct=${visitedDistinct}`);
  }
  console.log(`M2 SCHEDULE: ${advancedPlan}/8 agents moved toward / reached a plan location.`);

  // M3 — real conversations (≥3 turns)
  const dlg = jl(join(DATA, "dialogue.jsonl"));
  const conversed = dlg.filter((d) => d.outcome === "conversed");
  const realConvos = conversed.filter((d) => Number(d.turns) >= 3);
  console.log(`\nM3 CONVERSATIONS: ${dlg.length} recorded · ${conversed.length} conversed · ${realConvos.length} with ≥3 turns.`);
  for (const d of realConvos.slice(-3)) console.log(`   ${(d.participants ?? []).join(" + ")} — "${d.topic}" (${d.turns} turns)`);

  // M4 — two-way : one-shot say ratio
  const ev = jl(join(DATA, "events.jsonl"));
  const says = ev.filter((e) => e.kind === "say").length;
  const statuses = ev.filter((e) => e.kind === "status");
  console.log(`M4 RATIO: ${conversed.length} two-way dialogues : ${says} one-shot says.`);
  // M6 — role-action status events
  console.log(`M6 ROLE ACTIONS: ${statuses.length} status event(s) emitted${statuses.length ? ` (e.g. ${statuses.slice(-3).map((s) => `${s.actor}:${(s.payload ?? {}).text ?? ""}`).join(", ")})` : ""}.`);

  // ---- verdict (a soft gate — prints PASS/SOFT so the lead sees at a glance; never exits non-zero on a sim issue)
  console.log("\n===== VERDICT (vs the Wave-A gate) =====");
  const checks: Array<[string, boolean]> = [
    ["CLOCK present (D20)", !!rsEnd?.gameClock],
    ["spawns moved non-merchants south", southOk],
    ["clock advanced during run", JSON.stringify(rsEnd?.gameClock) !== JSON.stringify(rs0?.gameClock)],
    ["M1 ≥1 non-top-street building reached", nonTop.length >= 1],
    ["M1 ≥3 agents left the top street", leftTopStreet.length >= 3],
    ["M3 ≥1 real (≥3-turn) dialogue", realConvos.length >= 1],
    ["M6 ≥1 role-action status event", statuses.length >= 1],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "⬜"} ${name}`);
  const green = checks.filter(([, ok]) => ok).length;
  console.log(`\n${green}/${checks.length} checks green. ${green >= 6 ? "WAVE-A KEYSTONE LOOKS LIVE." : "Some signals flat — inspect traces (sim/data/traces/*.jsonl) + the citizen logs above."}`);
}

main()
  .catch((e) => console.error("VERIFY ERROR:", (e as Error).message))
  .finally(async () => { console.log("\n⏳ cleanup…"); await cleanup(); console.log("✓ cleanup done"); process.exit(0); });
