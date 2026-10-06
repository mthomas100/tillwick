import { MemoryStream, type MemoryObject } from "./memory-stream.js";
import { retrieve, type ScoredMemory } from "./retrieval.js";
import { shouldReflect, reflect } from "./reflection.js";
import { planDay, reactAndMaybeReplan, decompose } from "./planning.js";
import { buildSummary, needsRefresh, type AgentSummary } from "./summary.js";
import { scoreImportance } from "./importance.js";
import { type Complete } from "./llm.js";

// MIND — the per-agent COGNITIVE CYCLE (Park et al., Generative Agents, UIST '23): one object per citizen
// that composes the five merged modules (memory · retrieval · reflection · planning · summary · poignancy)
// into the loop the paper describes — perceive → remember → retrieve a working set → (periodically) reflect
// / plan / re-summarize → render context for the prompt → act. citizen.ts owns the ACT turn (the tool-using
// SDK query); Mind owns everything cognitive AROUND it and supersedes the ad-hoc recentDigest.
//
// SEAM DISCIPLINE (llm.ts, INC-2026-06-18): every model call goes through the INJECTED `Complete` — NO SDK
// import here; unit-tested with stubComplete at ZERO token spend. The real Claude-backed Complete is injected by
// the citizen runtime at wiring.
//
// DEGRADE-DON'T-DIE: every step is best-effort. A thrown/empty Complete, an embedding failure, a reflection
// hiccup — none throw into the tick; Mind just does less this tick (the repo rule: world-tools.ts getJson,
// run-state.ts best-effort writes). The ACT turn must always be reachable.

export type MindOpts = {
  agentId: string;
  persona: string; // the role/system text (drives the summary header + the situation query)
  traits?: string; // innate traits for the [Agent's Summary Description] header
  complete: Complete; // injected LLM seam (stubComplete in tests; claude-complete in prod)
  nowGameMin: () => number; // the sim game clock (game-minutes); Mind stamps memories with this
  dir?: string; // MemoryStream store dir override (tests/harness)
  // tunables (optional)
  retrieveK?: number; // working-set size for contextFor (default 12)
  reflectThreshold?: number; // summed-importance reflection trigger (default = reflection.ts's 150)
  summaryEveryGameMin?: number; // summary refresh cadence (default = summary.ts's 3 game-hours)
  /** T0 life-spine: a deterministic daily-agenda template (schedules.ts agendaLines). When set,
   *  ensureDailyPlan seeds TODAY's plan from these lines at ZERO token cost instead of the planDay LLM call
   *  (audit 2026-07-18: at 4-8 acted ticks/day, a vague generated plan burns the whole day; each planDay is
   *  a 10-35s CLI spawn). reactAndMaybeReplan still writes LLM plan lines ON TOP; currentStep prefers the
   *  newest line per time-slot, so a reaction overrides the template for the rest of its bracket. */
  planTemplate?: () => string[];
};

export class Mind {
  readonly stream: MemoryStream;
  private readonly complete: Complete;
  private readonly now: () => number;
  private readonly persona: string;
  private readonly traits?: string;
  private readonly retrieveK: number;
  private readonly reflectThreshold: number;
  private readonly summaryEveryGameMin?: number;
  private readonly planTemplate?: () => string[];

  private cachedSummary: AgentSummary | null = null;
  private lastPlanDay = -1; // game-day a daily plan was last generated for (-1 = never)
  private lastDecomposeHour = -1; // absolute game-hour decomposeCurrent last refined a chunk for (-1 = never)
  // The scored working-set from the MOST RECENT contextFor() retrieval, cached so the citizen loop can
  // record it in the per-tick trace (OBSERVABILITY §7) WITHOUT re-running retrieval (zero extra tokens) and
  // WITHOUT widening renderTick's {prompt, perceived} return. Read via lastRetrieved(); empty until the
  // first contextFor() / on a retrieval-degrade tick.
  private lastWorkingSet: ScoredMemory[] = [];

