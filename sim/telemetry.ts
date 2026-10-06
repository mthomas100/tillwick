// God's-eye TELEMETRY HARNESS (Wave A2 — the INSTRUMENT) — the "is it alive?" scorecard, computed from
// the sim's own logs, so an agent can tell whether the town behaves as intended without watching the
// canvas: grade each bounded run on M1-M8 and watch the numbers, not a screenshot. This is the harsh-critic's gauge AND the lead's before/after gate for the A1 keystone.
//
// DESIGN:
//   • PURE CORE. `computeTelemetry(input)` is a pure function of (already-parsed logs + world + roleConfig)
//     → unit-testable with fixtures, no fs, no clock, no LLM (D11 + the sim-never-calls-LLM invariant: the
//     harness is a sibling READER, same rule). A thin `loadTelemetryInput()` does the fs reading.
//   • POSITION FROM TRACES, not `move` events. `trace.perceived.shop` is the sim-RESOLVED building; raw
//     `perceived.at.{x,y}` is the cross-check. `move.payload.to` is free-text LLM intent (unmappable) —
//     used only for the activity stream, never for M1/M2. (D-A2-1.)
//   • GAME-CLOCK for "per day". `day = floor(gameMin/1440)+1` — mirrors run-state.ts so buckets match the
//     sim's own clock; never invent a second clock (D13). Run SELECTION is by wall-clock `ts`. (D-A2-2.)
//   • DEGRADE-DON'T-DIE. Every line is parsed try/catch-skip; a torn-mid-write JSONL never throws. The
//     harness NEVER writes to sim/data. (The repo grain: trace.ts/memory-stream.ts.)
//   • ROLE MAP IS A PARAMETER, printed in the scorecard, so M2 is honest about what it graded against and
//     swapping to behaviorist's A1 map is one line. (D-A2-4.)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import type { TraceLine } from "../cognition/trace.js"; // reuse the S0-4 shape — don't drift the reader
import { listRunIds, readManifest, type RunManifest, type TapeBeat } from "./flight-tape.js"; // T0-tape: run-scoped slicing + M7/M9

// ───────────────────────── shapes of the sources (verified by jq on the live logs) ─────────────────────────

/** One line of sim/data/events.jsonl. The sim is its single writer (the world authority). */
export type EventLine = {
  ts: string; // wall-clock ISO
  actor: string;
  kind: string; // decision|move|consume|purchase|say|produce|online|give|use|pick_up|drop
  payload?: Record<string, unknown>;
  related_id?: string;
  txHash?: string;
};

/** One line of sim/data/dialogue.jsonl — a real turn-taking record (holdDialogue close). */
export type DialogueLine = {
  id: string;
  participants: string[];
  startedAtGameMin: number;
  endedAtGameMin?: number;
  turns: number; // number of A↔B exchanges; >=3 is "a real conversation" (M3)
  outcome: string; // "conversed" | "walk_by"
  topic?: string;
  transcript?: Array<{ speaker: string; text: string }>;
  summaryFor?: Record<string, string>;
};

/** One line of sim/data/relationships/<ego>.jsonl — append-only; LAST line per `other` is current (M5). */
export type RelationLine = {
  other: string;
  familiarity: number;
  dialogues: number;
  coPresences: number;
  tradesAsBuyer: number;
  tradesAsSeller: number;
  usdcBought: number;
  usdcSold: number;
  firstSeenGameMin: number;
  lastInteractionGameMin: number;
  topics: string[];
};

/** A building footprint from world.json — enough to test point-in-building + classify "top street". */
export type Building = {
  id: string;
  type: string; // shop|home|civic
  label?: string;
  area?: string; // main-square = the "top street" cluster
  x: number;
  y: number;
  w: number;
  h: number;
  door?: { x: number; y: number };
};

/** The world.json subset telemetry needs (footprints + street rows + areas). */
export type World = {
  width: number;
  height: number;
  street?: { rows: number[] };
  sidewalks?: { rows: number[] };
  areas?: Array<{ id: string; kind?: string; buildings?: string[] }>;
  buildings: Building[];
};

/**
 * The A1 schedule model M2 grades against. SINGLE SOURCE OF TRUTH = behaviorist's building-map.ts (workplace)
 * + personas.ts routines (work-windows). PER-ROLE windows are load-bearing: a uniform 08:00–17:00 would
 * FALSE-NEGATIVE the night-owls (musician 16:00–23:00, regular 18:00–23:00) and the pre-dawn baker
 * (05:00–15:00). `movementRoles` are graded on MOVEMENT, not "% at workplace" — the courier's job is to
 * crisscross town (the depot is a base, not a seat), so scoring him on "% at depot" would read his doing-his-
 * job as an M2 failure (behaviorist's caveat; option (a): exclude from the at-workplace mean, credit M1
 * movement instead, and FLAG it so it's not a silent regression).
 */
export type RoleConfig = {
  workplace: Record<string, string | null>; // agentId → buildingId (null = no workplace, M2 N/A)
  workWindows: Record<string, { startMin: number; endMin: number }>; // agentId → on-shift band, minutes-of-day [start,end)
  defaultWindow: { startMin: number; endMin: number }; // for any agent not in workWindows
  movementRoles: Set<string>; // graded on movement/distinct-buildings in-window, NOT "% at workplace" (e.g. courier)
  /** T0: lifegiver's schedule spine (citizens/schedules.ts stepAt). When present, M2 grades against the
   *  FULL-DAY SCHEDULE (expected building per minute) instead of the flat workplace map — the courier's
   *  delivery route and the baker's 13:00 grocer errand are ON-plan, not truancy. Soft-resolved like the
   *  workplace map; absent → the legacy at-workplace grading (fallback intact). */
  stepAt?: (id: string, minOfDay: number) => { buildingId: string; station?: string; kind?: string } | undefined;
};

/** Everything `computeTelemetry` needs — already parsed. The thin loader produces this from fs. */
export type TelemetryInput = {
  events: EventLine[];
  dialogues: DialogueLine[];
  traces: TraceLine[]; // flattened across all agents (each carries `id`)
  relations: Record<string, RelationLine[]>; // ego → its relationship lines (append-only; reduce-by-last)
  world: World;
  roleConfig: RoleConfig;
  /** the wall-clock slice this input represents (for the scorecard header); informational only. */
  slice?: { sinceTs?: string; label?: string };
  /** M8 non-regression baseline (settlement count). Default 1164 (the historical watermark). */
  settlementBaseline?: number;
  /** T0-tape: flight-tape beats for the graded run (enter/leave/spot/earshot/…) — powers the REAL M7. */
  tape?: TapeBeat[];
  /** T0-tape: how many game-minutes the graded slice spans (manifest end−start, else observed) — powers M9. */
  gameSpanMin?: number;
};

// ───────────────────────── the scorecard output ─────────────────────────

export type Grade = "pass" | "warn" | "fail" | "na";

/** One metric's result — value + human one-liner + PASS/WARN/FAIL vs the §3 target. */
export type MetricResult = {
  id: string; // "M1".."M8"
  name: string;
  grade: Grade;
  target: string; // the §3 target, verbatim-ish
  value: string; // the headline value (for the scorecard column)
  detail: Record<string, unknown>; // the structured breakdown (for /telemetry JSON + drill-down)
};

export type Telemetry = {
  generatedAt: string; // wall-clock ISO of computation
  slice: { sinceTs?: string; label?: string; events: number; traces: number; dialogues: number; agents: string[] };
  gameDays: number[]; // distinct game-days present in the slice (from traces + dialogues)
  roleMap: Record<string, string | null>; // the workplace map M2 graded against (transparency)
  roleConfigWarnings: string[]; // anti-drift guard: non-empty if the window/movement table fell out of sync with the workplace map
  metrics: MetricResult[]; // M1..M8 in order
  greenCount: number; // of M1..M6 (the behavior layer); the "N/8 green" verdict uses M1..M8
  verdict: string; // "Is it alive? — N/8 green"
};

// ───────────────────────── geometry + clock helpers (mirror sim/run-state.ts) ─────────────────────────

/** game-day of an absolute game-minute — IDENTICAL to run-state.ts clockOf() so buckets match the sim. */
export function gameDay(gameMin: number): number {
  return Math.floor(Math.max(0, gameMin) / 1440) + 1;
}
/** minute-of-day [0,1440) of an absolute game-minute. */
export function minuteOfDay(gameMin: number): number {
  return ((Math.floor(Math.max(0, gameMin)) % 1440) + 1440) % 1440;
}

/** Is (x,y) inside (or on the door of) this building's footprint? */
export function pointInBuilding(x: number, y: number, b: Building): boolean {
  const inFoot = x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
  const onDoor = !!b.door && x === b.door.x && y === b.door.y;
  return inFoot || onDoor;
}

/** Resolve a position to a building id via footprints (the fallback when trace.perceived.shop is null). */
export function buildingAt(x: number | undefined, y: number | undefined, world: World): string | null {
  if (typeof x !== "number" || typeof y !== "number") return null;
  for (const b of world.buildings) if (pointInBuilding(x, y, b)) return b.id;
  return null;
}

/** The set of building-ids in the "top street" cluster — the main-square area (every shop door is on it). */
export function topStreetBuildings(world: World): Set<string> {
  const area = (world.areas ?? []).find((a) => a.id === "main-square");
  return new Set(area?.buildings ?? world.buildings.filter((b) => b.type === "shop").map((b) => b.id));
}

