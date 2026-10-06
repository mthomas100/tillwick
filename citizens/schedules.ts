import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { workWindowFor } from "./building-map.js";

// SCHEDULE SPINE v2 (T0 life-spine) — every role's FULL 24h arc as data: wake at home → morning routine →
// commute → work AT A NAMED STATION → lunch/errands that CROSS town (each with a reason) → evening venue →
// home → sleep. This is the deterministic skeleton of a believable day; the LLM layer reacts/replans ON TOP
// of it (paper §4.3.1) but can no longer fail to produce a day at all.
//
// WHY DATA, NOT LLM (audit A4/A5, 2026-07-18): at 4-8 acted ticks per agent per game-day, a generated plan
// that names a wrong/vague place burns a whole day; and every planDay/decompose call is a fresh CLI spawn
// (10-35s wall) the tick budget can't afford. The template costs ZERO tokens, is always well-formed, always
// names real building ids + real station ids, and honors each persona's prose routine. `agendaLines()`
// renders it into plan-memory lines (parsePlanTime-compatible) so retrieval/reflection still see "the plan"
// exactly as before; `stepAt()` gives the ACT prompt a STRUCTURED current step (building + station + reason)
// with no regex inference needed.
//
// SINGLE SOURCES OF TRUTH: building ids + station (sublocation) ids are validated against sim/world.json at
// load; work windows come from building-map.ts workWindowFor (same numbers as the M2 telemetry bands). A
// schedule that names a ghost building/station or starves its work window FAILS validation loudly at import
// (in the self-test) rather than silently mis-steering agents at runtime.

export type ScheduleKind = "sleep" | "home" | "work" | "errand" | "meal" | "social";
export type ScheduleBlock = {
  start: number; // minutes-of-day, inclusive (0..1439)
  end: number; // minutes-of-day, exclusive (start < end <= 1440); blocks tile the day exactly
  buildingId: string; // a REAL building id in sim/world.json — where this block happens
  station?: string; // optional sublocation id INSIDE that building (validated against its interior block)
  activity: string; // short NL, present tense — what the agent is doing ("bake the morning loaves")
  reason?: string; // why — makes errands read as intentional, feeds the ACT prompt
  kind: ScheduleKind;
};

const HERE = dirname(fileURLToPath(import.meta.url)); // citizens/
const ROOT = dirname(HERE); // repo root
type RawBuilding = { id: string; interior?: { sublocations?: Array<{ id: string }> } };
const WORLD = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8")) as { buildings: RawBuilding[] };
const BUILDING_IDS = new Set(WORLD.buildings.map((b) => b.id));
const SUBLOCS: Record<string, Set<string>> = {};
for (const b of WORLD.buildings) SUBLOCS[b.id] = new Set((b.interior?.sublocations ?? []).map((s) => s.id));

// h(hh, mm?) — minutes-of-day, so the tables below read like a timetable.
const h = (hh: number, mm = 0) => hh * 60 + mm;

