import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { personaFor } from "./personas.js";

// ROLE → BUILDINGS (Wave A1). The keystone gap (D23) was that the ACT prompt has NO role→building map, so the
// only attractor is *shops* — and every shop door sits on the top street. This module resolves, for each
// citizen, the three places that anchor a believable day:
//   • workId    — where they spend their work-window (barista@cafe, student@college, musician@pub-stage)
//   • homeId    — where they sleep / start + end the day (merchant→home-<role>, student→dorm, musician/regular→coliving)
//   • hangoutId — where they socialize off-shift (the cafe / the pub)
//
// SINGLE SOURCE OF TRUTH = sim/world.json (the map authority, an additive overlay — ledger PINNED CONTRACT).
// We do NOT hand-maintain a parallel table of where buildings are (that drifts — the repo has a documented
// drift footgun, world-tools.ts:356). Instead:
//   • workId   comes from the persona's `shopId` for the five merchants (already the single source for "their
//              shop"); for the non-merchants (shopId === "") it comes from a tiny ROLE_WORK table below
//              (student→college, musician→pub, regular→pub) — the only thing genuinely not derivable from the
//              economy, and it mirrors each persona's prose `station`/`routine`.
//   • homeId   is RESOLVED from world.json: the building whose `resident` === this citizen id (every merchant
//              home carries resident:"<role>"); non-merchants fall back to ROLE_HOME (student→dorm,
//              musician/regular→coliving) since the dorm/co-living buildings have no single `resident` field.
//   • hangoutId from a tiny ROLE_HANGOUT table (cheap, persona-derived).
//
// Both renderTick (prompt injection) and planning.planDay (real building ids fed to the model) consume the
// SAME resolver, so the agenda the model writes and the locations the prompt names can't disagree.

const HERE = dirname(fileURLToPath(import.meta.url)); // citizens/
const ROOT = dirname(HERE); // repo root

type RawBuilding = { id: string; type?: string; resident?: string; label?: string };
const WORLD = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8")) as { buildings: RawBuilding[] };
const BUILDING_IDS = new Set(WORLD.buildings.map((b) => b.id));
// id of the home whose `resident` field names this citizen (the five merchants set resident:"<role>" === id).
const HOME_BY_RESIDENT: Record<string, string> = {};
for (const b of WORLD.buildings) if (b.type === "home" && b.resident) HOME_BY_RESIDENT[b.resident] = b.id;

// The only facts NOT derivable from the economy/world.json `resident` overlay — kept tiny + mirroring each
// persona's prose station/routine. Keyed by CITIZEN ID (stable: matches personas.ts keys + world.json ids),
// never the prose `role` string ("sociology student" vs id "student").
const ROLE_WORK: Record<string, string> = {
  student: "college", // Klaus studies at Oak Hill College by day (persona station)
  musician: "pub", // Maria's stage is The Rose & Crown (she busks/plays there)
  regular: "pub", // Sam holds court at the pub — his "work" is being the pub's fixture
};
const ROLE_HOME_FALLBACK: Record<string, string> = {
  student: "dorm", // lives in the Oak Hill Dorm
  musician: "coliving", // rents a room in the Co-Living House
  regular: "coliving", // (no dedicated elder cottage in the map) — the Commons co-living
};
const ROLE_HANGOUT: Record<string, string> = {
  baker: "cafe", barista: "cafe", grocer: "cafe", courier: "cafe", smith: "cafe", // merchants relax at Hobbs Cafe
  student: "pub", musician: "pub", regular: "pub", // the younger/older social set haunt the pub
};

// B6: each role's WORK-WINDOW as [startHour, endHour] in game-hours-of-day (0-23). This is the band during which
// the citizen should be AT (or heading to) its workId (roughly half the waking day at work). Derived
// from each persona's routine in personas.ts and KEPT IN LOCKSTEP with instrumentor's M2 schedule-adherence bands
// (telemetry.ts) — same numbers, ONE source of truth (this one; instrumentor imports/mirrors). Keyed by citizen id.
// The fix for the showcase gap (non-producers lingered at the cafe all day): renderTick uses onShiftNow() to make
// "go to work" out-prioritize the social-reply branch WHEN a citizen is off-site during its own shift. Note the
// night/evening roles: musician 16-23, regular 18-23 — for them, evening is WORK, not off-shift.
const WORK_WINDOW: Record<string, [number, number]> = {
  baker: [5, 15],
  barista: [7, 18],
  grocer: [6, 18],
  smith: [8, 18],
  courier: [8, 18], // mobile by design — "at work" = moving its route, not pinned to the depot (see renderTick)
  student: [9, 17],
  musician: [16, 23], // evening performer — busks the afternoon, plays The Rose & Crown at night
  regular: [18, 23], // holds court at the pub in the evening
};
const DEFAULT_WINDOW: [number, number] = [8, 18];

/** This citizen's work-window as [startHour, endHour] (game-hours-of-day). Defaults to 08:00-18:00 if unlisted. */
export function workWindowFor(id: string): [number, number] {
  return WORK_WINDOW[id] ?? DEFAULT_WINDOW;
}

/** Is `id` within its work-window at absolute game-minutes `gameMin`? Uses hour-of-day (gameMin%1440/60), so it
 *  holds across days + a mid-day run start. Half-open [start, end): on shift at start, off at end. */
export function onShiftNow(id: string, gameMin: number): boolean {
  const [s, e] = workWindowFor(id);
  const hh = Math.floor((Math.max(0, Math.floor(gameMin)) % 1440) / 60);
  return hh >= s && hh < e;
}