/** The north street + sidewalk rows the operator watches agents hug (street.rows[0..1] + sidewalks). */
function topStreetRows(world: World): Set<number> {
  const rows = new Set<number>();
  const s = world.street?.rows ?? [];
  // the NORTH corridor = the lower-y pair of street rows (the "top street"); guard for any ordering.
  if (s.length) {
    const north = [...s].sort((a, b) => a - b).slice(0, 2);
    for (const r of north) rows.add(r);
  }
  for (const r of world.sidewalks?.rows ?? []) if (r < (world.height >> 1)) rows.add(r);
  return rows;
}

// ───────────────────────── the per-tick position record (the M1/M2 spine) ─────────────────────────

type TickPos = {
  id: string;
  gameMin: number;
  day: number;
  building: string | null; // perceived.shop ?? buildingAt(at)
  x?: number;
  y?: number;
};

/** Project every trace line into a position record (the sim-resolved building + raw coords). */
function tickPositions(traces: TraceLine[], world: World): TickPos[] {
  const out: TickPos[] = [];
  for (const t of traces) {
    if (!t || typeof t.gameMin !== "number") continue;
    const at = t.perceived?.at;
    const building = t.perceived?.shop ?? buildingAt(at?.x, at?.y, world);
    out.push({ id: t.id, gameMin: t.gameMin, day: gameDay(t.gameMin), building, x: at?.x, y: at?.y });
  }
  return out;
}

// ───────────────────────── M1 · map utilization ─────────────────────────

function metricM1(pos: TickPos[], world: World): MetricResult {
  const totalBuildings = world.buildings.length; // 15
  const topSet = topStreetBuildings(world);
  const northRows = topStreetRows(world);

  // distinct buildings fleet-wide, per game-day
  const byDay = new Map<number, Set<string>>();
  // distinct buildings per agent (across the whole slice)
  const byAgent = new Map<string, Set<string>>();
  let topStreetTicks = 0;
  let locatedTicks = 0; // ticks where we know a position at all

  for (const p of pos) {
    if (p.building) {
      (byDay.get(p.day) ?? byDay.set(p.day, new Set()).get(p.day)!).add(p.building);
      (byAgent.get(p.id) ?? byAgent.set(p.id, new Set()).get(p.id)!).add(p.building);
    }
    // top-street tick = in a main-square building OR standing on the north street/sidewalk rows
    const onTopRow = typeof p.y === "number" && northRows.has(p.y);
    const inTopBldg = p.building != null && topSet.has(p.building);
    if (typeof p.y === "number" || p.building) {
      locatedTicks++;
      if (onTopRow || inTopBldg) topStreetTicks++;
    }
  }

  const distinctPerDay = [...byDay.entries()].map(([day, s]) => ({ day, distinct: s.size }));
  const bestDay = distinctPerDay.reduce((m, d) => Math.max(m, d.distinct), 0);
  const perAgentMin = byAgent.size ? Math.min(...[...byAgent.values()].map((s) => s.size)) : 0;
  const topStreetPct = locatedTicks ? topStreetTicks / locatedTicks : 0;

  // §3 targets: >=10/15 buildings/day · every agent >=3 · <40% top-street.
  const okBuildings = bestDay >= 10;
  const okPerAgent = byAgent.size > 0 && perAgentMin >= 3;
  const okTopStreet = locatedTicks > 0 && topStreetPct < 0.4;
  const grade: Grade =
    locatedTicks === 0 ? "na" : okBuildings && okPerAgent && okTopStreet ? "pass" : okBuildings || okPerAgent || okTopStreet ? "warn" : "fail";

  return {
    id: "M1",
    name: "Map utilization",
    grade,
    target: "≥10/15 buildings/day · every agent ≥3 · <40% top-street",
    value: `${bestDay}/${totalBuildings} bldgs · ≥${perAgentMin}/agent · ${(topStreetPct * 100).toFixed(0)}% top-st`,
    detail: {
      distinctBuildingsBestDay: bestDay,
      totalBuildings,
      distinctPerDay,
      perAgentDistinct: Object.fromEntries([...byAgent.entries()].map(([k, v]) => [k, v.size])),
      perAgentMin,
      topStreetPct: round(topStreetPct, 4),
      topStreetTicks,
      locatedTicks,
    },
  };
}

// ───────────────────────── M2 · schedule adherence ─────────────────────────

function metricM2(pos: TickPos[], cfg: RoleConfig): MetricResult {
  if (cfg.stepAt) return metricM2Schedule(pos, cfg, cfg.stepAt);
  const windowOf = (id: string) => cfg.workWindows[id] ?? cfg.defaultWindow; // PER-ROLE band, else the default
  // per agent: of its IN-WINDOW ticks (its OWN band), how many were AT its workplace? + distinct buildings
  // visited in-window (for the movement-graded roles like the courier).
  const stat = new Map<string, { atWork: number; window: number; workplace: string | null; seen: Set<string> }>();
  for (const p of pos) {
    const workplace = cfg.workplace[p.id];
    if (workplace === undefined) continue; // agent not in the role map at all
    const s = stat.get(p.id) ?? { atWork: 0, window: 0, workplace, seen: new Set<string>() };
    const { startMin, endMin } = windowOf(p.id);
    const mod = minuteOfDay(p.gameMin);
    if (mod >= startMin && mod < endMin) {
      s.window++;
      if (p.building) s.seen.add(p.building);
      if (workplace && p.building === workplace) s.atWork++;
    }
    stat.set(p.id, s);
  }

  const perRole: Record<string, { workplace: string | null; window: number; atWork: number; pct: number | null; distinctInWindow?: number; gradedOn: "at-workplace" | "movement" }> = {};
  const atWorkRatios: number[] = []; // only the SEATED roles feed the §3 "% at workplace" mean
  const movementNotes: string[] = []; // the courier-style roles, reported separately + flagged
  for (const [id, s] of stat) {
    const w = windowOf(id);
    const isMovement = cfg.movementRoles.has(id);
    if (isMovement) {
      // graded on movement: distinct buildings touched during its window (it's the M1 hero, not M2).
      perRole[id] = { workplace: s.workplace, window: s.window, atWork: s.atWork, pct: null, distinctInWindow: s.seen.size, gradedOn: "movement" };
      if (s.window > 0) movementNotes.push(`${id}: ${s.seen.size} distinct bldg in-window (${hhmm(w.startMin)}–${hhmm(w.endMin)}, ${s.window} ticks) — crisscross role, M2-exempt`);
      continue;
    }
    const pct = s.workplace == null ? null : s.window ? s.atWork / s.window : null;
    perRole[id] = { workplace: s.workplace, window: s.window, atWork: s.atWork, pct: pct == null ? null : round(pct, 4), gradedOn: "at-workplace" };
    if (pct != null && s.window > 0) atWorkRatios.push(pct);
  }

  // §3 target: >=60% of work-window ticks at workplace — over the SEATED roles only (movement roles excluded).
  // 60% (not 90%) is the right bar: the windows are generous + a brief lunch/coffee errand off-station is realistic.
  const graded = atWorkRatios.length;
  const meanPct = graded ? atWorkRatios.reduce((a, b) => a + b, 0) / graded : 0;
  const grade: Grade = graded === 0 ? "na" : meanPct >= 0.6 ? "pass" : meanPct >= 0.3 ? "warn" : "fail";

  const exempt = [...cfg.movementRoles].filter((id) => cfg.workplace[id] !== undefined);
  return {
    id: "M2",
    name: "Schedule adherence",
    grade,
    target: "≥60% of work-window ticks at workplace (per-role windows)",
    value: graded ? `mean ${(meanPct * 100).toFixed(0)}% over ${graded} seated role${graded === 1 ? "" : "s"}${exempt.length ? ` (+${exempt.length} crisscross-exempt)` : ""}` : "no in-window samples",
    detail: {
      perRoleWindows: Object.fromEntries(Object.keys(cfg.workplace).map((id) => [id, `${hhmm(windowOf(id).startMin)}–${hhmm(windowOf(id).endMin)}`])),
      meanPctAtWorkplace: round(meanPct, 4),
      gradedSeatedRoles: graded,
      movementExemptRoles: exempt, // e.g. courier — graded on M1 movement, NOT here (flagged, not a regression)
      movementNotes,
      perRole,
    },
  };
}

// M2 (schedule mode — T0, lifegiver's ask): grade every agent against the FULL-DAY schedule spine
// (citizens/schedules.ts stepAt): a tick is adherent when the agent is at the building its schedule names
// for that minute — so the courier's cross-town route and the baker's 13:00 grocer errand are ON-plan.
// ±GRACE_MIN absorbs block-boundary walks (13:00 baker mid-street to the grocer is not truancy). The
// movement exemption dissolves in this mode (the route IS the schedule). Sleep blocks are excluded from
// grading: citizens rarely tick while their schedule says sleep, and "was asleep at home" is not the
// operator's question.
const SCHEDULE_GRACE_MIN = 12;

