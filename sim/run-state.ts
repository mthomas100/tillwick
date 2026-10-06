// The sim's RUN-STATE machine — the single governor of whether the citizen fleet may spend tokens.
//
// This is the structural fix for INC-2026-06-18 (a 24/7 unattended citizen loop drained the subscription usage budget;
// closing the browser did NOT stop it). Here the SIM (the world authority, which never calls an LLM) owns
// a run-state that citizens MUST poll and gate on. Properties:
//   • pause-on-no-viewer  — 0 connected GUI viewers ⇒ paused ⇒ citizens stop querying (zero burn).
//   • resume-with-memory  — pause is not death; all state is durable, so reopening resumes the same town.
//   • mandatory duration  — a run cannot start without an explicit "run for how long?" choice; hard stop
//                           at the limit even while watched ("forever" is the deliberate, rare opt-out).
//   • fleet budget ceiling — a single cross-fleet API-equiv ceiling; crossing it stops the fleet.
//   • compressed game clock — advances only while running; persisted so pause/resume + restart continue it.
//
// The sim polls `tickAdvance()` each tick, citizens read `GET /run-state` and act only when runnable.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type RunStatus = "running" | "paused" | "stopped";
export type StopReason = "no-viewer" | "duration-elapsed" | "budget-ceiling" | "operator" | null;
export type Duration =
  | { kind: "minutes"; value: number }
  | { kind: "game-days"; value: number }
  | { kind: "forever"; value: null };
export type GameClock = { day: number; hh: number; mm: number };
export type RosterEntry = { id: string; name: string; enabled: boolean; model: string };

// Defaults are deliberately conservative — the incident proves an unbounded fleet is dangerous.
const CEILING_USD = Number(process.env.FLEET_CEILING_USD ?? 5); // hard fleet budget ceiling (API-equiv $)
// A1 (MAKE IT AWESOME, Pillar I): a ~20-MINUTE game-day so a bounded run actually sees the day turn — morning
// rush → afternoon → evening → home — instead of the paper's 24-min-per-day pace where a short run never leaves
// the morning. 1440 game-min / (20 real-min · 60 s) = 1.2 game-min per real-second. Single tunable constant
// (env-overridable for experiments); it is the ONLY day-length knob — it also feeds remainingMs()/tickAdvance(),
// so a faster clock correctly shortens "game-days" durations and lengthens schedule coverage within a fixed run.
const GAME_MIN_PER_REAL_SEC = Number(process.env.GAME_MIN_PER_REAL_SEC ?? 1.2);
const DAY_START_MIN = 8 * 60; // the world's clock begins at day 1, 08:00

type Persisted = {
  status: RunStatus;
  reason: StopReason;
  duration: Duration | null;
  elapsedMs: number; // accumulated RUNNING wall-ms (excludes paused time) for the current run
  gameMinutes: number; // absolute compressed game minutes since day-0 00:00
  runStartGameMinutes: number; // gameMinutes when the current run started (for game-days durations)
  fleetUsd: number; // cumulative API-equiv $ spent this run
};

function clockOf(gameMinutes: number): GameClock {
  const m = Math.max(0, Math.floor(gameMinutes));
  return { day: Math.floor(m / 1440) + 1, hh: Math.floor((m % 1440) / 60), mm: m % 60 };
}

export class RunState {
  status: RunStatus = "stopped";
  reason: StopReason = null;
  duration: Duration | null = null;
  viewers = 0;

  private elapsedMs = 0;
  private gameMinutes = DAY_START_MIN;
  private runStartGameMinutes = DAY_START_MIN;
  private fleetUsd = 0;
  private startedAtMs: number | null = null; // wall-clock ref for the current running stretch (not persisted)
  private file: string;
  private nowMs: () => number;

  constructor(file: string, nowMs: () => number = () => Date.now()) {
    this.file = file;
    this.nowMs = nowMs;
    this.load();
  }

  // ---- queries ----
  isRunnable(): boolean {
    return this.status === "running";
  }
  liveElapsedMs(): number {
    return this.elapsedMs + (this.status === "running" && this.startedAtMs != null ? this.nowMs() - this.startedAtMs : 0);
  }
  remainingMs(): number | null {
    if (!this.duration || this.duration.kind === "forever") return null;
    if (this.duration.kind === "minutes") return Math.max(0, this.duration.value * 60_000 - this.liveElapsedMs());
    // game-days → translate remaining game-minutes back to real-ms
    const elapsedGameDays = (this.gameMinutes - this.runStartGameMinutes) / 1440;
    const remGameMin = Math.max(0, (this.duration.value - elapsedGameDays) * 1440);
    return (remGameMin / GAME_MIN_PER_REAL_SEC) * 1000;
  }
  gameClock(): GameClock {
    return clockOf(this.gameMinutes);
  }
  ceilingUsd(): number {
    return CEILING_USD;
  }
  fleetSpentUsd(): number {
    return this.fleetUsd;
  }