// The 8 arcs. Each mirrors its persona's prose routine (personas.ts) and its WORK_WINDOW (building-map.ts):
// merchants man their top-street shops with a real lunch errand; the student's day is AT the college; the
// musician's stage and the regular's corner seat are AT the pub in the evening; everyone's errands cross town
// with a reason, so the whole map is in use across the day (M1) — not just the top street.
const SCHEDULES: Record<string, ScheduleBlock[]> = {
  baker: [
    { start: h(0), end: h(4, 30), buildingId: "home-baker", activity: "sleep", kind: "sleep" },
    { start: h(4, 30), end: h(5), buildingId: "home-baker", activity: "wake before dawn and eat a quick breakfast", reason: "the oven waits", kind: "home" },
    { start: h(5), end: h(10), buildingId: "bakery", station: "oven", activity: "bake the morning loaves", reason: "the town wakes to fresh bread", kind: "work" },
    { start: h(10), end: h(13), buildingId: "bakery", station: "bakery-counter", activity: "sell the morning rush at the counter", kind: "work" },
    { start: h(13), end: h(13, 30), buildingId: "grocer", activity: "buy staples from Tomas", reason: "flour, milk — you trust his scales", kind: "errand" },
    { start: h(13, 30), end: h(15), buildingId: "bakery", station: "bakery-counter", activity: "afternoon sales and tidy the bakehouse", kind: "work" },
    { start: h(15), end: h(16), buildingId: "cafe", activity: "afternoon coffee from Iris", reason: "you flag by mid-afternoon; bread-for-coffee is your ritual", kind: "meal" },
    { start: h(16), end: h(18, 30), buildingId: "home-baker", activity: "rest and do the books", kind: "home" },
    { start: h(18, 30), end: h(20), buildingId: "cafe", activity: "an easy evening hour at the cafe", kind: "social" },
    { start: h(20), end: h(24), buildingId: "home-baker", activity: "early night — you rise before dawn", kind: "sleep" },
  ],
  barista: [
    { start: h(0), end: h(6), buildingId: "home-barista", activity: "sleep", kind: "sleep" },
    { start: h(6), end: h(7), buildingId: "home-barista", activity: "wake and get ready", kind: "home" },
    { start: h(7), end: h(11), buildingId: "cafe", station: "espresso-machine", activity: "open the cafe and pull shots for the morning rush", kind: "work" },
    { start: h(11), end: h(11, 30), buildingId: "bakery", activity: "fetch bread from Mara", reason: "the morning bread-for-coffee trade", kind: "errand" },
    { start: h(11, 30), end: h(15), buildingId: "cafe", station: "cafe-counter", activity: "hold court at the counter and serve", kind: "work" },
    { start: h(15), end: h(15, 30), buildingId: "grocer", activity: "buy apples from Tomas", reason: "for the counter bowl", kind: "errand" },
    { start: h(15, 30), end: h(18), buildingId: "cafe", station: "cafe-counter", activity: "afternoon service and gossip", kind: "work" },
    { start: h(18), end: h(19, 30), buildingId: "pub", activity: "a drink after close — hear the evening's news", kind: "social" },
    { start: h(19, 30), end: h(21, 30), buildingId: "home-barista", activity: "supper and wind down", kind: "home" },
    { start: h(21, 30), end: h(24), buildingId: "home-barista", activity: "sleep", kind: "sleep" },
  ],
  grocer: [
    { start: h(0), end: h(5, 30), buildingId: "home-grocer", activity: "sleep", kind: "sleep" },
    { start: h(5, 30), end: h(6), buildingId: "home-grocer", activity: "wake with the light", kind: "home" },
    { start: h(6), end: h(12), buildingId: "grocer", station: "grocer-register", activity: "set out the produce and mind the morning trade", kind: "work" },
    { start: h(12), end: h(12, 30), buildingId: "cafe", activity: "midday coffee from Iris", reason: "your one indulgence; she always has a question", kind: "meal" },
    { start: h(12, 30), end: h(18), buildingId: "grocer", station: "grocer-register", activity: "restock the shelves and keep the books square", kind: "work" },
    { start: h(18), end: h(19, 30), buildingId: "pub", activity: "an evening pint with the old hands", reason: "you and Sam trade the old names", kind: "social" },
    { start: h(19, 30), end: h(21), buildingId: "home-grocer", activity: "supper at home", kind: "home" },
    { start: h(21), end: h(24), buildingId: "home-grocer", activity: "sleep", kind: "sleep" },
  ],
  smith: [
    { start: h(0), end: h(6, 30), buildingId: "home-smith", activity: "sleep", kind: "sleep" },
    { start: h(6, 30), end: h(7, 30), buildingId: "home-smith", activity: "stoke the home fire and eat", kind: "home" },
    { start: h(7, 30), end: h(8), buildingId: "bakery", activity: "buy bread while it's warm", reason: "Mara's loaves, first thing", kind: "errand" },
    { start: h(8), end: h(13), buildingId: "smithy", station: "forge", activity: "work the forge on the day's jobs", kind: "work" },
    { start: h(13), end: h(13, 30), buildingId: "grocer", activity: "buy milk from Tomas", reason: "a word with the other old hand of Main Street", kind: "errand" },
    { start: h(13, 30), end: h(18), buildingId: "smithy", station: "anvil", activity: "finish the pieces right at the anvil", kind: "work" },
    { start: h(18), end: h(20), buildingId: "pub", activity: "take the stool next to Sam and let the silences sit", kind: "social" },
    { start: h(20), end: h(21), buildingId: "home-smith", activity: "bank the fire", kind: "home" },
    { start: h(21), end: h(24), buildingId: "home-smith", activity: "sleep", kind: "sleep" },
  ],
  // The courier is MOBILE by design (building-map.ts:68): his work-window blocks are a delivery ROUTE that
  // crosses the whole town (Main Square, Oak Hill, the Commons), anchored at the depot between runs.
  courier: [
    { start: h(0), end: h(6, 45), buildingId: "home-courier", activity: "sleep", kind: "sleep" },
    { start: h(6, 45), end: h(7, 30), buildingId: "home-courier", activity: "wake and lace up", kind: "home" },
    { start: h(7, 30), end: h(8), buildingId: "cafe", activity: "first coffee from Iris", reason: "fuel for the route; trade her the news", kind: "meal" },
    { start: h(8), end: h(9, 30), buildingId: "depot", station: "supply-counter", activity: "load the morning deliveries", kind: "work" },
    { start: h(9, 30), end: h(11), buildingId: "bakery", activity: "delivery round: Main Square drops", reason: "parcels for the shops", kind: "work" },
    { start: h(11), end: h(12, 30), buildingId: "college", activity: "delivery round: Oak Hill", reason: "packages for the college", kind: "work" },
    { start: h(12, 30), end: h(13), buildingId: "cafe", activity: "a quick bite on the move", kind: "meal" },
    { start: h(13), end: h(14, 30), buildingId: "depot", station: "supply-counter", activity: "reload for the afternoon run", kind: "work" },
    { start: h(14, 30), end: h(16), buildingId: "pub", activity: "delivery round: the Commons", reason: "crates for the Rose & Crown", kind: "work" },
    { start: h(16), end: h(17, 30), buildingId: "smithy", activity: "last drop-offs of the day", reason: "iron stock for Bran", kind: "work" },
    { start: h(17, 30), end: h(18), buildingId: "depot", station: "supply-counter", activity: "log the day's runs", kind: "work" },
    { start: h(18), end: h(19, 30), buildingId: "cafe", activity: "unwind where the talk is", kind: "social" },
    { start: h(19, 30), end: h(21), buildingId: "home-courier", activity: "supper and off your feet", kind: "home" },
    { start: h(21), end: h(24), buildingId: "home-courier", activity: "sleep", kind: "sleep" },
  ],
  student: [
    { start: h(0), end: h(7, 30), buildingId: "dorm", station: "dorm-beds", activity: "sleep", kind: "sleep" },
    { start: h(7, 30), end: h(8, 15), buildingId: "dorm", activity: "wake and gather your books", kind: "home" },
    { start: h(8, 15), end: h(9), buildingId: "cafe", activity: "coffee before class — make it last", reason: "Iris lets you linger; it's the cheapest seat in town", kind: "meal" },
    { start: h(9), end: h(12, 30), buildingId: "college", station: "study-desk-1", activity: "lectures and reading at your desk", kind: "work" },
    { start: h(12, 30), end: h(13, 15), buildingId: "bakery", activity: "a cheap lunch — day-old bread from Mara", reason: "you live on whatever's cheap", kind: "meal" },
    { start: h(13, 15), end: h(17), buildingId: "college", station: "study-desk-2", activity: "afternoon seminar, then the library", kind: "work" },
    { start: h(17), end: h(19), buildingId: "cafe", activity: "read at the cafe over one coffee", kind: "social" },
    { start: h(19), end: h(21, 30), buildingId: "pub", activity: "argue ideas with Maria and listen to Sam's stories", kind: "social" },
    { start: h(21, 30), end: h(24), buildingId: "dorm", station: "dorm-beds", activity: "sleep", kind: "sleep" },
  ],
  musician: [
    { start: h(0), end: h(9, 30), buildingId: "coliving", station: "coliving-bed", activity: "sleep late — night owl", kind: "sleep" },
    { start: h(9, 30), end: h(10, 30), buildingId: "coliving", activity: "slow morning; tune the guitar", kind: "home" },
    { start: h(10, 30), end: h(11, 30), buildingId: "cafe", activity: "coffee from Iris; tell her what you're writing", kind: "meal" },
    { start: h(11, 30), end: h(13, 30), buildingId: "coliving", station: "coliving-sofa", activity: "write the new song", reason: "it's almost there", kind: "work" },
    { start: h(13, 30), end: h(15, 30), buildingId: "grocer", activity: "an apple from Tomas, then busk outside the market", reason: "the afternoon crowd on Main Street", kind: "errand" },
    { start: h(15, 30), end: h(19), buildingId: "pub", station: "pub-stage", activity: "take the stage — the early set", kind: "work" },
    { start: h(19), end: h(20), buildingId: "pub", station: "bar-counter", activity: "supper at the bar between sets", kind: "meal" },
    { start: h(20), end: h(23), buildingId: "pub", station: "pub-stage", activity: "the evening set — play it good", reason: "Sam never misses it", kind: "work" },
    { start: h(23), end: h(24), buildingId: "coliving", station: "coliving-bed", activity: "home and crash", kind: "sleep" },
  ],
  regular: [
    { start: h(0), end: h(7), buildingId: "coliving", station: "coliving-bed", activity: "sleep", kind: "sleep" },
    { start: h(7), end: h(9), buildingId: "coliving", station: "coliving-table", activity: "a slow breakfast and the old paper", kind: "home" },
    { start: h(9), end: h(10), buildingId: "bakery", activity: "the morning loaf from Mara", kind: "errand" },
    { start: h(10), end: h(11), buildingId: "grocer", activity: "milk, and trade the old names with Tomas", kind: "errand" },
    { start: h(11), end: h(12, 30), buildingId: "cafe", activity: "walk Main Street and see who's about", kind: "social" },
    { start: h(12, 30), end: h(14, 30), buildingId: "coliving", station: "coliving-sofa", activity: "an old man's afternoon nap", kind: "home" },
    { start: h(14, 30), end: h(16), buildingId: "smithy", activity: "sit with Bran at the forge awhile", reason: "fifty years of easy silences", kind: "social" },
    { start: h(16), end: h(18), buildingId: "coliving", activity: "rest up before the evening", kind: "home" },
    { start: h(18), end: h(23), buildingId: "pub", station: "pub-table-1", activity: "hold court from the corner seat", reason: "your second home; Maria plays tonight", kind: "work" },
    { start: h(23), end: h(24), buildingId: "coliving", station: "coliving-bed", activity: "totter home and sleep", kind: "sleep" },
  ],
};