function metricM2Schedule(pos: TickPos[], cfg: RoleConfig, stepAt: NonNullable<RoleConfig["stepAt"]>): MetricResult {
  const stat = new Map<string, { graded: number; at: number }>();
  for (const p of pos) {
    if (cfg.workplace[p.id] === undefined) continue; // not a graded roster member
    const mod = minuteOfDay(p.gameMin);
    const now = stepAt(p.id, mod);
    if (!now || now.kind === "sleep") continue;
    const s = stat.get(p.id) ?? { graded: 0, at: 0 };
    s.graded++;
    // adherent if at the CURRENT block's building, or the block ±grace (boundary transit)
    const candidates = [now, stepAt(p.id, (mod - SCHEDULE_GRACE_MIN + 1440) % 1440), stepAt(p.id, (mod + SCHEDULE_GRACE_MIN) % 1440)];
    if (p.building && candidates.some((b) => b && b.buildingId === p.building)) s.at++;
    stat.set(p.id, s);
  }
  const perRole: Record<string, { graded: number; atScheduled: number; pct: number | null; gradedOn: "schedule" }> = {};
  const ratios: number[] = [];
  for (const [id, s] of stat) {
    const pct = s.graded ? s.at / s.graded : null;
    perRole[id] = { graded: s.graded, atScheduled: s.at, pct: pct == null ? null : round(pct, 4), gradedOn: "schedule" };
    if (pct != null) ratios.push(pct);
  }
  const graded = ratios.length;
  const meanPct = graded ? ratios.reduce((a, b) => a + b, 0) / graded : 0;
  const grade: Grade = graded === 0 ? "na" : meanPct >= 0.6 ? "pass" : meanPct >= 0.3 ? "warn" : "fail";
  return {
    id: "M2",
    name: "Schedule adherence",
    grade,
    target: `≥60% of awake ticks at the SCHEDULED place (full-day spine, ±${SCHEDULE_GRACE_MIN}min transit grace)`,
    value: graded ? `mean ${(meanPct * 100).toFixed(0)}% over ${graded} role${graded === 1 ? "" : "s"} (vs schedule)` : "no gradable ticks",
    detail: {
      gradedAgainst: "citizens/schedules.ts stepAt (full-day blocks; errands/routes are on-plan; sleep excluded)",
      graceMin: SCHEDULE_GRACE_MIN,
      meanPctAtScheduled: round(meanPct, 4),
      gradedRoles: graded,
      perRole,
      note: "station-level adherence (expected station vs tape spot beats) is a T1 refinement once taped runs exist",
    },
  };
}

// ───────────────────────── M3 · real conversations (≥3-turn) ─────────────────────────

function metricM3(dialogues: DialogueLine[], agents: string[]): MetricResult {
  const real = dialogues.filter((d) => (d.turns ?? 0) >= 3);
  // per (agent, game-day) count of real convos; unique participant-pairs
  const perAgentDay = new Map<string, number>(); // `${id}|${day}`
  const pairs = new Set<string>();
  for (const d of real) {
    const day = gameDay(d.startedAtGameMin ?? 0);
    for (const p of d.participants ?? []) perAgentDay.set(`${p}|${day}`, (perAgentDay.get(`${p}|${day}`) ?? 0) + 1);
    const sorted = [...(d.participants ?? [])].sort();
    if (sorted.length >= 2) pairs.add(sorted.join("↔"));
  }
  // the §3 bar: >=1 real convo per agent per day. Measure the fraction of (agent,day) cells that clear it.
  const days = new Set(real.map((d) => gameDay(d.startedAtGameMin ?? 0)));
  const cells: Array<{ agent: string; day: number; convos: number }> = [];
  for (const a of agents) for (const day of days) cells.push({ agent: a, day, convos: perAgentDay.get(`${a}|${day}`) ?? 0 });
  const cleared = cells.filter((c) => c.convos >= 1).length;
  const cellPct = cells.length ? cleared / cells.length : 0;

  const grade: Grade = real.length === 0 ? "fail" : cellPct >= 0.8 ? "pass" : cellPct >= 0.4 ? "warn" : "fail";
  return {
    id: "M3",
    name: "Real conversations (≥3-turn)",
    grade,
    target: "≥1 real (≥3-turn) conversation per agent per day",
    value: `${real.length} real convo${real.length === 1 ? "" : "s"} · ${pairs.size} pair${pairs.size === 1 ? "" : "s"} · ${(cellPct * 100).toFixed(0)}% agent-days`,
    detail: {
      realConvos: real.length,
      uniquePairs: [...pairs],
      perAgentDay: Object.fromEntries(perAgentDay),
      agentDaysCleared: cleared,
      agentDaysTotal: cells.length,
      agentDayClearPct: round(cellPct, 4),
    },
  };
}

// ───────────────────────── M4 · two-way ratio (the #18 metric) ─────────────────────────

function metricM4(events: EventLine[], dialogues: DialogueLine[]): MetricResult {
  const says = events.filter((e) => e.kind === "say").length;
  const twoWay = dialogues.filter((d) => (d.turns ?? 0) >= 3).length;
  // ratio of one-shot says PER two-way dialogue (lower is better — baseline 644:26 ≈ 25:1).
  const saysPerDialogue = twoWay ? says / twoWay : says > 0 ? Infinity : 0;
  // grade: better than the 644:26≈24.8 baseline = pass; within 1.5× = warn; worse = fail.
  const baseline = 644 / 26; // ≈24.77
  const grade: Grade =
    twoWay === 0 && says === 0 ? "na" : twoWay === 0 ? "fail" : saysPerDialogue <= baseline ? "pass" : saysPerDialogue <= baseline * 1.5 ? "warn" : "fail";
  return {
    id: "M4",
    name: "Two-way ratio",
    grade,
    target: "say:dialogue ratio improving (baseline 644:26 ≈ 25:1)",
    value: twoWay ? `${says}:${twoWay} (${saysPerDialogue.toFixed(1)} says/convo)` : `${says}:0 (no two-way)`,
    detail: { says, twoWayDialogues: twoWay, saysPerDialogue: Number.isFinite(saysPerDialogue) ? round(saysPerDialogue, 2) : null, baselineSaysPerDialogue: round(baseline, 2), baseline: "644:26" },
  };
}

// ───────────────────────── M5 · relationships ─────────────────────────

function metricM5(relations: Record<string, RelationLine[]>): MetricResult {
  // reduce-by-last per (ego, other) — the file is append-only; the LAST line is the current edge state.
  const edges = new Map<string, RelationLine & { ego: string }>();
  for (const [ego, lines] of Object.entries(relations)) {
    for (const l of lines) edges.set(`${ego}->${l.other}`, { ...l, ego });
  }
  const egos = new Set(Object.keys(relations));
  const all = [...edges.values()];
  const formed = all.filter((e) => (e.familiarity ?? 0) > 0).length; // an edge that exists at all
  const strengthened = all.filter((e) => (e.dialogues ?? 0) >= 1).length; // backed by a real dialogue
  const n = egos.size; // possible directed pairs among known egos
  const possible = n > 1 ? n * (n - 1) : 0;
  const density = possible ? formed / possible : 0;

  // single-run snapshot can't show "grows" by itself → grade on density presence; the lead reads the
  // trend across two `grade` calls. >0.3 density = pass (a connected town), >0.1 = warn, else fail.
  const grade: Grade = all.length === 0 ? "fail" : density >= 0.3 ? "pass" : density >= 0.1 ? "warn" : "fail";
  return {
    id: "M5",
    name: "Relationships",
    grade,
    target: "graph density grows over a multi-day run",
    value: `${formed} edges · ${strengthened} w/ dialogue · density ${(density * 100).toFixed(0)}%`,
    detail: {
      edgesFormed: formed,
      edgesStrengthened: strengthened,
      knownEgos: n,
      possibleDirectedPairs: possible,
      density: round(density, 4),
      note: "single-run snapshot — run-over-run growth is read across two grade calls",
    },
  };
}

// ───────────────────────── M6 · role actions (located producer work) ─────────────────────────

// role → the verb(s) that count as that role's located work action (produce kinds + tool verbs if present).
const ROLE_WORK_VERBS: Record<string, string[]> = {
  baker: ["bake"],
  barista: ["brew"],
  grocer: ["restock", "stock"],
  smith: ["forge"],
  courier: ["deliver", "restock"],
  musician: ["busk", "play"],
  student: ["study"],
};

function metricM6(events: EventLine[], traces: TraceLine[], cfg: RoleConfig): MetricResult {
  // PRIMARY source: `produce` events (the trace actions[] accumulator is empty in current runs).
  // A produce by a producer counts as a located work action for its work-day.
  const producersWithWork = new Map<string, Set<number>>(); // actor → set of game-days with >=1 work action
  // produce events have no gameMin → bucket by the actor's nearest trace day is overkill; treat each
  // produce as "this run" and additionally credit per-day from any trace verbs.
  const produceByActor = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "produce") {
      produceByActor.set(e.actor, (produceByActor.get(e.actor) ?? 0) + 1);
      (producersWithWork.get(e.actor) ?? producersWithWork.set(e.actor, new Set()).get(e.actor)!).add(0);
    }
  }
  // SECONDARY: role verbs in trace actions[] (when populated) — located by being AT the workplace.
  for (const t of traces) {
    const verbs = ROLE_WORK_VERBS[t.id] ?? [];
    const did = (t.actions ?? []).some((a) => verbs.includes(a.tool));
    if (did) (producersWithWork.get(t.id) ?? producersWithWork.set(t.id, new Set()).get(t.id)!).add(gameDay(t.gameMin));
  }

  // the producers we expect to do located work = the roles in ROLE_WORK_VERBS that appear in the role map.
  const expected = Object.keys(cfg.workplace).filter((id) => ROLE_WORK_VERBS[id]);
  const withWork = expected.filter((id) => (producersWithWork.get(id)?.size ?? 0) > 0);
  const pct = expected.length ? withWork.length / expected.length : 0;
  const grade: Grade = expected.length === 0 ? "na" : pct >= 0.8 ? "pass" : pct >= 0.4 ? "warn" : "fail";

  return {
    id: "M6",
    name: "Role actions (located work)",
    grade,
    target: "each producer ≥1 located work action / work-day",
    value: `${withWork.length}/${expected.length} producers worked · ${[...produceByActor.values()].reduce((a, b) => a + b, 0)} produce events`,
    detail: {
      produceByActor: Object.fromEntries(produceByActor),
      producersThatWorked: withWork,
      expectedProducers: expected,
      pctProducersWorked: round(pct, 4),
      note: "primary source = produce events; trace actions[] verbs credited when populated",
    },
  };
}