  // ---- transitions (each persists) ----
  start(duration: Duration): void {
    this.duration = duration;
    this.status = "running";
    this.reason = null;
    this.elapsedMs = 0;
    this.fleetUsd = 0; // budget ceiling is per-run
    this.runStartGameMinutes = this.gameMinutes; // keep the world clock; reset the run baseline
    this.startedAtMs = this.nowMs();
    this.save();
  }
  setDuration(d: Duration): void {
    this.duration = d;
    this.save();
  }
  // T0-spine §4: jump the world clock FORWARD to the next hh:00 (never backwards — memories are stamped),
  // and move the run baseline with it so game-days durations measure from the jumped clock.
  jumpToHourOfDay(hh: number): void {
    const h = Math.min(23, Math.max(0, Math.floor(hh)));
    const day = Math.floor(this.gameMinutes / 1440);
    let target = day * 1440 + h * 60;
    if (target <= this.gameMinutes) target += 1440;
    this.gameMinutes = target;
    this.runStartGameMinutes = target;
    this.save();
  }
  pause(reason: StopReason): void {
    if (this.status !== "running") return;
    this.elapsedMs = this.liveElapsedMs();
    this.startedAtMs = null;
    this.status = "paused";
    this.reason = reason;
    this.save();
  }
  resume(): void {
    if (this.status !== "paused") return;
    this.status = "running";
    this.reason = null;
    this.startedAtMs = this.nowMs();
    this.save();
  }
  stop(reason: StopReason): void {
    if (this.status === "stopped") return;
    this.elapsedMs = this.liveElapsedMs();
    this.startedAtMs = null;
    this.status = "stopped";
    this.reason = reason;
    this.save();
  }

  // ---- viewer liveness (the core pause-on-no-viewer behaviour) ----
  onViewerChange(n: number): boolean {
    const prev = this.viewers;
    this.viewers = Math.max(0, n);
    if (this.viewers === 0 && this.status === "running") {
      this.pause("no-viewer"); // nobody watching ⇒ stop spending
      return true;
    }
    // hop back in: auto-resume ONLY if we paused *because* the viewer left (not operator/duration/budget)
    if (this.viewers > 0 && prev === 0 && this.status === "paused" && this.reason === "no-viewer") {
      this.resume();
      return true;
    }
    return false;
  }

  // ---- per-tick advance: bumps the game clock + enforces the duration limit. Returns true if status changed.
  tickAdvance(realMs: number): boolean {
    if (this.status !== "running") return false;
    this.gameMinutes += (realMs / 1000) * GAME_MIN_PER_REAL_SEC;
    if (this.duration && this.duration.kind === "minutes" && this.liveElapsedMs() >= this.duration.value * 60_000) {
      this.stop("duration-elapsed");
      return true;
    }
    if (this.duration && this.duration.kind === "game-days" && this.gameMinutes - this.runStartGameMinutes >= this.duration.value * 1440) {
      this.stop("duration-elapsed");
      return true;
    }
    // persist the clock occasionally (not every tick — it's only a clock); save() is cheap but be tidy
    if (Math.floor(this.gameMinutes) % 5 === 0) this.save();
    return false;
  }

  // ---- usage accounting + the fleet budget ceiling. Returns true if the ceiling tripped a stop.
  addUsage(apiEquivUsd: number): boolean {
    if (!Number.isFinite(apiEquivUsd) || apiEquivUsd <= 0) return false;
    this.fleetUsd += apiEquivUsd;
    if (this.fleetUsd >= CEILING_USD && this.status === "running") {
      this.stop("budget-ceiling");
      return true;
    }
    return false;
  }

  // ---- the GET /run-state payload (roster supplied by the sim) ----
  snapshot(roster: RosterEntry[]): Record<string, unknown> {
    return {
      status: this.status,
      reason: this.reason,
      duration: this.duration,
      elapsedMs: this.liveElapsedMs(),
      remainingMs: this.remainingMs(),
      gameClock: this.gameClock(),
      gameMinutes: Math.floor(this.gameMinutes), // raw game-minutes — drives cognition's nowGameMin()
      viewers: this.viewers,
      ceilingUsd: CEILING_USD,
      fleetUsd: this.fleetUsd,
      roster,
    };
  }

  // ---- durability: survive a sim restart (resume-with-memory). A restart has 0 viewers, so a
  //      persisted "running" must come back as paused(no-viewer) — never auto-resume spend on boot.
  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const p = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>;
      this.status = p.status === "running" ? "paused" : (p.status ?? "stopped");
      this.reason = p.status === "running" ? "no-viewer" : (p.reason ?? null);
      this.duration = p.duration ?? null;
      this.elapsedMs = p.elapsedMs ?? 0;
      this.gameMinutes = p.gameMinutes ?? DAY_START_MIN;
      this.runStartGameMinutes = p.runStartGameMinutes ?? this.gameMinutes;
      this.fleetUsd = p.fleetUsd ?? 0;
      this.startedAtMs = null;
    } catch {
      /* corrupt/missing → safe defaults (stopped) */
    }
  }
  private save(): void {
    const p: Persisted = {
      status: this.status,
      reason: this.reason,
      duration: this.duration,
      elapsedMs: this.status === "running" ? this.liveElapsedMs() : this.elapsedMs,
      gameMinutes: this.gameMinutes,
      runStartGameMinutes: this.runStartGameMinutes,
      fleetUsd: this.fleetUsd,
    };
    try {
      writeFileSync(this.file, JSON.stringify(p, null, 2));
    } catch {
      /* ignore disk errors — never let persistence crash the world authority */
    }
  }
}
