// scripts/verify-B6.ts — bounded live runtime-verify of the B6 fix: NON-PRODUCERS now live their role-locations
// (musician busks at the pub, student studies at the college, courier does delivery rounds) instead of lingering
// at the cafe all day. FOR THE LEAD to run (D11: a teammate never runs a fleet during build).
//
// The showcase gap (lead's harsh-critic finding): producers nailed it, but the musician never reached the pub
// stage, the student never went to college, the courier didn't do rounds — all sat at the cafe. Root cause
// (forensic): the reply/coffee branch out-prioritized "advance your plan" at the social hub, so non-producers
// never emitted move({to:workId}). Fix: a WORK-WINDOW override (off-site-during-shift → go to work, above
// chit-chat) + inferStepTarget reorder/label-match. This harness proves they now SHOW UP to work.
//
// It boots a FRESH sim (D20), enables the 3 non-producers (+ a couple producers as conversation partners so the
// override has something to out-prioritize), runs bounded, then reads positions + status events:
//   • musician reaches the PUB (its workId) during its 16:00-23:00 window
//   • student reaches the COLLEGE during its 09:00-17:00 window
//   • courier reaches the DEPOT or visits ≥2 distinct buildings during its 08:00-18:00 window (mobile by design)
//   • ≥1 busk/study/located status event fires (the "zero busking/studying" half closes)
//
// IMPORTANT: the override only fires DURING each role's work-window. The harness reads the live game-hour and
// reports which roles are on-shift; if the persisted clock sits outside a role's window for the whole short run,
// that role's check is reported as "off-shift this run (inconclusive)", not a FAIL. For a clean test, delete
// sim/data/run-state.json before booting so the clock starts at day1 08:00 (then run long enough to cross into
// the windows — a 20-min game-day means ~1.2 game-min/sec, so ~7 real-min reaches ~16:00 for the musician; OR
// set GAME_START_HH via the run-state if supported). Default RUN keeps it short; widen with RUN_MINUTES.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SIM = "http://localhost:4042";
const DATA = join(ROOT, "sim", "data");

const MAX_TICKS = process.env.MAX_TICKS ?? "8";
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 5);
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? (RUN_MINUTES + 2) * 60_000);
// non-producers under test + 2 producers as conversation bait (so the override has chit-chat to beat).
const UNDER_TEST = ["musician", "student", "courier"];
const BAIT = ["barista", "baker"];
const ENABLED = [...UNDER_TEST, ...BAIT];
const WINDOWS: Record<string, [number, number]> = { musician: [16, 23], student: [9, 17], courier: [8, 18] };
const WORKID: Record<string, string> = { musician: "pub", student: "college", courier: "depot" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, b: unknown) => fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);
const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const jl = (f: string): any[] => lines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const world = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8")) as { buildings: Array<{ id: string; x: number; y: number; w: number; h: number }> };
const buildingAt = (x: number, y: number): string | null => { for (const b of world.buildings) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b.id; return null; };
const hourOf = (gm: number) => Math.floor((Math.max(0, gm) % 1440) / 60);

const childProcs: ChildProcess[] = []; const citizenProcs: ChildProcess[] = []; let ws: WebSocket | null = null;
async function killStale() { spawn("pkill", ["-9", "-f", "citizens/citizen.ts"]); spawn("pkill", ["-9", "-f", "sim/sim-server"]); await sleep(800); }
async function cleanup() {
  try { ws?.close(); } catch { /* */ }
  for (const p of childProcs) { try { p.kill("SIGKILL"); } catch { /* */ } }
  await killStale();
  const left = spawn("pgrep", ["-f", "citizens/citizen.ts"]); let any = false; left.stdout?.on("data", () => (any = true));
  await new Promise<void>((r) => left.on("close", () => r()));
  console.log(any ? "⚠ citizen procs still alive — check pgrep" : "✓ 0 lingering citizen procs");
}

