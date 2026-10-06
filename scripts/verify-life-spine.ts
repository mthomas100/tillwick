import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// verify-life-spine.ts — ZERO-TOKEN proof of the T0 life-spine (lifegiver). Run: `npx tsx scripts/verify-life-spine.ts`
//
// Proves, with no sim and no LLM:
//   1. REACHABILITY — replicates the sim's walkability rules over world.json and shows (a) the CURRENT
//      insideTile() formula leaves pub/college/dorm goTo-targets with no path from anywhere (the audit-A1
//      geometry bug), and (b) the door-adjacent inside-tile formula makes every building reachable from
//      every spawn. This is the contract the lead's sim-server patch must satisfy.
//   2. SCHEDULES — every role's 24h arc validates (tiling, real buildings, real stations, work-window
//      coverage) via schedules.ts validateSchedule.
//   3. PLAN TEMPLATE → Mind — with stubComplete + a fixed clock, ensureDailyPlan seeds the template at zero
//      cost, currentStep() returns the right line per sampled hour, and a later react-replan line OVERRIDES
//      the template for its bracket (newest-wins).
//   4. STATION PINNING + DOORWAY DETECTOR — InteriorPresence: entering a building parks you at spawnInside
//      (the interior doorway); entering WITH the scheduled station (hook 3) or go_inside pins you at the
//      station; a scripted student day shows station ≠ doorway at every work-hour sample.
//   5. PROMPT SPINE — renderTick (sim offline; every fetch degrades to {}) still produces a prompt whose
//      first branches carry the clock + the schedule step + the target building, and a well-formed planStep.

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = dirname(HERE); // repo root

type B = { id: string; x: number; y: number; w: number; h: number; door: { x: number; y: number }; interior?: unknown };
const world = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8")) as {
  width: number; height: number;
  street: { rows: number[] }; sidewalks: { rows: number[] };
  buildings: B[]; spawns: Record<string, { x: number; y: number }>;
};