// ───────────────────────── M7 · interiors (REAL — from flight-tape beats; T0-tape) ─────────────────────────
// Source of truth = the tape's enter/leave/spot beats (sim-derived, persisted per run). Without a tape
// (legacy runs) this is honestly N/A — interior presence was RAM-only before the tape existed, so there is
// nothing to grade from; the note says exactly which beat is missing (the brief's degrade rule).

export function metricM7(tape: TapeBeat[] | undefined, agents: string[]): MetricResult {
  if (!tape || tape.length === 0) {
    return {
      id: "M7",
      name: "Interiors occupancy",
      grade: "na",
      target: "interiors populated during the day; agents at seats/stations",
      value: "no flight tape",
      detail: { note: "needs tape beats enter/leave/spot (sim/flight-tape.ts) — legacy runs never persisted interior presence" },
    };
  }
  const enters = tape.filter((b) => b.kind === "enter");
  const spots = tape.filter((b) => b.kind === "spot");
  const buildings = new Set(enters.map((b) => String((b.data as { building?: unknown } | undefined)?.building ?? "")));
  buildings.delete("");
  const agentsEntered = new Set(enters.map((b) => b.actor).filter(Boolean));
  const agentsAtSpot = new Set(spots.map((b) => b.actor).filter(Boolean));
  // occupant-minutes: per agent, sum gm spans enter→leave (tape end closes an open span)
  const lastEnter = new Map<string, number>();
  let occupantMin = 0;
  let endGm = 0;
  for (const b of tape) {
    if (typeof b.gm === "number") endGm = Math.max(endGm, b.gm);
    if (!b.actor) continue;
    if (b.kind === "enter" && typeof b.gm === "number") lastEnter.set(b.actor, b.gm);
    else if (b.kind === "leave" && typeof b.gm === "number") {
      const e = lastEnter.get(b.actor);
      if (e != null) { occupantMin += Math.max(0, b.gm - e); lastEnter.delete(b.actor); }
    }
  }
  for (const [, e] of lastEnter) occupantMin += Math.max(0, endGm - e);
  const half = Math.max(1, Math.ceil(agents.length / 2));
  const grade: Grade =
    enters.length === 0 ? "fail"
    : buildings.size >= 4 && agentsAtSpot.size >= half && spots.length >= agents.length ? "pass"
    : buildings.size >= 2 || spots.length >= 2 ? "warn"
    : "fail";
  return {
    id: "M7",
    name: "Interiors occupancy",
    grade,
    target: `≥4 interiors used · ≥${half} agents take a seat/station · spot-takes ≥ ${agents.length}`,
    value: `${buildings.size} interiors · ${agentsEntered.size} entered · ${agentsAtSpot.size} at-spot · ${spots.length} spot-takes · ${Math.round(occupantMin)} occ-gm`,
    detail: {
      interiorsUsed: [...buildings],
      agentsEntered: [...agentsEntered],
      agentsAtSpot: [...agentsAtSpot],
      spotTakes: spots.length,
      occupantGameMinutes: Math.round(occupantMin),
    },
  };
}

// ───────────────────────── M9 · aliveness density (T0-tape; NEW) ─────────────────────────
// "Meaningful events per agent per game-hour" — the operator's boredom, quantified. Excludes heartbeat
// noise (online, pos/tick machinery) and DEDUPES the double-emit bug (same actor+kind ≤2s — audit §5) so
// the number can't be inflated by duplicate writes. Dialogues count once each (turns ≥1).

// Excluded from "meaningful": heartbeats/infra (online, run-*, usage-ish), per-tick EVALUATION beats the
// T0 peers route through /event (affordances menus, ignition passes, suppressed, warming), dysfunction
// markers (blocked, stuck — they are flags, not aliveness), and buy STAGE markers (attempt/402/settled —
// the OUTCOME kinds `purchase` and `buy-failed` are what count; buy-settled would double-count every
// success alongside its purchase record). Outcomes count; stages, evaluations, and heartbeats don't.
const M9_EXCLUDE = new Set([
  "online", "pos", "tick", "run-begin", "run-end", "run-pause", "run-resume", "run-reopen",
  "earshot", "nearby", "decision", "perceive", "usage",
  "affordances", "menu", "ignition", "suppressed", "warming", "blocked", "stuck",
  "buy-attempt", "buy-402", "buy-settled",
]);

export function metricM9(events: EventLine[], dialogues: DialogueLine[], agents: string[], gameSpanMin: number | undefined): MetricResult {
  // dedupe double-emits, then count meaningful world-visible beats
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const lastByActorKind = new Map<string, number>();
  let meaningful = 0;
  let deduped = 0;
  const byKind = new Map<string, number>();
  for (const e of sorted) {
    if (M9_EXCLUDE.has(e.kind)) continue;
    const t = Date.parse(e.ts ?? "");
    const k = `${e.actor}|${e.kind}`;
    const prev = lastByActorKind.get(k);
    if (Number.isFinite(t) && prev != null && t - prev <= 2000) { deduped++; continue; }
    if (Number.isFinite(t)) lastByActorKind.set(k, t);
    meaningful++;
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  }
  const convos = dialogues.filter((d) => (d.turns ?? 0) >= 1).length;
  meaningful += convos;
  if (convos) byKind.set("dialogue", convos);

  if (!agents.length || !gameSpanMin || gameSpanMin <= 0) {
    return {
      id: "M9",
      name: "Aliveness density",
      grade: "na",
      target: "≥6 meaningful events / agent / game-hour",
      value: `${meaningful} meaningful beats (span unknown)`,
      detail: { meaningful, dedupedDoubleEmits: deduped, byKind: Object.fromEntries(byKind), note: "no game-span (need a run manifest or traces with gameMin)" },
    };
  }
  const rate = meaningful / agents.length / (gameSpanMin / 60);
  const grade: Grade = rate >= 6 ? "pass" : rate >= 2 ? "warn" : "fail";
  return {
    id: "M9",
    name: "Aliveness density",
    grade,
    target: "≥6 meaningful events / agent / game-hour (excl. online/heartbeats; double-emits deduped)",
    value: `${rate.toFixed(2)} /agent/game-hour (${meaningful} beats · ${agents.length} agents · ${(gameSpanMin / 60).toFixed(1)} game-h)`,
    detail: {
      ratePerAgentPerGameHour: round(rate, 3),
      meaningful,
      dedupedDoubleEmits: deduped,
      gameSpanMin: Math.round(gameSpanMin),
      byKind: Object.fromEntries(byKind),
    },
  };
}

// ───────────────────────── M8 · on-chain (never regress) ─────────────────────────

function metricM8(events: EventLine[], baseline: number): MetricResult {
  const purchases = events.filter((e) => e.kind === "purchase");
  const count = purchases.length;
  const volume = purchases.reduce((sum, e) => {
    const p = Number(e.payload?.price_usdc);
    return sum + (Number.isFinite(p) ? p : 0);
  }, 0);
  const withTx = purchases.filter((e) => !!e.txHash).length;
  // non-regression is a RUN-OVER-RUN check; for a single slice we report the count + volume and compare
  // to the supplied baseline (the whole-history watermark by default). A slice naturally has fewer than
  // the all-time baseline, so we grade "did ANY settlement happen + are they on-chain" + surface the delta.
  const grade: Grade = count === 0 ? "fail" : withTx === count ? "pass" : "warn";
  return {
    id: "M8",
    name: "On-chain settlements",
    grade,
    target: `x402 volume does not regress (baseline ${baseline} settlements)`,
    value: `${withTx}/${count} on-chain · ${volume.toFixed(2)} USDC`,
    detail: { settlements: count, usdcVolume: round(volume, 4), onChain: withTx, baseline, note: "single-slice count; regression is judged run-over-run against the baseline" },
  };
}

// ───────────────────────── the pure entry point ─────────────────────────

/**
 * Compute the full M1-M8 scorecard from already-parsed logs. PURE: no fs, no Date-dependent logic except
 * stamping `generatedAt`, no LLM. Safe to call from a unit test with hand-built fixtures or from the live
 * `GET /telemetry` handler — same code, so the CLI and the endpoint can never disagree.
 */
export function computeTelemetry(input: TelemetryInput): Telemetry {
  const { events, dialogues, traces, relations, world, roleConfig } = input;
  const agents = [...new Set([...traces.map((t) => t.id), ...events.map((e) => e.actor)].filter(Boolean))].sort();
  const pos = tickPositions(traces, world);
  const days = [...new Set([...traces.map((t) => gameDay(t.gameMin)), ...dialogues.map((d) => gameDay(d.startedAtGameMin ?? 0))])].sort((a, b) => a - b);

  // T0-tape: game-span for M9 — supplied (run manifest) or observed from the slice's traces.
  const gms = traces.map((t) => t.gameMin).filter((g): g is number => typeof g === "number");
  const observedSpan = gms.length >= 2 ? Math.max(...gms) - Math.min(...gms) : undefined;
  const gameSpanMin = input.gameSpanMin ?? observedSpan;

  const metrics: MetricResult[] = [
    metricM1(pos, world),
    metricM2(pos, roleConfig),
    metricM3(dialogues, agents),
    metricM4(events, dialogues),
    metricM5(relations),
    metricM6(events, traces, roleConfig),
    metricM7(input.tape, agents),
    metricM8(events, input.settlementBaseline ?? 1164),
    metricM9(events, dialogues, agents, gameSpanMin),
  ];

  // the verdict counts greens across M1-M9 (na does not count as green). The behavior layer is M1-M6.
  const greenCount = metrics.filter((m) => m.grade === "pass").length;
  return {
    generatedAt: new Date().toISOString(),
    slice: {
      sinceTs: input.slice?.sinceTs,
      label: input.slice?.label,
      events: events.length,
      traces: traces.length,
      dialogues: dialogues.length,
      agents,
    },
    gameDays: days,
    roleMap: roleConfig.workplace,
    roleConfigWarnings: validateRoleConfig(roleConfig),
    metrics,
    greenCount,
    verdict: `Is it alive? — ${greenCount}/9 green`,
  };
}

