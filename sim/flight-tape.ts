// sim/flight-tape.ts — the FLIGHT TAPE (T0-tape): one run-scoped, append-only record of every beat the
// world authority can see, located in BOTH coordinate spaces at the moment it happened.
//
// WHY (audit 2026-07-18, flightrecorder.md): the operator's screenshots showed sim state and rendered
// pixels disagreeing (baker "baking…" while standing in the doorway) and NOBODY could prove which layer
// lied — because interior presence, earshot delivery, walk paths and run identity lived only in RAM.
// events.jsonl beats carry no coordinates and no game-time; dialogue.jsonl carries no wall-clock; the
// game clock has been reset at least once, so gameMin alone cannot scope a run. This module fixes the
// class: every beat gets wall ts + gameMin + the actor's world tile AND interior position, and every
// run gets an id + a manifest with both clock epochs.
//
// SHAPE (mirrors the repo grain — plain JSONL, single writer = the sim, degrade-don't-die):
//   sim/data/runs/<runId>/tape.jsonl      one TapeBeat per line, append-only
//   sim/data/runs/<runId>/manifest.json   RunManifest (start/end in wall + game clock, roster, config)
//   sim/data/runs/_idle/tape.jsonl        beats that occur while NO run is active (manual pokes)
//
// The sim instantiates ONE FlightTape and calls it from 6 hook sites (see the hook-spec doc); citizens
// never touch this module. Everything here is fs + clock only — the sim never calls an LLM (invariant).
// Legacy writers (events.jsonl / dialogue.jsonl) are UNTOUCHED — the tape is additive.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- beat + manifest shapes (the PUBLISHED contract — replay-run.ts + telemetry M7/M9 read these) ----

/** Where an actor is at the moment of a beat. `x,y` are WORLD tiles; `building` is the world-tile
 *  building (door/inside tile) if standing on one; `inside` is interior presence: building id +
 *  INTERIOR-LOCAL coords + the sublocation id when seated/stationed. Both spaces recorded, always. */
export type TapeLoc = {
  x: number;
  y: number;
  building?: string | null;
  inside?: { b: string; ix: number; iy: number; spot?: string };
};

/** One line of tape.jsonl.
 *  INVARIANT (D32): every beat carries wall `t` AND game `gm` AND `run` — never rely on any one alone to
 *  scope (wall ts survives clock resets; gm survives wall skew; run is the only true partition key).
 *  `tid` is the CAUSAL JOIN KEY (D32): "<actor>:<tick>" for beats caused by a specific agent-tick —
 *  perceive → cognition (traces/*.jsonl, same id+tick) → choice → act → mutation join on (run, tid).
 *  Sim-derived beats not tied to a tick (pos steps, enter/leave from the tick loop) have no tid and join
 *  by (actor, time-adjacency) — that asynchrony is real, not a schema gap. */
export type TapeBeat = {
  t: string; // wall-clock ISO
  gm: number; // gameMinutes at emit (matches run-state.ts — never a second clock)
  run: string; // runId, or "_idle" between runs
  seq: number;
  kind: string; // run-begin|run-end|run-pause|run-resume|run-reopen|pos|path|enter|leave|spot|earshot|nearby|perceive|act-fail|custody|usage|<any /event kind incl. peers' menu/choice/suppressed/buy-*/gossip-passed>
  actor?: string;
  tid?: string; // "<actor>:<tick>" when the causing agent-tick is known (citizen passed `tick` in the request)
  at?: TapeLoc;
  data?: Record<string, unknown>;
};

export type RunManifest = {
  runId: string;
  startedTs: string;
  startedGameMin: number;
  duration?: unknown; // the Duration the run was started with (opaque here)
  roster?: unknown; // RosterEntry[] snapshot at start
  gameMinPerRealSec?: number;
  ceilingUsd?: number;
  endedTs?: string;
  endedGameMin?: number;
  endReason?: string | null; // duration-elapsed | operator | budget-ceiling | sim-restart | …
  beats?: number; // total beats written (stamped at end)
};

const IDLE = "_idle";