  constructor(opts: MindOpts) {
    this.stream = new MemoryStream(opts.agentId, {
      nowGameMin: opts.nowGameMin,
      ...(opts.dir ? { dir: opts.dir } : {}),
    });
    this.complete = opts.complete;
    this.now = opts.nowGameMin;
    this.persona = opts.persona;
    this.traits = opts.traits;
    this.retrieveK = opts.retrieveK ?? 12;
    this.reflectThreshold = opts.reflectThreshold ?? 150;
    this.summaryEveryGameMin = opts.summaryEveryGameMin;
    this.planTemplate = opts.planTemplate;
  }

  /**
   * Perceive → remember: store `text` as an observation. Poignancy comes from scoreImportance() (the paper's
   * LLM 1–10 prompt) unless an explicit `importance` is supplied. Returns the stored memory. Skips an exact
   * duplicate at the same game-minute so a stationary agent re-perceiving the same scene doesn't flood the
   * stream. Never throws (scoreImportance degrades to a low default).
   */
  async observe(text: string, opts?: { importance?: number }): Promise<MemoryObject> {
    const body = (text || "").trim();
    const at = this.now();
    if (body && this.isExactRecent(body, at)) {
      // return the existing duplicate rather than adding a second copy
      const dup = this.stream.recent(8).find((m) => m.createdAt === at && m.text === body);
      if (dup) return dup;
    }
    const importance = opts?.importance ?? (await scoreImportance(this.complete, body));
    return this.stream.add({ kind: "observation", text: body, importance, createdAt: at });
  }

  /**
   * Retrieve the working set relevant to `situation` and render it as a compact NL digest for the tick
   * prompt — the drop-in REPLACEMENT for recentDigest. Best-effort: a retrieval/embedding failure → a small
   * recency fallback so the prompt still has context.
   */
  async contextFor(situation: string, k?: number): Promise<string> {
    const at = this.now();
    const topK = k ?? this.retrieveK;
    try {
      const scored = await retrieve(this.stream, situation || this.persona, { k: topK, nowGameMin: at });
      this.lastWorkingSet = scored; // cache for lastRetrieved() (the per-tick trace) — same array, no re-retrieve
      if (scored.length === 0) return this.recencyFallback(topK);
      return scored.map((s) => `- ${s.memory.text}`).join("\n");
    } catch {
      this.lastWorkingSet = []; // retrieval degraded → don't let the trace report a stale set from last tick
      return this.recencyFallback(topK);
    }
  }

  /**
   * The scored working-set from the most recent contextFor() retrieval (recency·importance·relevance
   * breakdown per memory) — the citizen loop reads this to record WHY each memory surfaced in the per-tick
   * trace (OBSERVABILITY §7), with no extra retrieval. Returns a COPY so a caller can't mutate Mind state;
   * empty before the first contextFor() or after a retrieval-degrade tick.
   */
  lastRetrieved(): ScoredMemory[] {
    return this.lastWorkingSet.slice();
  }

  /**
   * The cached [Agent's Summary Description] block (paper App. A), rebuilt only when stale (needsRefresh).
   * Returns the rendered block text. Best-effort: on a build failure keeps the previous block (or, if never
   * built, a minimal header) so a prompt prefix is always available.
   */
  async summary(): Promise<string> {
    const at = this.now();
    if (needsRefresh(this.cachedSummary, at, this.summaryEveryGameMin)) {
      try {
        this.cachedSummary = await buildSummary(this.stream, this.complete, {
          name: this.persona,
          ...(this.traits ? { traits: this.traits } : {}),
          nowGameMin: at,
        });
      } catch {
        /* keep whatever we had (possibly null → fall through to the header below) */
      }
    }
    return this.cachedSummary?.text ?? this.persona;
  }