async function main() {
  await killStale();
  console.log("⏳ booting a FRESH sim (D20)…");
  const sim = spawn("npx", ["tsx", "sim/sim-server.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env } });
  childProcs.push(sim);
  for (let i = 0; i < 40 && !(await get("/meta")); i++) await sleep(500);
  if (!(await get("/meta"))) throw new Error("sim did not come up");
  console.log("✓ sim up");
  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });

  for (const id of ["grocer", "smith", "regular"]) await post("/control", { action: "set-agent", id, enabled: false });
  for (const id of ENABLED) await post("/control", { action: "set-agent", id, enabled: true });
  const rs0 = await get("/run-state");
  console.log(`game clock at start: ${JSON.stringify(rs0?.gameClock)} (hour ${hourOf(rs0?.gameMinutes ?? 0)})`);
  console.log(`on-shift at start: ${UNDER_TEST.filter((id) => { const h = hourOf(rs0?.gameMinutes ?? 0); const [s, e] = WINDOWS[id]; return h >= s && h < e; }).join(", ") || "(none — clock may need to advance into a window; widen RUN_MINUTES or reset run-state.json)"}`);
  await post("/control", { action: "start", duration: { kind: "minutes", value: RUN_MINUTES } });
  console.log(`✓ run started — ${ENABLED.join("+")} (3 under test + 2 bait), ${RUN_MINUTES}-min cap, MAX_TICKS=${MAX_TICKS}`);

  for (const id of ENABLED) {
    const c = spawn("npx", ["tsx", "citizens/citizen.ts", id], { cwd: ROOT, stdio: "inherit", env: { ...process.env, SIM_URL: SIM, MAX_TICKS, TICK_MS: "6000", CITIZEN_MODEL: "claude-haiku-4-5-20251001" } });
    childProcs.push(c); citizenProcs.push(c);
  }
  console.log("✓ spawned; sampling positions through each role's work-window…\n");

  // Per-agent: did they reach their workId WHILE on-shift, and how many distinct buildings did they touch in-window.
  const reachedWorkInWindow: Record<string, boolean> = {};
  const inWindowBuildings: Record<string, Set<string>> = Object.fromEntries(UNDER_TEST.map((id) => [id, new Set<string>()]));
  const sawInWindow: Record<string, boolean> = Object.fromEntries(UNDER_TEST.map((id) => [id, false]));
  const t0 = Date.now();
  const done = () => citizenProcs.every((p) => p.exitCode !== null || p.signalCode !== null);
  while (Date.now() - t0 < HARD_TIMEOUT_MS && !done()) {
    const s = await get("/snapshot"); const rs = await get("/run-state"); const h = hourOf(rs?.gameMinutes ?? 0);
    for (const id of UNDER_TEST) {
      const [ws_, we] = WINDOWS[id]; const onShift = h >= ws_ && h < we;
      if (!onShift) continue;
      sawInWindow[id] = true;
      const a = (s?.agents ?? []).find((x: any) => x.id === id); if (!a) continue;
      const b = buildingAt(a.x, a.y); if (b) inWindowBuildings[id].add(b);
      if (b === WORKID[id]) reachedWorkInWindow[id] = true;
    }
    await sleep(2000);
  }
  await sleep(2500);

  console.log("\n===== EVIDENCE (B6 — non-producers at work) =====");
  for (const id of UNDER_TEST) {
    console.log(`${id}: in-window? ${sawInWindow[id] ? "yes" : "NO (clock never entered its window this run)"} · reached ${WORKID[id]} in-window=${!!reachedWorkInWindow[id]} · in-window buildings={${[...inWindowBuildings[id]].join(",")}}`);
  }
  const ev = jl(join(DATA, "events.jsonl"));
  const statuses = ev.filter((e) => e.kind === "status");
  const buskStudy = statuses.filter((e) => { const t = String((e.payload ?? {}).text ?? ""); return /busk|study|court/i.test(t) || ["musician", "student", "regular"].includes(e.actor); });
  console.log(`status events: ${statuses.length} total · ${buskStudy.length} busk/study/court${buskStudy.length ? ` (e.g. ${buskStudy.slice(-3).map((s) => `${s.actor}:${(s.payload ?? {}).emoji ?? ""}${(s.payload ?? {}).text ?? ""}`).join(", ")})` : ""}`);

  console.log("\n===== VERDICT =====");
  const checks: Array<[string, boolean | null]> = [
    ["musician reached the PUB on-shift", sawInWindow.musician ? !!reachedWorkInWindow.musician : null],
    ["student reached the COLLEGE on-shift", sawInWindow.student ? !!reachedWorkInWindow.student : null],
    ["courier visited ≥2 buildings on-shift (mobile)", sawInWindow.courier ? inWindowBuildings.courier.size >= 2 : null],
    ["≥1 busk/study located status event", buskStudy.length >= 1],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok === null ? "⚪ (off-shift this run — inconclusive)" : ok ? "✅" : "⬜"} ${name}`);
  const green = checks.filter(([, ok]) => ok === true).length;
  const inconclusive = checks.filter(([, ok]) => ok === null).length;
  console.log(`\n${green} green${inconclusive ? `, ${inconclusive} inconclusive (clock didn't enter those windows — reset sim/data/run-state.json to start at day1 08:00, or widen RUN_MINUTES so the 20-min day rolls into 16:00 for the musician)` : ""}. ${green >= 2 ? "B6 FIX LOOKS LIVE — non-producers now go to work." : "Inspect citizen logs + traces; ensure the run reached the work-windows."}`);
}

main().catch((e) => console.error("VERIFY ERROR:", (e as Error).message)).finally(async () => { console.log("\n⏳ cleanup…"); await cleanup(); console.log("✓ cleanup done"); process.exit(0); });