/** fs-safe, sortable run id from a start time: run-20260718-191641. */
export function makeRunId(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `run-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** List run ids under a runs dir, oldest→newest (lexical = chronological by construction). */
export function listRunIds(runsDir: string): string[] {
  try {
    return readdirSync(runsDir)
      .filter((f) => f.startsWith("run-") && existsSync(join(runsDir, f, "manifest.json")))
      .sort();
  } catch {
    return [];
  }
}

/** Read a run's manifest, or null. Degrade-don't-die (torn/absent → null). */
export function readManifest(runsDir: string, runId: string): RunManifest | null {
  try {
    return JSON.parse(readFileSync(join(runsDir, runId, "manifest.json"), "utf8")) as RunManifest;
  } catch {
    return null;
  }
}

export class FlightTape {
  private runsDir: string;
  private gmNow: () => number;
  private nowFn: () => Date;
  private currentRun: string = IDLE; // runId or "_idle"
  private seq = 0;
  private beatsInRun = 0;
  private lastStatus: string | null = null;

  /**
   * @param runsDir   sim/data/runs (created on demand)
   * @param gmNow     supplier of the CURRENT gameMinutes (the sim passes its existing nowGM)
   * @param opts.resumeOpenRun  if true and the newest manifest has no end stamp, REOPEN it (sim
   *        restarted mid-run and run-state persisted as paused — keep run continuity). If false,
   *        an open manifest is closed as endReason:"sim-restart" so no run dangles forever.
   */
  constructor(runsDir: string, gmNow: () => number, opts: { resumeOpenRun?: boolean; now?: () => Date } = {}) {
    this.runsDir = runsDir;
    this.gmNow = gmNow;
    this.nowFn = opts.now ?? (() => new Date());
    try {
      mkdirSync(runsDir, { recursive: true });
      const ids = listRunIds(runsDir);
      const last = ids[ids.length - 1];
      const m = last ? readManifest(runsDir, last) : null;
      if (m && !m.endedTs) {
        if (opts.resumeOpenRun) {
          this.currentRun = m.runId;
          this.seq = this.countLines(join(runsDir, m.runId, "tape.jsonl"));
          this.beatsInRun = this.seq;
          this.beat("run-reopen", undefined, undefined, { note: "sim restarted; run resumed from persisted run-state" });
        } else {
          m.endedTs = this.nowFn().toISOString();
          m.endedGameMin = round1(this.gmNow());
          m.endReason = "sim-restart";
          this.writeManifest(m);
        }
      }
    } catch {
      /* never let tape init crash the sim */
    }
  }

  /** Is a run segment currently open? (exposed for hooks/tests) */
  runId(): string {
    return this.currentRun;
  }

  /** Open a new run segment: dir + manifest + run-begin beat. Called from POST /control start. */
  beginRun(meta: { duration?: unknown; roster?: unknown; gameMinPerRealSec?: number; ceilingUsd?: number }): string {
    try {
      if (this.currentRun !== IDLE) this.endRun("superseded-by-new-start"); // a start while open closes the old one
      const now = this.nowFn();
      const id = makeRunId(now);
      mkdirSync(join(this.runsDir, id), { recursive: true });
      const m: RunManifest = {
        runId: id,
        startedTs: now.toISOString(),
        startedGameMin: round1(this.gmNow()),
        duration: meta.duration,
        roster: meta.roster,
        gameMinPerRealSec: meta.gameMinPerRealSec,
        ceilingUsd: meta.ceilingUsd,
      };
      this.writeManifest(m);
      this.currentRun = id;
      this.seq = 0;
      this.beatsInRun = 0;
      this.beat("run-begin", undefined, undefined, { duration: meta.duration });
      return id;
    } catch {
      return this.currentRun; // degrade: keep taping wherever we were
    }
  }

  /** Close the current run segment: run-end beat + manifest end stamps. Idempotent. */
  endRun(reason: string | null): void {
    if (this.currentRun === IDLE) return;
    try {
      this.beat("run-end", undefined, undefined, { reason });
      const m = readManifest(this.runsDir, this.currentRun);
      if (m) {
        m.endedTs = this.nowFn().toISOString();
        m.endedGameMin = round1(this.gmNow());
        m.endReason = reason;
        m.beats = this.beatsInRun;
        this.writeManifest(m);
      }
    } catch {
      /* swallow */
    }
    this.currentRun = IDLE;
    this.seq = this.countLines(join(this.runsDir, IDLE, "tape.jsonl"));
  }

  /**
   * Status-transition watcher — call ONCE per sim tick with runState.status/reason. Detects the stop
   * paths that never pass through /control (duration-elapsed inside tickAdvance, budget-ceiling inside
   * addUsage, pause-on-no-viewer) so the tape can't miss a run end. running→stopped closes the run;
   * pause/resume are marked as beats but do NOT end the segment (resume continues the same run).
   */
  syncStatus(status: string, reason: string | null): void {
    const prev = this.lastStatus;
    this.lastStatus = status;
    if (prev === null || prev === status) return;
    try {
      if (status === "stopped") this.endRun(reason);
      else if (status === "paused" && this.currentRun !== IDLE) this.beat("run-pause", undefined, undefined, { reason });
      else if (status === "running" && prev === "paused" && this.currentRun !== IDLE) this.beat("run-resume");
    } catch {
      /* swallow */
    }
  }

  /** The generic emit — every sugar method lands here. Append-only, sync, swallow-on-error.
   *  `tickId` (optional): the causal join key "<actor>:<tick>" when the causing tick is known. */
  beat(kind: string, actor?: string, at?: TapeLoc, data?: Record<string, unknown>, tickId?: string): void {
    try {
      const rec: TapeBeat = {
        t: this.nowFn().toISOString(),
        gm: round1(this.gmNow()),
        run: this.currentRun,
        seq: this.seq++,
        kind,
        ...(actor ? { actor } : {}),
        ...(tickId ? { tid: tickId } : {}),
        ...(at ? { at } : {}),
        ...(data && Object.keys(data).length ? { data } : {}),
      };
      const dir = join(this.runsDir, this.currentRun);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "tape.jsonl"), JSON.stringify(rec) + "\n");
      this.beatsInRun++;
    } catch {
      /* a tape write must NEVER throw into the sim tick */
    }
  }

  // ---- sugar for the hook sites (each is one line at the call site) ----

  /** Mirror of recordEvent(): every world event (say/status/produce/consume/purchase/give/… and peers'
   *  menu, choice, suppressed, buy-attempt/402/settled/failed, gossip-passed) lands on the tape too,
   *  enriched with the actor's location. Kind passes through unchanged (greppable). A `tick` (or legacy
   *  `turn`) field in the payload — the D32 citizen contract — is lifted into the causal join key. */
  event(e: { actor: string; kind: string; payload?: unknown; related_id?: string; txHash?: string }, at?: TapeLoc): void {
    const data: Record<string, unknown> = {};
    if (e.payload !== undefined) data.payload = e.payload;
    if (e.txHash) data.txHash = e.txHash;
    if (e.related_id) data.related_id = e.related_id;
    const tick = (e.payload as { tick?: unknown } | undefined)?.tick ?? (e.payload as { turn?: unknown } | undefined)?.turn;
    this.beat(e.kind, e.actor, at, data, typeof tick === "number" ? `${e.actor}:${tick}` : undefined);
  }

  /** D32 layer 4 — a FAILED or UNKNOWN /act, loud. The act-fallthrough trap (unknown actions silently
   *  no-op'ing) becomes a tape beat with the reason; silence is never unexplained again. */
  actFail(actor: string, at: TapeLoc | undefined, d: { action: string; reason: string; tick?: number }): void {
    this.beat("act-fail", actor, at, { action: d.action, reason: d.reason }, typeof d.tick === "number" ? `${actor}:${d.tick}` : undefined);
  }

  /** D32 layer 1 — what the agent PERCEIVED this tick: a digest (counts + salient ids) + a short hash of
   *  the full payload so any two layers can prove they saw the same thing. Full-payload taping is the
   *  caller's choice (env-gated in the hook) — the digest is always enough to join and usually to debug. */
  perceive(actor: string, at: TapeLoc | undefined, d: Record<string, unknown>, tick?: number): void {
    this.beat("perceive", actor, at, d, typeof tick === "number" ? `${actor}:${tick}` : undefined);
  }

  /** D32 layer 7 — a custody transition (item moved between agents), stamped with the settlement hash. */
  custody(d: { item: string; from?: string; to: string; txHash?: string; shop?: string }): void {
    this.beat("custody", d.to, undefined, d as unknown as Record<string, unknown>);
  }

  /** D32 layer 8 — per-tick usage/latency report (POST /usage mirror): the infra half of the chain. */
  usage(actor: string, d: Record<string, unknown>): void {
    const tick = (d as { tick?: unknown }).tick;
    this.beat("usage", actor, undefined, d, typeof tick === "number" ? `${actor}:${tick}` : undefined);
  }

  /** A world-tile step actually taken this tick (the walk path, tick-true). Emit only on movement. */
  pos(actor: string, at: TapeLoc, moving: boolean): void {
    this.beat("pos", actor, at, { moving });
  }

  /** An accepted goTo/moveTo: the FULL A* path the agent will walk (intent + route, capped). */
  path(actor: string, at: TapeLoc | undefined, action: string, target: { to?: string; x?: number; y?: number }, route: Array<[number, number]>, tick?: number): void {
    this.beat("path", actor, at, {
      action,
      ...(target.to ? { to: target.to } : {}),
      ...(typeof target.x === "number" ? { tx: target.x, ty: target.y } : {}),
      steps: route.length,
      route: route.length > 200 ? route.slice(0, 200) : route,
      ...(route.length > 200 ? { routeTruncated: true } : {}),
    }, typeof tick === "number" ? `${actor}:${tick}` : undefined);
  }

  /** Interior enter/leave (sim-derived on path arrival — the tick-loop hook). */
  enter(actor: string, at: TapeLoc | undefined, building: string): void {
    this.beat("enter", actor, at, { building });
  }
  leave(actor: string, at: TapeLoc | undefined, building: string): void {
    this.beat("leave", actor, at, { building });
  }

  /** go_inside result: the agent took a sublocation (seat/station) at interior coords. */
  spot(actor: string, at: TapeLoc | undefined, d: { building: string; spot: string; label?: string; ix: number; iy: number; kind?: string; tick?: number }): void {
    const { tick, ...rest } = d;
    this.beat("spot", actor, at, rest as unknown as Record<string, unknown>, typeof tick === "number" ? `${actor}:${tick}` : undefined);
  }

  /** Earshot fan-out: who was actually in range of an utterance/dialogue at speak time — AND who was
   *  considered but EXCLUDED, with why (D32 layer 5: participant | walls | range). Silence explained. */
  earshot(speaker: string, at: TapeLoc | undefined, d: { kind: "say" | "dialogue"; to?: string; audience: string[]; excluded?: Array<{ id: string; why: string }>; gist?: string }): void {
    this.beat("earshot", speaker, at, d as unknown as Record<string, unknown>);
  }

  /** Presence-delta fan-out (entered/left/sat/stood/moved) + who sensed it. */
  nearby(actor: string, d: { verb: string; place: string; audience: string[] }): void {
    this.beat("nearby", actor, undefined, d as unknown as Record<string, unknown>);
  }

  /** A closed dialogue record (mirror of POST /dialogue), located at participant[0]. */
  dialogue(at: TapeLoc | undefined, summary: { id?: string; participants?: string[]; turns?: number; outcome?: string; topic?: string; startedAtGameMin?: number }): void {
    const actor = summary.participants?.[0];
    this.beat("dialogue", actor, at, {
      id: summary.id,
      participants: summary.participants,
      turns: summary.turns,
      outcome: summary.outcome,
      topic: summary.topic,
      startedAtGameMin: summary.startedAtGameMin,
    });
  }

  // ---- internals ----
  private writeManifest(m: RunManifest): void {
    try {
      writeFileSync(join(this.runsDir, m.runId, "manifest.json"), JSON.stringify(m, null, 2));
    } catch {
      /* swallow */
    }
  }
  private countLines(file: string): number {
    try {
      if (!existsSync(file)) return 0;
      return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }
}

function round1(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
}

// ---- runnable self-test (ZERO tokens): `npx tsx sim/flight-tape.ts` ------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
    console.log(`  ✅ ${msg}`);
  };
  const dir = mkdtempSync(join(tmpdir(), "flight-tape-"));
  try {
    let gm = 4196.44;
    let t = new Date("2026-07-18T19:16:41.000Z").getTime();
    const clockedTape = () => new FlightTape(join(dir, "runs"), () => gm, { now: () => new Date((t += 1000)) });

    // idle beats land in _idle
    const tape = clockedTape();
    tape.beat("pos", "baker", { x: 40, y: 8, building: "bakery" }, { moving: true });
    assert(existsSync(join(dir, "runs", "_idle", "tape.jsonl")), "idle beat lands in runs/_idle/tape.jsonl");

    // begin → beats → end
    const id = tape.beginRun({ duration: { kind: "minutes", value: 15 }, roster: [{ id: "baker" }], gameMinPerRealSec: 1.2, ceilingUsd: 5 });
    assert(/^run-\d{8}-\d{6}$/.test(id), `runId is fs-safe + sortable (${id})`);
    tape.event({ actor: "baker", kind: "status", payload: { text: "baking…", at: "bakery" } }, { x: 40, y: 2, building: "bakery", inside: { b: "bakery", ix: 6, iy: 8 } });
    gm = 4300.06;
    tape.spot("baker", { x: 40, y: 2, building: "bakery", inside: { b: "bakery", ix: 6, iy: 2, spot: "bakery-counter" } }, { building: "bakery", spot: "bakery-counter", ix: 6, iy: 2, kind: "counter" });
    tape.earshot("barista", { x: 15, y: 8 }, { kind: "say", to: "grocer", audience: ["courier"] });
    tape.syncStatus("running", null);
    tape.syncStatus("stopped", "duration-elapsed"); // the tickAdvance stop path → tape must close the run
    const m1 = readManifest(join(dir, "runs"), id)!;
    assert(m1.endedTs != null && m1.endReason === "duration-elapsed", "syncStatus(running→stopped) closes the run with the reason");
    assert(m1.startedGameMin === 4196.4 && m1.endedGameMin === 4300.1, `manifest carries both game-clock bounds (${m1.startedGameMin}→${m1.endedGameMin})`);
    const lines = readFileSync(join(dir, "runs", id, "tape.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TapeBeat);
    assert(lines[0].kind === "run-begin" && lines[lines.length - 1].kind === "run-end", "tape bracketed by run-begin/run-end");
    assert(lines.every((l) => l.run === id && typeof l.gm === "number" && typeof l.t === "string"), "every beat is self-describing (run + gm + t)");
    const spotBeat = lines.find((l) => l.kind === "spot")!;
    assert(spotBeat.at?.inside?.spot === "bakery-counter" && spotBeat.gm === 4300.1, "spot beat carries interior coords + game-time");
    const ear = lines.find((l) => l.kind === "earshot")!;
    assert(Array.isArray((ear.data as { audience?: string[] }).audience), "earshot beat carries the audience list");
    assert(lines.map((l) => l.seq).every((s, i) => s === lines[0].seq + i), "seq is monotonic within the segment");

    // open-run + restart WITHOUT resume → closed as sim-restart
    const id2 = tape.beginRun({});
    tape.beat("pos", "baker", { x: 1, y: 8 }, { moving: true });
    const tape2 = clockedTape(); // simulates a restart; resumeOpenRun defaults false
    void tape2;
    const m2 = readManifest(join(dir, "runs"), id2)!;
    assert(m2.endReason === "sim-restart", "a dangling open run is closed as sim-restart on boot");

    // open-run + restart WITH resume → reopened, seq continues, run-reopen beat
    // (fresh run under a NEW tape so the manifest is open when the "restart" happens)
    const tape3 = clockedTape();
    const id3 = tape3.beginRun({});
    tape3.beat("pos", "baker", { x: 2, y: 8 }, { moving: true });
    const before = readFileSync(join(dir, "runs", id3, "tape.jsonl"), "utf8").split("\n").filter(Boolean).length;
    const tape4 = new FlightTape(join(dir, "runs"), () => gm, { now: () => new Date((t += 1000)), resumeOpenRun: true });
    assert(tape4.runId() === id3, "resumeOpenRun reopens the dangling run");
    const after = readFileSync(join(dir, "runs", id3, "tape.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TapeBeat);
    assert(after.length === before + 1 && after[after.length - 1].kind === "run-reopen", "reopen appends a run-reopen beat");
    assert(after[after.length - 1].seq === before, "seq continues across the restart seam");

    // listRunIds sorted
    const ids = listRunIds(join(dir, "runs"));
    assert(ids.length === 3 && [...ids].sort().join() === ids.join(), `listRunIds sorted (${ids.join(", ")})`);
    console.log("\n✅ flight-tape.ts self-test passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