export type BuildingMap = {
  workId: string; // where this citizen works/studies/plays during the work window
  homeId: string; // where they sleep + start/end the day
  hangoutId: string; // where they socialize off-shift
};

/**
 * The three anchor buildings for `id`, resolved against world.json (+ the tiny role tables for the facts the
 * map can't carry). Always returns valid building ids: workId/homeId/hangoutId are guaranteed to be real ids in
 * world.json (a bad persona shopId or a missing table entry degrades to a safe default — `cafe` for work/hangout,
 * the citizen's home-or-coliving for home) so a downstream `move(workId)` can never target a non-existent place.
 */
export function buildingMapFor(id: string): BuildingMap {
  const persona = personaFor(id); // throws for an unknown id — same contract as everywhere else
  // WORK: a merchant's own shop (persona.shopId), else the role table, else a safe default.
  const workCandidate = persona.shopId || ROLE_WORK[id] || "cafe";
  const workId = BUILDING_IDS.has(workCandidate) ? workCandidate : "cafe";
  // HOME: the world.json building that names this citizen as resident, else the role fallback, else coliving.
  const homeCandidate = HOME_BY_RESIDENT[id] || ROLE_HOME_FALLBACK[id] || "coliving";
  const homeId = BUILDING_IDS.has(homeCandidate) ? homeCandidate : "coliving";
  // HANGOUT: the role table, else the cafe (the town's living room).
  const hangoutCandidate = ROLE_HANGOUT[id] || "cafe";
  const hangoutId = BUILDING_IDS.has(hangoutCandidate) ? hangoutCandidate : "cafe";
  return { workId, homeId, hangoutId };
}

/** Human label for a building id (for the prompt), falling back to the id itself. */
export function buildingLabel(buildingId: string): string {
  return WORLD.buildings.find((b) => b.id === buildingId)?.label ?? buildingId;
}

// ---- runnable self-test (ZERO tokens) -------------------------------------------------------------------
// `tsx citizens/building-map.ts` checks every roster citizen resolves to REAL building ids, the five merchants
// map to their own shop + home-<role>, and the three non-merchants land at college/pub + dorm/coliving.
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
  };
  const ids = ["baker", "barista", "grocer", "courier", "smith", "student", "musician", "regular"];
  for (const id of ids) {
    const m = buildingMapFor(id);
    assert(BUILDING_IDS.has(m.workId), `${id}.workId "${m.workId}" is a real building`);
    assert(BUILDING_IDS.has(m.homeId), `${id}.homeId "${m.homeId}" is a real building`);
    assert(BUILDING_IDS.has(m.hangoutId), `${id}.hangoutId "${m.hangoutId}" is a real building`);
  }
  // merchants: work === own shop, home === home-<role>
  assert(buildingMapFor("baker").workId === "bakery", "baker works at the bakery");
  assert(buildingMapFor("barista").workId === "cafe", "barista works at the cafe");
  assert(buildingMapFor("smith").workId === "smithy", "smith works at the smithy");
  assert(buildingMapFor("baker").homeId === "home-baker", "baker lives at home-baker");
  assert(buildingMapFor("courier").homeId === "home-courier", "courier lives at home-courier");
  // non-merchants: college/pub work + dorm/coliving home
  assert(buildingMapFor("student").workId === "college", "student studies at the college");
  assert(buildingMapFor("student").homeId === "dorm", "student lives in the dorm");
  assert(buildingMapFor("musician").workId === "pub", "musician plays at the pub");
  assert(buildingMapFor("musician").homeId === "coliving", "musician lives in coliving");
  assert(buildingMapFor("regular").workId === "pub", "regular's place is the pub");
  assert(buildingMapFor("regular").homeId === "coliving", "regular lives in coliving");
  // hangouts
  assert(buildingMapFor("baker").hangoutId === "cafe", "baker hangs out at the cafe");
  assert(buildingMapFor("student").hangoutId === "pub", "student hangs out at the pub");
  // labels resolve
  assert(buildingLabel("cafe") === "Hobbs Cafe", "cafe label resolves");
  assert(buildingLabel("nonexistent") === "nonexistent", "unknown building falls back to its id");
  // B6: work-windows + onShiftNow (game-hour-of-day). day offset shouldn't matter (uses %1440).
  const D = 1440; // one game-day of minutes
  assert(workWindowFor("musician")[0] === 16 && workWindowFor("musician")[1] === 23, "musician window 16-23");
  assert(workWindowFor("nobody")[0] === 8, "unlisted id → default window");
  assert(onShiftNow("musician", 3 * D + 20 * 60) === true, "musician ON shift at 20:00 (day 3)");
  assert(onShiftNow("musician", 5 * D + 12 * 60) === false, "musician OFF shift at 12:00 (midday is not its shift)");
  assert(onShiftNow("student", 18 * 60) === false && onShiftNow("student", 10 * 60) === true, "student on 10:00, off 18:00");
  assert(onShiftNow("baker", 6 * 60) === true && onShiftNow("baker", 16 * 60) === false, "baker on 06:00, off 16:00");
  assert(onShiftNow("regular", 20 * 60) === true && onShiftNow("regular", 12 * 60) === false, "regular evening-only");
  console.log("building-map.ts self-test: ALL ASSERTIONS PASSED");
  for (const id of ids) {
    const m = buildingMapFor(id);
    console.log(`  ${id.padEnd(9)} work=${m.workId.padEnd(9)} home=${m.homeId.padEnd(13)} hangout=${m.hangoutId}`);
  }
}