  /**
   * Ensure a broad-strokes daily plan exists for the current game-day (paper §4.3). Generates one once per
   * day (on rollover / first run), seeded by the agent summary (+ an optional previous-day summary). No-op
   * if today's plan already exists. Best-effort.
   */
  async ensureDailyPlan(opts?: { previousDaySummary?: string; buildings?: { workId: string; homeId: string; hangoutId: string } }): Promise<void> {
    const at = this.now();
    const day = Math.floor(at / 1440);
    if (day === this.lastPlanDay) return;
    this.lastPlanDay = day; // claim the day up-front so a failure doesn't retry every tick
    // T0 life-spine: TEMPLATE path — seed today's agenda from the deterministic schedule at zero token cost.
    // One parent memory (no leading time → invisible to currentStep) + each line citing it, so
    // decomposeCurrent's citations-guard sees the lines as already-fine and never re-decomposes the template.
    // Idempotent across a process restart: if today's stream already carries the template's first line, skip.
    const template = this.planTemplate?.() ?? [];
    if (template.length) {
      try {
        const dayStart = day * 1440;
        const already = this.stream
          .recent(200)
          .some((m) => m.kind === "plan" && m.createdAt >= dayStart && m.text === template[0]);
        if (!already) {
          const parent = this.stream.add({ kind: "plan", text: "Today's plan (daily routine):", createdAt: at, importance: 5 });
          for (const text of template) {
            this.stream.add({ kind: "plan", text, createdAt: at, importance: 6, citations: [parent.id] });
          }
        }
      } catch {
        /* degrade: an unseeded day falls back to the prompt's no-plan branch */
      }
      return; // the template IS today's plan; reactAndMaybeReplan still layers LLM lines on top
    }
    try {
      await planDay(this.stream, this.complete, {
        nowGameMin: at,
        agentSummary: this.cachedSummary?.text ?? this.persona,
        ...(opts?.previousDaySummary?.trim() ? { previousDaySummary: opts.previousDaySummary.trim() } : {}),
        // A1: feed the agent's REAL buildings (world.json-resolved) so the agenda names concrete move()-able ids.
        ...(opts?.buildings ? { buildings: opts.buildings } : {}),
      });
    } catch {
      /* degrade: no plan this day rather than crash */
    }
  }

  /**
   * THE CURRENT PLAN STEP (Wave A1 — the keystone wiring). Map "now" (game-minutes) to the agenda line the
   * agent should be executing: the most-recent kind:"plan" memory whose parsed start-time bracket contains
   * `nowGameMin` (line N starts at its time and runs until the NEXT line's time). This is what the daily plan
   * was FOR — it was generated each day (ensureDailyPlan/planDay) then thrown away at the ACT prompt (D23).
   * currentStep() is the missing reader that turns "7:00am — open the cafe" into a target the prompt can act on.
   *
   * Returns the chosen plan line's text + its parsed start-minute (minutes-since-midnight), or null when there
   * is no parseable plan yet. Considers only TODAY's plan lines (same game-day as now) so yesterday's agenda
   * doesn't leak in. Prefers finer decompose-children (citations set) when one brackets now, else the coarse
   * chunk. Tolerant + non-throwing (degrade-don't-die): an unparseable agenda → null, and the caller falls back.
   */
  currentStep(nowGameMin?: number): { text: string; startMin: number; minutesIn: number } | null {
    const at = nowGameMin ?? this.now();
    const dayStart = Math.floor(at / 1440) * 1440; // 00:00 of the current game-day, in absolute game-minutes
    const minOfDay = at - dayStart; // 0..1439
    // gather today's plan lines that carry a parseable clock time, newest-first (recent() is newest-first)
    type Step = { text: string; startMin: number; createdAt: number; fine: boolean };
    const steps: Step[] = [];
    for (const m of this.stream.recent(120)) {
      if (m.kind !== "plan") continue;
      if (m.createdAt < dayStart) continue; // not today's agenda
      const startMin = parsePlanTime(m.text);
      if (startMin == null) continue;
      steps.push({ text: m.text, startMin, createdAt: m.createdAt, fine: !!(m.citations && m.citations.length) });
    }
    if (steps.length === 0) return null;
    // de-dup by startMin: NEWEST createdAt wins (a react-replan or decompose child written later must
    // override an earlier line for the same slot — incl. the T0 schedule template, whose lines are seeded at
    // day-start and cite a parent); tie on createdAt → prefer the finer (decompose-child) line.
    const byStart = new Map<number, Step>();
    for (const s of steps) {
      const prev = byStart.get(s.startMin);
      if (!prev || s.createdAt > prev.createdAt || (s.createdAt === prev.createdAt && s.fine && !prev.fine)) byStart.set(s.startMin, s);
    }
    const ordered = Array.from(byStart.values()).sort((a, b) => a.startMin - b.startMin);
    // the current step = the last line whose startMin <= now (its bracket runs until the next line's time).
    let chosen: Step | null = null;
    for (const s of ordered) {
      if (s.startMin <= minOfDay) chosen = s;
      else break;
    }
    // before the first agenda line of the day (e.g. 6am when the plan starts 7am) → treat the first line as "next".
    if (!chosen) chosen = ordered[0];
    return { text: chosen.text, startMin: chosen.startMin, minutesIn: Math.max(0, minOfDay - chosen.startMin) };
  }