/** The full 24h schedule for a citizen id, or undefined for an unknown id (caller falls back to plan lines). */
export function scheduleFor(id: string): ScheduleBlock[] | undefined {
  return SCHEDULES[id];
}

/** The schedule block covering minutes-of-day `minOfDay` (0..1439). Blocks tile the day, so this is total
 *  for known ids. Accepts absolute game-minutes too (uses % 1440). */
export function stepAt(id: string, minOfDay: number): ScheduleBlock | undefined {
  const blocks = SCHEDULES[id];
  if (!blocks) return undefined;
  const m = ((Math.floor(minOfDay) % 1440) + 1440) % 1440;
  return blocks.find((b) => b.start <= m && m < b.end);
}

const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Render the schedule as daily-agenda plan lines ("HH:MM — <activity> at <buildingId> (your spot: X)").
 *  Each line leads with a bare-24h time so mind.ts parsePlanTime() reads it; each names its building id so
 *  inferStepTarget()'s explicit-id branch hits without guessing. These seed the memory stream as kind:"plan"
 *  (Mind.ensureDailyPlan template path) so retrieval/reflection see the day exactly as an LLM plan. */
export function agendaLines(id: string): string[] {
  const blocks = SCHEDULES[id];
  if (!blocks) return [];
  return blocks.map(
    (b) =>
      `${fmt(b.start)} — ${b.activity} at ${b.buildingId}` +
      (b.station ? ` (your spot: ${b.station})` : "") +
      (b.reason ? ` — ${b.reason}` : ""),
  );
}