let failures = 0;
const check = (cond: unknown, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ FAIL ${msg}`); }
};

// ---- 1. REACHABILITY ------------------------------------------------------------------------------------
// Replicates sim-server.ts walkable(): lanes = street+sidewalk ROWS ONLY (the live sim ignores world.json
// lanes.cols — its own _note admits it awaits "W2-move"); plus each building's door + registered inside tile.
// Reachability = BFS over 4-connected walkable tiles. TWO findings, both LIVE-CONFIRMED on the running sim
// (2026-07-18: POST /act goTo student→cafe = steps:0 · student→college = steps:0 · baker→pub = steps:0):
//   (a) TWO ISLANDS — without lanes.cols there is NO walkable tile between row 11 and row 26, so the north
//       corridor (5 merchants + all 5 shops) and the south corridor (student/musician/regular + pub/college/
//       dorm/coliving) are disconnected. South agents can reach NO shop; north agents can NEVER reach the pub.
//   (b) BROKEN INSIDE TILES — college/dorm/pub goTo-targets sit on the far side of their footprint from the
//       door (insideTile's north-side-door assumption), unreachable even WITHIN the south island.
const streetTop = world.street.rows[0];
type LaneCol = { x: number; y0: number; y1: number };
const laneCols: LaneCol[] = ((world as unknown as { lanes?: { cols?: LaneCol[] } }).lanes?.cols ?? []);
const insideTileCurrent = (b: B): [number, number] => [b.door.x, b.y < streetTop ? b.y + b.h - 1 : b.y];
const insideTileFixed = (b: B): [number, number] => [b.door.x, b.door.y >= b.y + b.h ? b.y + b.h - 1 : b.y];

function reachableFrom(start: [number, number], inside: (b: B) => [number, number], withCols: boolean): Set<string> {
  const lanes = new Set<number>([...world.street.rows, ...world.sidewalks.rows]);
  const tiles = new Set<string>();
  for (const b of world.buildings) {
    const [ix, iy] = inside(b);
    tiles.add(`${ix},${iy}`);
    tiles.add(`${b.door.x},${b.door.y}`);
  }
  const walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < world.width && y < world.height &&
    (lanes.has(y) || tiles.has(`${x},${y}`) || (withCols && laneCols.some((c) => x === c.x && y >= c.y0 && y <= c.y1)));
  const seen = new Set<string>([`${start[0]},${start[1]}`]);
  const q: Array<[number, number]> = [start];
  while (q.length) {
    const [cx, cy] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && walkable(nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

console.log("1) REACHABILITY (world.json geometry, sim walkability rules)");
{
  check(laneCols.length > 0, `world.json carries lanes.cols (the park bridge) — found ${laneCols.length} column(s)`);
  // (a) the TWO ISLANDS under the CURRENT rules: from a north spawn, no south building/spawn is reachable.
  const north = world.spawns["baker"];
  const south = world.spawns["student"];
  const curNorth = reachableFrom([north.x, north.y], insideTileCurrent, false);
  const southIds = ["college", "dorm", "pub", "coliving", "townhall"];
  check(southIds.every((id) => !curNorth.has(insideTileCurrent(world.buildings.find((b) => b.id === id)!).join(","))),
    "CURRENT rules: NO south building is reachable from the north island (two disconnected corridors)");
  check(!curNorth.has(`${south.x},${south.y}`), "CURRENT rules: the student's spawn is on the other island from the baker's");
  // (b) broken inside tiles WITHIN the south island: college/dorm/pub unreachable even from a south spawn.
  const curSouth = reachableFrom([south.x, south.y], insideTileCurrent, false);
  const brokenSouth = ["college", "dorm", "pub"].filter((id) => !curSouth.has(insideTileCurrent(world.buildings.find((b) => b.id === id)!).join(",")));
  check(brokenSouth.join(",") === "college,dorm,pub", `CURRENT insideTile: college/dorm/pub unreachable even from the south spawn (found: ${brokenSouth.join(",") || "none"})`);
  check(curSouth.has(insideTileCurrent(world.buildings.find((b) => b.id === "coliving")!).join(",")), "CURRENT rules: coliving IS reachable from the south (matches the regular's tape: the one move that worked)");
  // (c) the FIX: door-adjacent inside tiles + lanes.cols in walkable() → ONE component containing everything.
  const fixReach = reachableFrom([north.x, north.y], insideTileFixed, true);
  const stillBroken = world.buildings.filter((b) => !fixReach.has(insideTileFixed(b).join(",")));
  check(stillBroken.length === 0, `FIXED (door-adjacent tiles + lanes.cols): ALL ${world.buildings.length} buildings reachable from a north spawn`);
  for (const [id, s] of Object.entries(world.spawns)) {
    check(fixReach.has(`${s.x},${s.y}`), `FIXED: spawn of ${id} (${s.x},${s.y}) is on the single walkable component`);
  }
  // door-adjacency invariant: the fixed target is Chebyshev-1 from its door (so A* can step door↔inside).
  for (const b of world.buildings) {
    const [ix, iy] = insideTileFixed(b);
    check(Math.max(Math.abs(ix - b.door.x), Math.abs(iy - b.door.y)) === 1, `${b.id}: fixed inside tile (${ix},${iy}) is adjacent to its door (${b.door.x},${b.door.y})`);
  }
}

void (async () => {
  // ---- 2. SCHEDULES -------------------------------------------------------------------------------------
  console.log("2) SCHEDULES (24h arcs)");
  const { validateSchedule, scheduledIds, stepAt, agendaLines } = await import("../citizens/schedules.js");
  const { buildingMapFor } = await import("../citizens/building-map.js");
  for (const id of scheduledIds()) {
    const problems = validateSchedule(id, buildingMapFor(id).workId);
    check(problems.length === 0, `${id}: schedule valid${problems.length ? ` — ${problems.join(" · ")}` : ""}`);
  }

  // ---- 3. PLAN TEMPLATE → Mind (stubComplete, fixed clock, temp dir) ------------------------------------
  console.log("3) TEMPLATE PLAN in Mind (zero-token)");
  const { Mind } = await import("../cognition/mind.js");
  const { stubComplete } = await import("../cognition/llm.js");
  {
    let gameMin = 4 * 1440 + 9 * 60; // Day 5, 09:00
    const dir = mkdtempSync(join(tmpdir(), "life-spine-mind-"));
    const mind = new Mind({
      agentId: "student", persona: "Klaus the student.", complete: stubComplete(""),
      nowGameMin: () => gameMin, dir, planTemplate: () => agendaLines("student"),
    });
    await mind.ensureDailyPlan();
    const at = (hh: number, mm = 0) => { gameMin = 4 * 1440 + hh * 60 + mm; return mind.currentStep(gameMin); };
    check(/college/.test(at(10)?.text ?? ""), `student 10:00 currentStep names the college ("${at(10)?.text.slice(0, 60)}…")`);
    check(/study-desk-1/.test(at(10)?.text ?? ""), "student 10:00 currentStep carries the STATION (study-desk-1)");
    check(/pub/.test(at(20)?.text ?? ""), "student 20:00 currentStep → the pub");
    check(/dorm/.test(at(23)?.text ?? ""), "student 23:00 currentStep → the dorm (sleep)");
    // idempotent re-seed: a second ensureDailyPlan same-day adds nothing (restart safety)
    const sizeBefore = mind.size();
    (mind as unknown as { lastPlanDay: number }).lastPlanDay = -1; // simulate a process restart same-day
    await mind.ensureDailyPlan();
    check(mind.size() === sizeBefore, "re-seeding the same day is a no-op (restart-safe)");
    // react-replan override: a NEWER plan line for this bracket wins over the template (newest-wins).
    gameMin = 4 * 1440 + 10 * 60;
    mind.stream.add({ kind: "plan", text: "10:00 — rush to the cafe to meet Maria", createdAt: gameMin, importance: 6 });
    check(/cafe to meet Maria/.test(mind.currentStep(gameMin)?.text ?? ""), "a later react-replan line OVERRIDES the template for its slot");
    // structured stepAt agrees with the arc
    check(stepAt("student", 10 * 60)?.station === "study-desk-1", "stepAt(student,10:00) → study-desk-1");
  }

  // ---- 4. STATION PINNING + DOORWAY DETECTOR ------------------------------------------------------------
  console.log("4) STATION PINNING (InteriorPresence)");
  const { InteriorPresence, interiorOf } = await import("../sim/interiors.js");
  {
    const P = new InteriorPresence();
    const spawnInside = interiorOf("college")!.spawnInside;
    const plain = P.enter("student", "college");
    check(!!plain && plain.x === spawnInside.x && plain.y === spawnInside.y && !plain.sublocationId, "plain enter parks at spawnInside (the interior doorway) — today's mid-floor freeze");
    const pinned = P.moveToSublocation("student", "study-desk-1");
    check(!!pinned && pinned.sublocationId === "study-desk-1" && (pinned.x !== spawnInside.x || pinned.y !== spawnInside.y), "go_inside pins to the station, off the doorway");
    // hook-3 semantics: enter WITH the scheduled station lands directly on it (no doorway dwell at all)
    P.leave("student");
    const direct = P.enter("student", "college", "study-desk-1");
    check(!!direct && direct.sublocationId === "study-desk-1", "enter(building, station) lands ON the station");
    const ghost = P.enter("musician", "pub", "no-such-spot");
    check(!!ghost && !ghost.sublocationId, "a ghost station degrades to spawnInside (never throws)");
    // scripted day: at every work-hour sample the student's scheduled block names a station that exists and
    // pinning there moves him off the doorway — the "doorway-detector-clean" stream of A/§B3.
    const Q = new InteriorPresence();
    for (const hh of [9, 11, 14, 16]) {
      const blk = stepAt("student", hh * 60)!;
      Q.leave("student");
      Q.enter("student", blk.buildingId, blk.station);
      const w = Q.whereInside("student");
      const spawn = interiorOf(blk.buildingId)!.spawnInside;
      check(
        !!w && w.occupant.sublocationId === blk.station && (w.occupant.x !== spawn.x || w.occupant.y !== spawn.y),
        `scripted student @${hh}:00 → ${blk.buildingId}#${blk.station} (not the doorway)`,
      );
    }
  }

  // ---- 5. PROMPT SPINE (renderTick offline — every sim fetch degrades to {}) ----------------------------
  console.log("5) PROMPT SPINE (renderTick, sim offline)");
  {
    process.env.SIM_URL = "http://127.0.0.1:1"; // guaranteed-refused port → getJson/post degrade instantly
    const { renderTick, personaFor } = await import("../citizens/world-tools.js");
    const gm = 4 * 1440 + 10 * 60; // Day 5, 10:00 — student should be at a college desk
    const r = await renderTick("student", personaFor("student"), 1, undefined, gm);
    check(/It is Day 5, 10:00/.test(r.prompt), "prompt line 1 carries the CLOCK");
    check(/Your day right now \(09:00–12:30\)/.test(r.prompt), "prompt carries the schedule bracket (09:00–12:30)");
    check(/move\(\{to:"college"\}\)/.test(r.prompt), "prompt's first branch targets the COLLEGE");
    check(/IT IS YOUR WORKING HOURS/.test(r.prompt), "work-window override present when off-site on-shift");
    check(r.planStep === "09:00-12:30 lectures and reading at your desk @college#study-desk-1", `planStep well-formed ("${r.planStep}")`);
    const rm = await renderTick("musician", personaFor("musician"), 1, undefined, 4 * 1440 + 20 * 60);
    check(/pub/.test(rm.planStep) && /#pub-stage/.test(rm.planStep), `musician 20:00 planStep → pub#pub-stage ("${rm.planStep}")`);
    const rr = await renderTick("regular", personaFor("regular"), 1, undefined, 4 * 1440 + 2 * 60);
    check(/sleep/.test(rr.planStep) && /@coliving/.test(rr.planStep), `regular 02:00 planStep → asleep at coliving ("${rr.planStep}")`);
    // D28 never-stuck: a stuckNote makes the top decide-branch "do something different".
    const rs = await renderTick("student", personaFor("student"), 2, undefined, gm, "all 3 actions you tried came back blocked — 2 ticks in a row now.");
    check(/YOU ARE STUCK/.test(rs.prompt) && rs.prompt.indexOf("YOU ARE STUCK") < rs.prompt.indexOf("WORKING HOURS"), "stuckNote branch present ABOVE the work-window override (D28)");
    // D32: planMeta is the structured plan-step beat payload.
    check(rs.planMeta?.building === "college" && rs.planMeta?.station === "study-desk-1" && rs.planMeta?.until === "12:30", `planMeta structured for the beat (${JSON.stringify(rs.planMeta)})`);
    // never-stuck outcome tally: read-and-reset contract.
    const { takeTurnOutcome } = await import("../citizens/world-tools.js");
    const o1 = takeTurnOutcome("student");
    check(o1.ok === 0 && o1.blocked === 0, "takeTurnOutcome starts/resets at zero (tallies come from live tool calls)");
  }

  if (failures) { console.error(`\nverify-life-spine: ${failures} FAILURE(S)`); process.exit(1); }
  console.log("\nverify-life-spine: ALL CHECKS PASSED (reachability contract · schedules · template plan · station pinning · prompt spine)");
})().catch((err) => { console.error(err); process.exit(1); });