  /**
   * Refine the current near-future plan chunk into 15-min sub-steps AT MOST ONCE PER GAME-HOUR (the paper's
   * plan-JIT cadence — daily → hourly → 5–15 min, §4.3, not every tick). Wraps the raw decomposeCurrent() with
   * an absolute-game-hour gate so a stationary agent doesn't re-decompose every 8-second tick (token + stream
   * storm). Returns how many sub-steps were created this call (0 if already decomposed this hour, no plan yet,
   * or a model hiccup). Best-effort; the gate is claimed up-front so a failure doesn't retry every tick.
   */
  async decomposeCurrentHourly(granularityMin = 15): Promise<number> {
    const hour = Math.floor(this.now() / 60); // absolute game-hour since day-0 00:00
    if (hour === this.lastDecomposeHour) return 0;
    this.lastDecomposeHour = hour; // claim the hour up-front (degrade-don't-die: a throw won't re-storm)
    return this.decomposeCurrent(granularityMin);
  }

  /**
   * shouldReflect → reflect (paper §4.2). Fires when summed importance since the last reflection crosses the
   * threshold. Returns the number of reflections created (0 if not triggered or on failure). Best-effort.
   */
  async maybeReflect(): Promise<number> {
    const at = this.now();
    try {
      if (!shouldReflect(this.stream, { threshold: this.reflectThreshold })) return 0;
      const created = await reflect(this.stream, this.complete, { nowGameMin: at });
      return created.length;
    } catch {
      return 0;
    }
  }

  /**
   * React to a salient observation and re-plan from now if warranted (paper §4.3.1). Returns whether the
   * agent re-planned. Best-effort: a model hiccup → false (keeps the current plan).
   */
  async maybeReplan(observation: string): Promise<boolean> {
    const at = this.now();
    try {
      const r = await reactAndMaybeReplan(this.stream, this.complete, observation, {
        nowGameMin: at,
        agentSummary: this.cachedSummary?.text ?? this.persona,
      });
      return r.react === true;
    } catch {
      return false;
    }
  }

  /**
   * Lazily DECOMPOSE the current near-future plan chunk into 5–15-min sub-steps (paper §4.3 / Appx A: plan
   * JIT, not the whole day up front). Picks the most-recent kind:"plan" memory as "the chunk in play" and
   * breaks it finer via planning.ts decompose (children cite the parent → the plan tree). Returns how many
   * sub-steps were created (0 if there's no plan yet, the chunk is already fine-grained, or on a model
   * hiccup). Best-effort + METERED (planning.decompose uses this Mind's injected `complete`, the same
   * metered seam as maybeReplan/planDay, so the burn flows through the citizen's onCogUsage ceiling).
   */
  async decomposeCurrent(granularityMin = 15): Promise<number> {
    const at = this.now();
    try {
      // "the chunk in play" = the newest plan memory. recent() is newest-first; find the first kind:"plan".
      const recent = this.stream.recent(40);
      const chunk = recent.find((m) => m.kind === "plan");
      if (!chunk) return 0; // no daily plan yet (ensureDailyPlan hasn't produced one) → nothing to refine
      // Skip if it's ALREADY a decompose child (citations set) — its parent was the chunk; re-decomposing a
      // sub-step every tick would storm the stream. Only refine an as-yet-unbroken (top-level) plan chunk.
      if (chunk.citations && chunk.citations.length) return 0;
      const children = await decompose(chunk, this.stream, this.complete, { nowGameMin: at, granularityMin });
      return children.length;
    } catch {
      return 0; // degrade: keep the coarse plan rather than crash the tick
    }
  }