/** Validate one schedule: tiles 0..1440 exactly, real buildings, real stations, and ≥60% of the role's
 *  work-window minutes spent at its workplace-or-route (kind "work"). Returns a list of problems (empty = ok). */
export function validateSchedule(id: string, workId?: string): string[] {
  const problems: string[] = [];
  const blocks = SCHEDULES[id];
  if (!blocks || blocks.length === 0) return [`${id}: no schedule`];
  let cursor = 0;
  for (const b of blocks) {
    if (b.start !== cursor) problems.push(`${id}: gap/overlap at ${fmt(b.start)} (expected ${fmt(cursor)})`);
    if (b.end <= b.start) problems.push(`${id}: empty/negative block at ${fmt(b.start)}`);
    if (!BUILDING_IDS.has(b.buildingId)) problems.push(`${id}: ghost building "${b.buildingId}" at ${fmt(b.start)}`);
    if (b.station && !SUBLOCS[b.buildingId]?.has(b.station))
      problems.push(`${id}: station "${b.station}" not in ${b.buildingId}'s interior sublocations`);
    cursor = b.end;
  }
  if (cursor !== 1440) problems.push(`${id}: day ends at ${fmt(cursor)}, not 24:00`);
  // work-window coverage: within [start,end) hours from workWindowFor, count minutes in kind:"work" blocks.
  const [ws, we] = workWindowFor(id);
  const windowMin = (we - ws) * 60;
  let workMin = 0;
  for (const b of blocks) {
    if (b.kind !== "work") continue;
    const lo = Math.max(b.start, ws * 60);
    const hi = Math.min(b.end, we * 60);
    if (hi > lo) workMin += hi - lo;
  }
  if (windowMin > 0 && workMin / windowMin < 0.6)
    problems.push(`${id}: only ${Math.round((100 * workMin) / windowMin)}% of work-window minutes are kind:"work" (want ≥60%)`);
  // the WORKPLACE itself must host the plurality of window work minutes (courier exempt: route-by-design).
  if (workId && id !== "courier") {
    let atWork = 0;
    for (const b of blocks) {
      if (b.kind !== "work" || b.buildingId !== workId) continue;
      const lo = Math.max(b.start, ws * 60);
      const hi = Math.min(b.end, we * 60);
      if (hi > lo) atWork += hi - lo;
    }
    if (windowMin > 0 && atWork / windowMin < 0.6)
      problems.push(`${id}: only ${Math.round((100 * atWork) / windowMin)}% of the window is AT ${workId} (want ≥60%)`);
  }
  return problems;
}