// ═════════════════════════ /agent/:id/activity — the B5 Activity-tab CONTRACT ═════════════════════════
// The in-GUI tmux stream of an agent's thoughts/tools/actions (Pillar IV). scenewright's B5 tab consumes
// THIS shape. We merge the structured per-tick TRACE (thought + result + position) with the world-visible
// EVENTS (move/say/purchase/produce/give/…), newest-first. Pure over already-parsed inputs (testable);
// the fs reader `loadAgentActivity` feeds it from disk.
//
// RESPONSE SHAPE (stable contract — document in the B5 brief):
//   GET /agent/:id/activity?recent=N  ->
//   {
//     id: string,
//     count: number,                       // items returned (<= recent)
//     items: ActivityItem[]                // NEWEST FIRST
//   }
//   ActivityItem = {
//     ts: string,                          // wall-clock ISO (sort key; always present)
//     gameMin?: number,                    // game-minute, when the source is a trace
//     gameClock?: {day,hh,mm},             // derived from gameMin, when present
//     kind: string,                        // "thought" | "tool" | "result" | move|say|purchase|produce|give|use|pick_up|drop|consume|online|decision
//     source: "trace" | "event",           // provenance
//     text: string,                        // human one-liner for the row
//     tool?: string,                       // for kind:"tool" — the world-tool name
//     toolInput?: unknown,                 // for kind:"tool" — the tool args
//     thought?: string,                    // for kind:"thought" — the ACT-turn reasoning
//     costUsd?: number,                    // for kind:"result" — the tick's notional burn (0 = zombie tell)
//     to?: string,                         // for say — recipient
//     item?: string, price_usdc?: number,  // for purchase — the good + price
//     txHash?: string,                     // for purchase — the on-chain settlement (clickable in B5)
//     emoji?: string, verb?: string,       // for status — the glyph (🥖) + action verb (bake); `text` is
//                                          //   ALREADY composed ("🥖 baking… @ bakery") so the client can render
//                                          //   it directly, OR use emoji/verb structurally.
//   }

export type ActivityItem = {
  ts: string;
  gameMin?: number;
  gameClock?: GameClock;
  kind: string;
  source: "trace" | "event";
  text: string;
  tool?: string;
  toolInput?: unknown;
  thought?: string;
  costUsd?: number;
  to?: string;
  item?: string;
  price_usdc?: number;
  txHash?: string;
  emoji?: string; // for kind:"status" — the visible-status glyph (🥖/🎸/…) behaviorist emits
  verb?: string; // for kind:"status" — the action verb (bake/busk/forge/…)
};

export type GameClock = { day: number; hh: number; mm: number };

function clockOf(gameMin: number): GameClock {
  const m = Math.max(0, Math.floor(gameMin));
  return { day: Math.floor(m / 1440) + 1, hh: Math.floor((m % 1440) / 60), mm: m % 60 };
}

/** Trim a long string to a tidy one-liner for an activity row. */
function oneline(s: string | undefined, max = 240): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * PURE merge of one agent's trace lines + event lines into a newest-first activity stream. A trace line
 * expands into up-to-3 items (a `thought` if it reasoned, a `tool` per action, a `result` health line);
 * an event line maps to one item. Sorted by `ts` desc (stable), capped at `recent`.
 */
export function agentActivity(id: string, traces: TraceLine[], events: EventLine[], recent = 50): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const t of traces) {
    if (t.id !== id) continue;
    const gc = typeof t.gameMin === "number" ? clockOf(t.gameMin) : undefined;
    const base = { ts: t.ts, gameMin: t.gameMin, gameClock: gc, source: "trace" as const };
    if (t.reasoning && t.reasoning.trim()) {
      items.push({ ...base, kind: "thought", text: oneline(t.reasoning), thought: oneline(t.reasoning, 1000) });
    }
    for (const a of t.actions ?? []) {
      items.push({ ...base, kind: "tool", text: `${a.tool}(${oneline(safeJson(a.input), 80)})`, tool: a.tool, toolInput: a.input });
    }
    if (t.result) {
      const ok = t.result.error == null;
      items.push({
        ...base,
        kind: "result",
        text: `${ok ? "✓" : "✗"} ${t.result.subtype} · ${t.result.num_turns} turn${t.result.num_turns === 1 ? "" : "s"} · $${(t.result.cost_usd ?? 0).toFixed(4)}${ok ? "" : ` · ${t.result.error}`}`,
        costUsd: t.result.cost_usd,
      });
    }
  }

  for (const e of events) {
    if (e.actor !== id) continue;
    const p = e.payload ?? {};
    items.push({
      ts: e.ts,
      kind: e.kind,
      source: "event",
      text: describeEvent(e),
      ...(e.kind === "say" ? { to: str(p.to) } : {}),
      ...(e.kind === "purchase" ? { item: str(p.item), price_usdc: num(p.price_usdc), txHash: e.txHash } : {}),
      ...(e.kind === "status" ? { emoji: str(p.emoji) || undefined, verb: str(p.verb) || undefined } : {}),
    });
  }

  // newest first; ts is ISO so lexical desc == chronological desc. Ties keep insertion order (stable sort).
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return items.slice(0, Math.max(0, recent));
}

/** A compact human description of a world event (the activity-row text for source:"event"). */
function describeEvent(e: EventLine): string {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "move": return `→ moves to ${str(p.to)}`;
    case "say": return `🗣 to ${str(p.to)}: "${oneline(str(p.text), 160)}"`;
    case "purchase": return `💸 buys ${str(p.item)} for $${num(p.price_usdc)} at ${str(p.shop)}${e.txHash ? " (on-chain)" : ""}`;
    case "produce": return `🛠 produces ${str(p.good)} (have ${num(p.have)})`;
    case "consume": return `🍽 consumes ${str(p.item)} (remaining ${num(p.remaining)})`;
    case "give": return `🎁 gives ${str(p.item)} to ${str(p.to)}`;
    case "pick_up": return `✋ picks up ${str(p.item)} at ${str(p.place)}`;
    case "drop": return `📦 drops ${str(p.item)} at ${str(p.place)}`;
    case "use": return `🔧 uses ${str(p.item)} (remaining ${num(p.remaining)})`;
    case "online": return `🟢 ${str(p.name) || e.actor} comes online`;
    case "decision": return `🧭 decides: ${oneline(str(p.reason), 160)}`;
    // visible-status (behaviorist's "🥖 baking…" — A1 status emit / B4): compose emoji + label (+ where),
    // so EVERY consumer gets the nice row (not the bare "status"). Falls back gracefully if a field is absent.
    case "status": {
      const label = oneline(str(p.text) || str(p.verb) || "working", 80);
      const emoji = str(p.emoji);
      const at = str(p.at);
      return `${emoji ? emoji + " " : ""}${label}${at ? ` @ ${at}` : ""}`;
    }
    default: return `${e.kind}`;
  }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * IMPURE fs reader for `agentActivity` — reads this agent's trace file + filters events.jsonl by actor.
 * Read-only; degrade-don't-die. (The `agents/<id>.log` human tee is intentionally NOT read here: the
 * trace+events merge is structured + reliable; the .log is a redundant text view the iTerm observer
 * already streams. If B5 later wants the raw text lines, add them as a `source:"log"` without changing
 * this contract.)
 */
export function loadAgentActivity(id: string, opts: { dataDir?: string; recent?: number } = {}): ActivityItem[] {
  const dir = opts.dataDir ?? DATA_DIR;
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const traces = readJsonl<TraceLine>(join(dir, "traces", `${safe}.jsonl`));
  const events = readJsonl<EventLine>(join(dir, "events.jsonl")).filter((e) => e.actor === id);
  return agentActivity(id, traces, events, opts.recent ?? 50);
}

// ───────────────────────── the thin fs loader (impure; keeps the core pure) ─────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url)); // sim/
const DATA_DIR = join(HERE, "data");

// The roster M2 grades. Stable: matches personas.ts keys + world.json ids + the 8 live actors.
const ROSTER = ["baker", "barista", "grocer", "courier", "smith", "student", "musician", "regular"];

const hr = (startHr: number, endHr: number) => ({ startMin: startHr * 60, endMin: endHr * 60 });

// Hardcoded fallbacks — used ONLY if behaviorist's building-map.ts can't be imported (keeps telemetry runnable
// standalone). Kept byte-identical to citizens/building-map.ts (workplace + WORK_WINDOW + DEFAULT_WINDOW).
const FALLBACK_WORKPLACE: Record<string, string | null> = {
  baker: "bakery", barista: "cafe", grocer: "grocer", courier: "depot", smith: "smithy",
  student: "college", musician: "pub", regular: "pub",
};
const FALLBACK_WINDOWS: Record<string, { startMin: number; endMin: number }> = {
  baker: hr(5, 15), barista: hr(7, 18), grocer: hr(6, 18), smith: hr(8, 18),
  courier: hr(8, 18), student: hr(9, 17), musician: hr(16, 23), regular: hr(18, 23),
};
const FALLBACK_DEFAULT_WINDOW = hr(8, 18); // matches building-map.ts DEFAULT_WINDOW [8,18]