  /** Memory-stream size — handy for logging / the inspector. */
  size(): number {
    return this.stream.size();
  }

  // ---- internals -----------------------------------------------------------------------------------

  // Recency fallback for contextFor when retrieval yields nothing / fails: the n most-recent memories.
  private recencyFallback(n: number): string {
    const recent = this.stream.recent(n);
    return recent.length ? recent.map((m) => `- ${m.text}`).join("\n") : "(nothing comes to mind yet)";
  }

  // Has this exact text already been observed at this game-minute? (Cheap stationary-agent de-dup.)
  private isExactRecent(text: string, at: number): boolean {
    for (const m of this.stream.recent(8)) {
      if (m.createdAt === at && m.text === text) return true;
    }
    return false;
  }
}

/**
 * Parse the leading clock-time of a plan line into minutes-since-midnight (0..1439), or null if none. The
 * daily-plan prompt (planning.ts) asks the model to begin each agenda line with a time — "7:00am — wake up",
 * "14:00 — restock", "2:30 pm: read at the cafe". This reads only the LEADING time token (before the first
 * em-dash / hyphen / colon-separator), tolerating: 12h with am/pm, bare 24h "HH:MM", a bare hour "7am",
 * and the words "noon" / "midnight". Returns null for an unparseable / time-less line so currentStep() can
 * skip it. Exported for the unit self-test.
 */