/** All roster ids that have a schedule. */
export function scheduledIds(): string[] {
  return Object.keys(SCHEDULES);
}

// ---- runnable self-test (ZERO tokens) -------------------------------------------------------------------
// `tsx citizens/schedules.ts`: every schedule tiles the day, names only real buildings/stations, honors its
// work window, crosses town (≥3 distinct buildings incl. ≥1 south-side), and agendaLines lead with HH:MM.
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { buildingMapFor } = await import("./building-map.js");
    const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`); };
    const SOUTH = new Set(["college", "dorm", "pub", "coliving", "townhall"]);
    const ids = scheduledIds();
    assert(ids.length === 8, "8 roles have schedules");
    const fleetPlaces = new Set<string>();
    let southRoles = 0;
    for (const id of ids) {
      const problems = validateSchedule(id, buildingMapFor(id).workId);
      assert(problems.length === 0, `${id} schedule valid:\n  ${problems.join("\n  ")}`);
      const places = new Set((scheduleFor(id) ?? []).map((b) => b.buildingId));
      assert(places.size >= 3, `${id} visits ≥3 distinct buildings (got ${places.size})`);
      for (const p of places) fleetPlaces.add(p);
      if ([...places].some((p) => SOUTH.has(p))) southRoles++;
      for (const line of agendaLines(id)) assert(/^\d{2}:\d{2} — /.test(line), `${id} agenda line leads with HH:MM: "${line}"`);
    }
    // MAP UTILIZATION (M1): the fleet's days collectively span ≥12 of the 15 buildings, every south-side
    // venue is in someone's day, and most roles cross south at least once (baker is persona-exempt: dawn riser).
    assert(fleetPlaces.size >= 12, `fleet uses ≥12 distinct buildings across the day (got ${fleetPlaces.size})`);
    for (const must of ["college", "dorm", "pub", "coliving"]) assert(fleetPlaces.has(must), `someone's day includes ${must}`);
    assert(southRoles >= 6, `≥6 of 8 roles cross to the south side daily (got ${southRoles})`);
    // spot checks: the right people are at the right stations at the right times.
    assert(stepAt("baker", h(6))?.station === "oven", "baker 06:00 → oven");
    assert(stepAt("barista", h(8))?.station === "espresso-machine", "barista 08:00 → espresso machine");
    assert(stepAt("student", h(10))?.buildingId === "college" && stepAt("student", h(10))?.station === "study-desk-1", "student 10:00 → college desk");
    assert(stepAt("musician", h(20))?.station === "pub-stage", "musician 20:00 → pub stage");
    assert(stepAt("regular", h(19))?.station === "pub-table-1", "regular 19:00 → corner table");
    assert(stepAt("courier", h(11, 30))?.buildingId === "college", "courier 11:30 → Oak Hill round");
    assert(stepAt("smith", h(2))?.kind === "sleep", "smith 02:00 → asleep");
    // absolute game-minutes work too (day 4 morning)
    assert(stepAt("grocer", 4 * 1440 + h(9))?.buildingId === "grocer", "absolute gameMin maps through %1440");
    // parsePlanTime compatibility (the seeded lines must be readable by Mind.currentStep)
    const { parsePlanTime } = await import("../cognition/mind.js");
    for (const line of agendaLines("student")) assert(parsePlanTime(line) != null, `parsePlanTime reads "${line}"`);
    console.log("schedules.ts self-test: ALL ASSERTIONS PASSED (8 roles · tiling · stations · windows · south-side reach · agenda parse)");
    for (const id of ids) {
      const b = stepAt(id, h(10))!;
      console.log(`  ${id.padEnd(9)} 10:00 → ${b.buildingId}${b.station ? ` @${b.station}` : ""} (${b.activity})`);
    }
  })().catch((err) => { console.error(err); process.exit(1); });
}