// behaviorist's published building-map.ts surface (the SINGLE SOURCE for workplace + work-windows).
type BuildingMapModule = {
  buildingMapFor: (id: string) => { workId: string; homeId: string; hangoutId: string };
  workWindowFor?: (id: string) => [number, number]; // [startHr, endHr] — added for the B6 fix (may be absent in older trees)
};

/**
 * Resolve the role→workplace map AND per-role work-windows from ONE import of behaviorist's building-map.ts —
 * the SAME `buildingMapFor` the ACT prompt + planDay use AND the SAME `workWindowFor` the B6 "pull non-producers
 * to work" fix uses. So M2 grades against the EXACT map + windows the citizens execute (no drift, ever; a future
 * band tweak updates behavior + grader together). Async import keeps the dependency SOFT — a citizen-layer load
 * error never breaks grading; M2 falls back to the byte-identical local tables.
 */
export async function resolveRoleConfig(): Promise<Pick<RoleConfig, "workplace" | "workWindows" | "defaultWindow" | "stepAt">> {
  // T0: prefer lifegiver's schedule spine for M2 (grade vs the full-day schedule, not the flat workplace).
  // Soft import, same rule as building-map: a citizen-layer load error never breaks grading.
  let stepAt: RoleConfig["stepAt"];
  try {
    const sched = (await import("../citizens/schedules.js")) as { stepAt?: (id: string, minOfDay: number) => { buildingId: string; station?: string; kind?: string } | undefined };
    if (typeof sched.stepAt === "function") stepAt = sched.stepAt;
  } catch { /* schedules not present in this tree → legacy at-workplace grading */ }
  try {
    const mod = (await import("../citizens/building-map.js")) as BuildingMapModule;
    const workplace: Record<string, string | null> = {};
    const workWindows: Record<string, { startMin: number; endMin: number }> = {};
    for (const id of ROSTER) {
      try { workplace[id] = mod.buildingMapFor(id).workId; } catch { workplace[id] = FALLBACK_WORKPLACE[id] ?? null; }
      // workWindowFor is the B6-era export; if an older tree lacks it, fall back to the matched local band.
      if (typeof mod.workWindowFor === "function") {
        try { const [s, e] = mod.workWindowFor(id); workWindows[id] = hr(s, e); } catch { workWindows[id] = FALLBACK_WINDOWS[id] ?? FALLBACK_DEFAULT_WINDOW; }
      } else {
        workWindows[id] = FALLBACK_WINDOWS[id] ?? FALLBACK_DEFAULT_WINDOW;
      }
    }
    return { workplace, workWindows, defaultWindow: FALLBACK_DEFAULT_WINDOW, stepAt };
  } catch {
    return { workplace: { ...FALLBACK_WORKPLACE }, workWindows: { ...FALLBACK_WINDOWS }, defaultWindow: FALLBACK_DEFAULT_WINDOW, stepAt };
  }
}

/** @deprecated kept for callers that only want the workplace map — prefer resolveRoleConfig(). */
export async function resolveWorkplaceMap(): Promise<Record<string, string | null>> {
  return (await resolveRoleConfig()).workplace;
}

// DATA-DRIVEN where a source exists; SINGLE-SOURCE where one doesn't (anti-drift, per the lead's note):
//   • workplace  → IMPORTED from behaviorist's buildingMapFor (building-map.ts) — NOT a hand-table. The same
//                  resolver the citizens execute, so what we grade == where they go. Zero drift by construction.
//   • workWindows→ IMPORTED from behaviorist's `workWindowFor` (building-map.ts) — the SAME bands the B6 fix
//                  uses to pull non-producers to work during their window. One source ⇒ a future band tweak
//                  updates the agent behavior AND this grader together (no silent divergence). Falls back to a
//                  byte-identical local table (FALLBACK_WINDOWS) only if the import fails. behaviorist derived
//                  the bands from each persona's PROSE routine; that derivation now lives in code, not here.
//   • movementRoles → MINE (a grading-only concern, correctly NOT in building-map): the courier is graded on M1
//                  movement, not "% at workplace" (his depot is a base, not a seat — behaviorist's caveat).
//   • a runtime GUARD (validateRoleConfig, surfaced in the scorecard header) catches the real drift mode:
//                  a role whose window/movement entry no longer matches the resolved workplace map.

/**
 * Default role config (D-A2-4). workplace + workWindows + defaultWindow are RESOLVED from behaviorist's
 * building-map.ts in one import (so the grader == the citizens, by construction); movementRoles is mine.
 * Built at module init via top-level await (NodeNext ESM) so the const is ready for synchronous consumers.
 */
export const DEFAULT_ROLE_CONFIG: RoleConfig = {
  ...(await resolveRoleConfig()), // { workplace, workWindows, defaultWindow } — single source = building-map.ts
  movementRoles: new Set(["courier"]), // crisscrosses town delivering — the M1 hero, M2-exempt (behaviorist's caveat)
};

/**
 * Consistency guard (anti-drift): returns human warnings if the role config has drifted out of sync with the
 * resolved workplace map — a window/movement entry for a role NOT in the workplace map, or a workplace role
 * with NO window (falls back to defaultWindow, which may mis-grade a night-owl). Surfaced in the scorecard
 * header so drift is visible the moment behaviorist renames a role in building-map.ts without telling the band
 * table. Empty array = in sync.
 */
export function validateRoleConfig(cfg: RoleConfig): string[] {
  const warnings: string[] = [];
  const workplaceRoles = new Set(Object.keys(cfg.workplace));
  for (const id of Object.keys(cfg.workWindows)) {
    if (!workplaceRoles.has(id)) warnings.push(`workWindows has "${id}" but it's not in the workplace map (drift?)`);
  }
  for (const id of cfg.movementRoles) {
    if (!workplaceRoles.has(id)) warnings.push(`movementRoles has "${id}" but it's not in the workplace map (drift?)`);
  }
  for (const id of workplaceRoles) {
    if (cfg.workplace[id] && !cfg.workWindows[id] && !cfg.movementRoles.has(id)) {
      warnings.push(`role "${id}" has a workplace but no work-window — using defaultWindow ${hhmm(cfg.defaultWindow.startMin)}–${hhmm(cfg.defaultWindow.endMin)} (may mis-grade)`);
    }
  }
  return warnings;
}

/** Parse a .jsonl file into typed lines, skipping blanks + malformed lines (degrade-don't-die). */
export function readJsonl<T>(file: string, onSkip?: (lineNo: number, raw: string) => void): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as T);
    } catch {
      onSkip?.(i + 1, raw);
    }
  }
  return out;
}

export type LoadOptions = {
  dataDir?: string;
  /** keep only events/traces/dialogues at-or-after this wall-clock ISO (run selection). */
  sinceTs?: string;
  /** keep only events/traces at-or-before this wall-clock ISO (run selection upper bound). */
  untilTs?: string;
  /** keep only the last N events (and the traces/dialogues whose ts falls in that window). */
  lastN?: number;
  /** T0-tape: grade ONE recorded run — "latest" or a run id from sim/data/runs/. Sets the ts window from
   *  the run's manifest, loads its tape (M7), and derives the game-span (M9). Overrides since/until/lastN. */
  runId?: string;
  roleConfig?: RoleConfig;
  settlementBaseline?: number;
  /** counters for skipped malformed lines (observability — silent data loss is a bug). */
  onSkip?: (file: string, lineNo: number) => void;
};

/**
 * Read the live sim/data logs into a TelemetryInput. IMPURE (fs) — the only place telemetry touches disk,
 * read-only. Selection: `sinceTs` (>= ISO) and/or `lastN` (tail of events.jsonl, then traces/dialogues are
 * filtered to that wall-clock window). World comes from sim/world.json.
 */