export function parsePlanTime(line: string): number | null {
  const s = (line || "").trim().toLowerCase();
  if (!s) return null;
  // word times first (cheap + unambiguous)
  if (/^(?:12\s*)?noon\b/.test(s)) return 12 * 60;
  if (/^midnight\b/.test(s)) return 0;
  // HH(:MM)?(am|pm)? at the very start of the line (the agenda's "time —" prefix).
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  const mer = m[3];
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm > 59) return null;
  if (mer === "am") {
    if (hh === 12) hh = 0; // 12am = 00:00
  } else if (mer === "pm") {
    if (hh !== 12) hh += 12; // 12pm = noon stays 12
  }
  // a bare "14:00"/"21:30" with no meridiem is read as 24h; reject an impossible hour.
  if (hh > 23) return null;
  // Guard against matching a number that ISN'T a time (e.g. a line that happens to start with a quantity). If
  // there's no meridiem AND no minutes AND no time-ish separator following, it's too ambiguous → treat as none.
  if (!mer && !m[2] && !/^\d{1,2}\s*(?:[—\-:]|h\b|o'?clock)/.test(s)) return null;
  return hh * 60 + mm;
}

// ---- runnable self-test (ZERO tokens) -------------------------------------------------------------------
// `tsx cognition/mind.ts` exercises the A1 plan-reading wiring with stubComplete + a temp memory dir:
//   • parsePlanTime across the formats the model emits (am/pm, 24h, bare hour, noon/midnight, non-times)
//   • currentStep() picks the agenda line whose time bracket contains "now", ignores yesterday, degrades to null
//   • decomposeCurrentHourly() fires at most once per game-hour
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { stubComplete } = await import("./llm.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pjoin } = await import("node:path");
    const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`); };

    // --- parsePlanTime ---
    assert(parsePlanTime("7:00am — wake up and bake") === 7 * 60, "7:00am");
    assert(parsePlanTime("12:00pm — lunch") === 12 * 60, "12:00pm = noon");
    assert(parsePlanTime("12:30am — late night") === 30, "12:30am = 00:30");
    assert(parsePlanTime("2:30 pm: read at the cafe") === 14 * 60 + 30, "2:30 pm");
    assert(parsePlanTime("14:00 — restock the shelves") === 14 * 60, "bare 24h 14:00");
    assert(parsePlanTime("7am - open the cafe") === 7 * 60, "bare hour 7am");
    assert(parsePlanTime("9 o'clock — start work") === 9 * 60, "9 o'clock");
    assert(parsePlanTime("noon — meet at the square") === 12 * 60, "noon");
    assert(parsePlanTime("midnight — head home") === 0, "midnight");
    assert(parsePlanTime("Sell the morning's bread") === null, "no time → null");
    assert(parsePlanTime("3 loaves left to sell") === null, "leading quantity is NOT a time");
    assert(parsePlanTime("") === null, "empty → null");

    // --- currentStep: seed a day's agenda into a real stream, query "now" at various game-minutes ---
    const dir = mkdtempSync(pjoin(tmpdir(), "mind-currentstep-"));
    let gameMin = 0;
    const now = () => gameMin;
    const m = new Mind({ agentId: "tester", persona: "A test citizen.", complete: stubComplete("ok"), nowGameMin: now, dir });
    // Day 1 begins at absolute minute 1440 (day index 1). Add plan lines stamped within day 1.
    const day1Start = 1440;
    const plan = [
      "7:00am — open the cafe and brew the first pot",
      "9:00am — serve the morning rush",
      "1:00pm — restock beans in the back kitchen",
      "6:00pm — wind down and head home",
    ];
    for (const text of plan) m.stream.add({ kind: "plan", text, createdAt: day1Start, importance: 6 });

    const stepAt = (hh: number, mm = 0) => { gameMin = day1Start + hh * 60 + mm; return m.currentStep(); };
    assert(stepAt(8, 0)?.text.startsWith("7:00am"), "08:00 → the 7am step is current");
    assert(stepAt(12, 30)?.text.startsWith("9:00am"), "12:30 → the 9am step (until 1pm) is current");
    assert(stepAt(13, 1)?.text.startsWith("1:00pm"), "13:01 → the 1pm step is current");
    assert(stepAt(23, 0)?.text.startsWith("6:00pm"), "23:00 → the 6pm step is current");
    // before the first agenda line of the day → first line is surfaced as "next"
    assert(stepAt(6, 0)?.text.startsWith("7:00am"), "06:00 (pre-agenda) → first line surfaced");
    // minutesIn reflects how long into the bracket we are
    const s9 = stepAt(10, 0);
    assert(s9?.startMin === 9 * 60 && s9?.minutesIn === 60, "minutesIn = 60 at 10:00 within the 9am step");

    // yesterday's plan must NOT leak: a plan stamped on day 0 is ignored when now is day 1.
    const dir2 = mkdtempSync(pjoin(tmpdir(), "mind-currentstep2-"));
    let gm2 = 1440 + 9 * 60; // day 1, 09:00
    const m2 = new Mind({ agentId: "t2", persona: "x", complete: stubComplete("ok"), nowGameMin: () => gm2, dir: dir2 });
    m2.stream.add({ kind: "plan", text: "8:00am — yesterday's plan", createdAt: 8 * 60, importance: 6 }); // day 0
    assert(m2.currentStep() === null, "yesterday's plan does not leak into today → null");

    // decomposeCurrentHourly: with no plan it returns 0 but still CLAIMS the hour (one attempt/hour).
    const dir3 = mkdtempSync(pjoin(tmpdir(), "mind-decompose-"));
    let gm3 = 1440 + 9 * 60;
    const m3 = new Mind({ agentId: "t3", persona: "x", complete: stubComplete(""), nowGameMin: () => gm3, dir: dir3 });
    const a = await m3.decomposeCurrentHourly();
    const b = await m3.decomposeCurrentHourly(); // same hour → gated
    assert(a === 0 && b === 0, "no-plan decompose returns 0");
    gm3 += 60; // next game-hour → gate opens again (still 0 since no plan, but it ATTEMPTS)
    const c = await m3.decomposeCurrentHourly();
    assert(c === 0, "next hour attempt also 0 with no plan (gate opened, no crash)");

    console.log("mind.ts self-test: ALL ASSERTIONS PASSED (parsePlanTime · currentStep · decomposeCurrentHourly)");
  })().catch((err) => { console.error(err); process.exit(1); });
}