export function loadTelemetryInput(opts: LoadOptions = {}): TelemetryInput {
  const dir = opts.dataDir ?? DATA_DIR;
  const skip = (file: string) => (lineNo: number) => opts.onSkip?.(file, lineNo);

  const allEvents = readJsonl<EventLine>(join(dir, "events.jsonl"), skip("events.jsonl"));
  const allDialogues = readJsonl<DialogueLine>(join(dir, "dialogue.jsonl"), skip("dialogue.jsonl"));

  // traces: one file per agent under data/traces/
  const traceDir = join(dir, "traces");
  let allTraces: TraceLine[] = [];
  if (existsSync(traceDir)) {
    for (const f of readdirSync(traceDir)) {
      if (!f.endsWith(".jsonl")) continue;
      allTraces = allTraces.concat(readJsonl<TraceLine>(join(traceDir, f), skip(`traces/${f}`)));
    }
  }

  // relationships: one file per ego under data/relationships/
  const relDir = join(dir, "relationships");
  const relations: Record<string, RelationLine[]> = {};
  if (existsSync(relDir)) {
    for (const f of readdirSync(relDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const ego = basename(f, ".jsonl");
      relations[ego] = readJsonl<RelationLine>(join(relDir, f), skip(`relationships/${f}`));
    }
  }

  const world = JSON.parse(readFileSync(join(HERE, "world.json"), "utf8")) as World;

  // ---- run selection ----
  let events = allEvents;
  let sinceTs = opts.sinceTs;
  let untilTs = opts.untilTs;
  let label: string | undefined;
  let tape: TapeBeat[] | undefined;
  let gameSpanMin: number | undefined;
  let manifest: RunManifest | null = null;

  // T0-tape: a runId resolves to the manifest's wall-clock window + its tape (the honest per-run slice).
  if (opts.runId) {
    const runsDir = join(dir, "runs");
    const ids = listRunIds(runsDir);
    const id = opts.runId === "latest" ? ids[ids.length - 1] : opts.runId;
    manifest = id ? readManifest(runsDir, id) : null;
    if (manifest) {
      sinceTs = manifest.startedTs;
      untilTs = manifest.endedTs ?? undefined;
      label = `run ${manifest.runId}`;
      tape = readJsonl<TapeBeat>(join(runsDir, manifest.runId, "tape.jsonl"), skip(`runs/${manifest.runId}/tape.jsonl`));
      if (typeof manifest.endedGameMin === "number") gameSpanMin = manifest.endedGameMin - manifest.startedGameMin;
    } else {
      label = `run ${opts.runId} (NOT FOUND — grading whole log)`;
    }
  }

  if (opts.lastN && opts.lastN > 0 && allEvents.length > opts.lastN && !manifest) {
    events = allEvents.slice(-opts.lastN);
    sinceTs = events[0]?.ts ?? sinceTs; // window starts at the first kept event
  }
  if (sinceTs) {
    const since = sinceTs;
    events = events.filter((e) => (e.ts ?? "") >= since);
  }
  if (untilTs) {
    const until = untilTs;
    events = events.filter((e) => (e.ts ?? "") <= until);
  }
  // traces windowed by ts like events. Dialogues: the LEGACY format has no ts (only startedAtGameMin, and
  // game-minute epochs can OVERLAP across clock resets (found in a 2026-07-18 flight-tape audit)
  // §2), so: with a run manifest we window by the manifest's own game-clock bounds (single epoch → valid);
  // a new-format line that carries `ts` is windowed by wall-clock; otherwise dialogues are graded whole.
  let traces = allTraces;
  if (sinceTs) {
    const since = sinceTs;
    traces = traces.filter((t) => (t.ts ?? "") >= since);
  }
  if (untilTs) {
    const until = untilTs;
    traces = traces.filter((t) => (t.ts ?? "") <= until);
  }
  let dialogues = allDialogues;
  if (manifest) {
    const g0 = manifest.startedGameMin - 5;
    const g1 = (manifest.endedGameMin ?? Number.POSITIVE_INFINITY) + 5;
    dialogues = allDialogues.filter((d) => {
      const ts = (d as { ts?: string }).ts;
      if (ts) return (!sinceTs || ts >= sinceTs) && (!untilTs || ts <= untilTs);
      return typeof d.startedAtGameMin === "number" && d.startedAtGameMin >= g0 && d.startedAtGameMin <= g1;
    });
  }

  return {
    events,
    dialogues,
    traces,
    relations,
    world,
    roleConfig: opts.roleConfig ?? DEFAULT_ROLE_CONFIG,
    settlementBaseline: opts.settlementBaseline,
    tape,
    gameSpanMin,
    slice: { sinceTs, label: label ?? (opts.lastN ? `last ${opts.lastN} events` : opts.sinceTs ? `since ${opts.sinceTs}` : "whole log") },
  };
}

// ───────────────────────── tiny formatting helpers ─────────────────────────

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : 0;
}
function hhmm(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ───────────────────────── inline self-test (tsx sim/telemetry.ts) ─────────────────────────
// Runs ONLY when executed directly (not on import). Builds fixtures, asserts the pure core, exits non-zero
// on failure. Keeps telemetry.ts unit-testable without a running sim (the brief's requirement).
// ESM main-detection: compare this module's path to argv[1] (tsx passes the script path through). resolve()
// argv[1] so a relative invocation (`tsx sim/telemetry.ts`) still matches the absolute import.meta.url path.

const RUN_SELFTEST = (() => {
  try {
    const entry = process.argv[1];
    return !!entry && fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
})();

if (RUN_SELFTEST) runSelfTest();

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ❌ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✅ ${msg}`);
}

function runSelfTest(): void {
  console.log("telemetry.ts self-test (pure core, fixtures)\n");
  const world: World = {
    width: 64,
    height: 38,
    street: { rows: [9, 10, 27, 28] },
    sidewalks: { rows: [8, 11, 26, 29] },
    areas: [
      { id: "main-square", buildings: ["cafe", "bakery"] },
      { id: "oak-hill", buildings: ["college"] },
    ],
    buildings: [
      { id: "cafe", type: "shop", area: "main-square", x: 2, y: 2, w: 7, h: 6, door: { x: 5, y: 8 } },
      { id: "bakery", type: "shop", area: "main-square", x: 37, y: 2, w: 7, h: 6, door: { x: 40, y: 8 } },
      { id: "college", type: "civic", area: "oak-hill", x: 2, y: 20, w: 11, h: 6, door: { x: 6, y: 26 } },
    ],
  };
  // geometry
  assert(pointInBuilding(3, 3, world.buildings[0]), "pointInBuilding: inside cafe footprint");
  assert(pointInBuilding(5, 8, world.buildings[0]), "pointInBuilding: on cafe door");
  assert(!pointInBuilding(40, 8, world.buildings[0]), "pointInBuilding: bakery door not in cafe");
  assert(buildingAt(40, 8, world) === "bakery", "buildingAt: resolves bakery door");
  assert(gameDay(1440) === 2 && gameDay(0) === 1, "gameDay matches run-state clock");
  assert(minuteOfDay(1440 + 9 * 60) === 540, "minuteOfDay: day-2 09:00 → 540");
  assert(topStreetBuildings(world).has("cafe") && !topStreetBuildings(world).has("college"), "topStreet = main-square only");

  // a tiny run: baker at bakery in-window all 3 ticks; student at college; a 4-turn dialogue; 2 purchases.
  const traces: TraceLine[] = [
    tl("baker", 1, 8 * 60 + 30, "bakery", 40, 8),
    tl("baker", 2, 9 * 60, "bakery", 40, 8),
    tl("baker", 3, 9 * 60 + 30, "cafe", 5, 8), // strayed to cafe once
    tl("student", 1, 9 * 60, "college", 6, 26),
    tl("student", 2, 10 * 60, "college", 6, 26),
    // courier crisscrosses in-window (10:00–12:00, base window 08:00–18:00): depot → bakery → grocer.
    tl("courier", 1, 10 * 60, "depot", 27, 8),
    tl("courier", 2, 11 * 60, "bakery", 40, 8),
    tl("courier", 3, 12 * 60, "grocer", 15, 8),
  ];
  const dialogues: DialogueLine[] = [
    { id: "d1", participants: ["baker", "student"], startedAtGameMin: 9 * 60, turns: 4, outcome: "conversed", topic: "bread" },
    { id: "d2", participants: ["baker", "grocer"], startedAtGameMin: 9 * 60, turns: 0, outcome: "walk_by" },
  ];
  const events: EventLine[] = [
    ev("baker", "say", {}),
    ev("baker", "say", {}),
    ev("baker", "produce", { good: "bread", have: 1 }),
    ev("baker", "purchase", { price_usdc: 0.01, shop: "bakery" }, "0xabc"),
    ev("baker", "status", { text: "baking…", emoji: "🥖", verb: "bake", at: "bakery" }),
    ev("student", "purchase", { price_usdc: 0.02, shop: "cafe" }, "0xdef"),
  ];
  const relations: Record<string, RelationLine[]> = {
    baker: [rel("student", 5.8, 4), rel("student", 6.0, 5)], // append-only; last wins
    student: [rel("baker", 2.9, 2)],
  };
  // LEGACY-mode config (stepAt stripped): the at-workplace/movement-exempt fixture asserts below grade the
  // FALLBACK path, which must stay intact for trees without lifegiver's schedules.ts.
  const legacyCfg: RoleConfig = { ...DEFAULT_ROLE_CONFIG, stepAt: undefined };
  const t = computeTelemetry({ events, dialogues, traces, relations, world, roleConfig: legacyCfg });

  const m = (id: string) => t.metrics.find((x) => x.id === id)!;
  // all fixture ticks are day-1 (gameMin < 1440): bakery+cafe (baker) + college (student) + depot+grocer (courier) = 5.
  assert(m("M1").detail.distinctBuildingsBestDay === 5, "M1: best-day distinct buildings = 5 (bakery+cafe+college+depot+grocer, all day-1)");
  // M2: baker in-window(05-15) 3 ticks, at bakery 2/3 → 0.667; student(09-17) college 2/2 → 1.0; mean ≈ 0.83 → pass.
  // The courier is EXEMPT (movement-graded) so it does NOT drag the seated mean down despite 0/3 at depot.
  assert(m("M2").grade === "pass", `M2: seated-mean adherence passes (got ${m("M2").value})`);
  assert((m("M2").detail.perRole as any).baker.pct !== null, "M2: baker has a computed adherence pct");
  assert((m("M2").detail.perRole as any).courier.gradedOn === "movement" && (m("M2").detail.perRole as any).courier.pct === null, "M2: courier is movement-graded, not %-at-workplace");
  assert((m("M2").detail.perRole as any).courier.distinctInWindow === 3, "M2: courier credited 3 distinct buildings in-window");
  assert((m("M2").detail.movementExemptRoles as string[]).includes("courier"), "M2: courier listed as movement-exempt (flagged, not a regression)");
  assert((m("M2").detail.gradedSeatedRoles as number) === 2, "M2: only the 2 seated roles (baker, student) feed the mean");
  // per-role windows applied: baker's band is 05:00–15:00 (NOT the uniform 08–17 that would mis-grade pre-dawn).
  assert((m("M2").detail.perRoleWindows as any).baker === "05:00–15:00" && (m("M2").detail.perRoleWindows as any).musician === "16:00–23:00", "M2: per-role windows applied (baker pre-dawn, musician night)");
  // M2 SCHEDULE MODE (T0, lifegiver): grade vs a deterministic stub schedule — proves the courier's
  // cross-town route reads GREEN (it was movement-exempt/false-red before) and sleep blocks are excluded.
  const stubStep: RoleConfig["stepAt"] = (id, m) => {
    if (id === "baker") return m >= 300 && m < 900 ? { buildingId: "bakery", kind: "work" } : { buildingId: "home-baker", kind: "sleep" };
    if (id === "student") return m >= 540 && m < 1020 ? { buildingId: "college", kind: "work" } : { buildingId: "dorm", kind: "home" };
    if (id === "courier") {
      if (m >= 600 && m < 660) return { buildingId: "depot", kind: "work" };
      if (m >= 660 && m < 720) return { buildingId: "bakery", kind: "errand" };
      if (m >= 720 && m < 780) return { buildingId: "grocer", kind: "errand" };
      return { buildingId: "home-courier", kind: "home" };
    }
    return undefined;
  };
  const tracesSched = [...traces, tl("baker", 4, 100, "home-baker", 4, 12)]; // 01:40 — a SLEEP-block tick (must not be graded)
  const ts2 = computeTelemetry({ events, dialogues, traces: tracesSched, relations, world, roleConfig: { ...legacyCfg, stepAt: stubStep } });
  const m2s = ts2.metrics.find((x) => x.id === "M2")!;
  assert(m2s.grade === "pass" && (m2s.detail.gradedAgainst as string).includes("schedules"), `M2 schedule-mode: grades against the spine (${m2s.value})`);
  assert((m2s.detail.perRole as any).courier.pct === 1 && (m2s.detail.perRole as any).courier.gradedOn === "schedule", "M2 schedule-mode: the courier's cross-town ROUTE grades 100% ON-plan (the false-red fixed)");
  assert(Math.abs((m2s.detail.perRole as any).baker.pct - 2 / 3) < 0.01, "M2 schedule-mode: baker 2/3 (the cafe stray is off-plan)");
  assert((m2s.detail.perRole as any).baker.graded === 3, "M2 schedule-mode: the sleep-block tick is EXCLUDED from grading");

  // anti-drift guard: the default config is in sync (no warnings); a drifted config surfaces a warning.
  assert(validateRoleConfig(DEFAULT_ROLE_CONFIG).length === 0, "config guard: DEFAULT_ROLE_CONFIG is in sync (no drift warnings)");
  const drifted: RoleConfig = { workplace: { baker: "bakery" }, workWindows: { ghost: hr(1, 2) }, defaultWindow: hr(8, 17), movementRoles: new Set(["phantom"]) };
  assert(validateRoleConfig(drifted).length >= 2, "config guard: catches a windowed/movement role missing from the workplace map");
  assert(m("M3").detail.realConvos === 1, "M3: exactly 1 real (≥3-turn) conversation");
  assert((m("M4").detail.says as number) === 2 && (m("M4").detail.twoWayDialogues as number) === 1, "M4: 2 says : 1 two-way");
  assert(m("M5").detail.edgesFormed === 2, "M5: 2 directed edges (reduce-by-last, no double count)");
  assert((m("M5").detail.edgesStrengthened as number) === 2, "M5: both edges backed by a dialogue");
  assert((m("M6").detail.produceByActor as any).baker === 1, "M6: baker produced once");
  assert(m("M7").grade === "na", "M7: no tape in this fixture → honestly N/A (says which beat is missing)");
  assert(m("M8").detail.settlements === 2 && m("M8").grade === "pass", "M8: 2 on-chain settlements, all with txHash");
  // M9 (T0-tape): meaningful beats deduped (the 2 same-ms baker says collapse to 1) + dialogue counted once;
  // span observed from the fixture traces (510→720 gm = 3.5 game-h) → a low rate grades fail (the honest read).
  assert((m("M9").detail.dedupedDoubleEmits as number) === 1, "M9: double-emit dedupe collapses the same-actor same-second twin");
  assert((m("M9").detail.meaningful as number) === 6, `M9: 5 deduped events + 1 real dialogue = 6 meaningful (got ${m("M9").detail.meaningful})`);
  assert(m("M9").grade === "fail", `M9: 6 beats / 3 agents / 3.5 game-h < 2 → fail (got ${m("M9").value})`);
  assert(typeof t.verdict === "string" && t.verdict.includes("/9 green"), "verdict counts M1-M9");

  // M7 with a tape fixture: 2 interiors used, both agents take a spot, occupant-minutes summed enter→leave
  // (baker 510→600) + open-span-to-tape-end (student 520→600).
  const tb = (kind: string, actor: string, data: Record<string, unknown>, gm: number): TapeBeat =>
    ({ t: new Date(Date.UTC(2026, 5, 20, 0, 0, gm)).toISOString(), gm, run: "run-x", seq: 0, kind, actor, data });
  const tapeFx: TapeBeat[] = [
    tb("enter", "baker", { building: "bakery" }, 510),
    tb("spot", "baker", { building: "bakery", spot: "oven", ix: 9, iy: 2 }, 512),
    tb("enter", "student", { building: "college" }, 520),
    tb("spot", "student", { building: "college", spot: "study-desk-1", ix: 3, iy: 5 }, 521),
    tb("leave", "baker", { building: "bakery" }, 600),
  ];
  const m7 = metricM7(tapeFx, ["baker", "student"]);
  assert(m7.grade === "warn", `M7: 2 interiors + 2 at-spot grades warn (needs ≥4 interiors for pass; got ${m7.grade})`);
  assert((m7.detail.occupantGameMinutes as number) === 170, `M7: occupant-minutes = 90 (closed span) + 80 (open to tape end) = 170 (got ${m7.detail.occupantGameMinutes})`);
  assert(metricM7(tapeFx.filter((b) => b.kind === "leave"), ["baker"]).grade === "fail", "M7: a tape with zero enters grades fail");
  assert(metricM9([], [], [], undefined).grade === "na", "M9: no agents/span → honestly N/A");

  // agentActivity (the B5 contract): a trace with reasoning + a result → thought + result items; events
  // merge in; newest-first by ts.
  const act = agentActivity("baker", traces, events, 50);
  assert(act.length > 0, "agentActivity: produces items for baker");
  assert(act.every((i) => typeof i.ts === "string"), "agentActivity: every item has a ts");
  assert(act.some((i) => i.kind === "result" && typeof i.costUsd === "number"), "agentActivity: a result item carries costUsd");
  assert(act.some((i) => i.source === "event" && i.kind === "purchase" && i.txHash === "0xabc"), "agentActivity: baker's on-chain purchase surfaces with txHash");
  // status row composes the rich label (NOT bare "status") + surfaces emoji/verb structurally (scenewright's polish).
  const statusItem = act.find((i) => i.kind === "status");
  assert(!!statusItem && statusItem.text === "🥖 baking… @ bakery", `agentActivity: status row composes "🥖 baking… @ bakery" (got "${statusItem?.text}")`);
  assert(statusItem?.emoji === "🥖" && statusItem?.verb === "bake", "agentActivity: status row carries emoji+verb for structural consumers");
  for (let i = 1; i < act.length; i++) assert(act[i - 1].ts >= act[i].ts, "agentActivity: items are newest-first");
  // strictly the requested agent: baker's stream has no student-only purchase (price 0.02 at cafe).
  assert(!act.some((i) => i.kind === "purchase" && i.price_usdc === 0.02), "agentActivity: filtered to the requested agent (no other agent's events leak in)");
  const studentAct = agentActivity("student", traces, events, 50);
  assert(studentAct.some((i) => i.kind === "purchase" && i.txHash === "0xdef"), "agentActivity: student's own purchase surfaces");

  // degrade-don't-die: a malformed line is skipped, not thrown.
  const bad = readJsonl<EventLine>("/dev/null"); // missing/empty → []
  assert(Array.isArray(bad) && bad.length === 0, "readJsonl: missing/empty file → []");

  if (process.exitCode === 1) {
    console.log("\n❌ self-test FAILED");
  } else {
    console.log("\n✅ telemetry.ts self-test passed");
  }
}

// fixture builders (self-test only)
function tl(id: string, tick: number, gameMin: number, shop: string | null, x: number, y: number): TraceLine {
  return {
    ts: new Date(Date.UTC(2026, 5, 20, 0, tick)).toISOString(),
    id,
    tick,
    gameMin,
    perceived: { at: { x, y }, shop, adjacentTo: [] },
    retrieved: [],
    reasoning: "",
    actions: [],
    wrote: { observations: 0, reflections: 0 },
    result: { subtype: "success", cost_usd: 0.01, num_turns: 1, error: null },
  };
}
function ev(actor: string, kind: string, payload: Record<string, unknown>, txHash?: string): EventLine {
  return { ts: new Date().toISOString(), actor, kind, payload, ...(txHash ? { txHash } : {}) };
}
function rel(other: string, familiarity: number, dialogues: number): RelationLine {
  return { other, familiarity, dialogues, coPresences: 0, tradesAsBuyer: 0, tradesAsSeller: 0, usdcBought: 0, usdcSold: 0, firstSeenGameMin: 0, lastInteractionGameMin: 0, topics: [] };
}
