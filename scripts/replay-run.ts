// scripts/replay-run.ts — the FLIGHT-TAPE REPLAYER (T0-tape): render a run in the terminal as
//   (a) per-agent day timelines,  (b) the whole-town chronological story,  (c) ASCII map frames
//   (town grid or one interior) at any game-time,  (d) ANOMALY FLAGS (doorway detector, status-vs-
//   position, idle, duplicates, zombie ticks, unheard says, buys without settlement).
//
// TWO SOURCES, one normalized stream:
//   • REAL TAPE  — sim/data/runs/<runId>/{tape.jsonl,manifest.json} (written by sim/flight-tape.ts once
//     the lead mounts the hooks). Full fidelity: positions per step, interior coords, earshot audiences.
//   • LEGACY     — synthesized from events.jsonl + traces/*.jsonl + dialogue.jsonl for runs that predate
//     the tape (e.g. TODAY'S 2026-07-18 run). Degrades honestly: the header lists exactly which beat
//     kinds are missing and every detector that can't run says WHY.
//
//   npx tsx scripts/replay-run.ts                          # newest real run, else legacy --today
//   npx tsx scripts/replay-run.ts --run <id|latest>        # a real tape
//   npx tsx scripts/replay-run.ts --list                   # list recorded runs
//   npx tsx scripts/replay-run.ts --legacy --today         # synthesize today's run from legacy logs
//   npx tsx scripts/replay-run.ts --legacy --since <ISO> [--until <ISO>]
//   npx tsx scripts/replay-run.ts --agent baker            # one agent's timeline (+flags)
//   npx tsx scripts/replay-run.ts --story|--timelines|--flags   # pick sections (default: all)
//   npx tsx scripts/replay-run.ts --map "09:15"            # ASCII town frame at a game-time (or gm number)
//   npx tsx scripts/replay-run.ts --interior bakery [--at "09:15"]  # interior floorplan + occupants
//   npx tsx scripts/replay-run.ts --idle-gm 240            # idle-gap threshold in game-minutes
//
// READ-ONLY over the logs; never calls an LLM; degrade-don't-die on malformed lines.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, buildingAt, type EventLine, type DialogueLine, type World } from "../sim/telemetry.js";
import type { TraceLine } from "../cognition/trace.js";
import { listRunIds, readManifest, type RunManifest, type TapeBeat, type TapeLoc } from "../sim/flight-tape.js";
import { ROOT, loadWorld, floorplanAscii, townMapAscii, type AtlasWorld } from "./atlas-lib.js";

let DATA = join(ROOT, "sim", "data");
let RUNS = join(DATA, "runs");

// ───────────────────────── args ─────────────────────────
type Args = {
  run?: string; list: boolean; legacy: boolean; today: boolean; since?: string; until?: string;
  agent?: string; story: boolean; timelines: boolean; flags: boolean; map?: string;
  interior?: string; at?: string; idleGm?: number; json: boolean; data?: string; why?: string;
};
function parseArgs(argv: string[]): Args {
  const a: Args = { list: false, legacy: false, today: false, story: false, timelines: false, flags: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--run") a.run = argv[++i];
    else if (t === "--list") a.list = true;
    else if (t === "--legacy") a.legacy = true;
    else if (t === "--today") a.today = true;
    else if (t === "--since") a.since = argv[++i];
    else if (t === "--until") a.until = argv[++i];
    else if (t === "--agent") a.agent = argv[++i];
    else if (t === "--story") a.story = true;
    else if (t === "--timelines") a.timelines = true;
    else if (t === "--flags") a.flags = true;
    else if (t === "--map") a.map = argv[++i];
    else if (t === "--interior") a.interior = argv[++i];
    else if (t === "--at") a.at = argv[++i];
    else if (t === "--idle-gm") a.idleGm = Number(argv[++i]);
    else if (t === "--json") a.json = true;
    else if (t === "--data") a.data = argv[++i];
    else if (t === "--why") a.why = argv[++i];
  }
  return a;
}

// ───────────────────────── ANSI (mirrors grade-run.ts; plain when piped) ─────────────────────────
const TTY = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = {
  reset: TTY ? "\x1b[0m" : "", bold: TTY ? "\x1b[1m" : "", dim: TTY ? "\x1b[2m" : "",
  green: TTY ? "\x1b[32m" : "", yellow: TTY ? "\x1b[33m" : "", red: TTY ? "\x1b[31m" : "",
  cyan: TTY ? "\x1b[36m" : "", gray: TTY ? "\x1b[90m" : "",
};

// ───────────────────────── the normalized beat stream ─────────────────────────
type NormBeat = {
  tms: number; // wall epoch ms (sort key)
  t: string; // wall ISO
  gm?: number; // game-minutes when known
  kind: string;
  actor?: string;
  at?: TapeLoc; // real tape; legacy fills x/y/building from traces where possible
  data?: Record<string, unknown>;
  src: "tape" | "event" | "trace" | "dialogue";
  line?: number; // source line number (citations)
  dup?: boolean; // legacy double-emit twin (kept in stream, excluded from counts/story)
};

type Loaded = {
  mode: "tape" | "legacy";
  label: string;
  manifest?: RunManifest;
  beats: NormBeat[]; // sorted by tms
  agents: string[];
  missing: string[]; // beat kinds this source CANNOT provide (say it, per the brief)
  world: AtlasWorld;
  gmOf: (tms: number) => number | undefined; // wall→game-clock mapping when derivable
  window: { fromMs: number; toMs: number };
};

function readJsonlNumbered<T>(file: string): Array<{ v: T; line: number }> {
  const out: Array<{ v: T; line: number }> = [];
  let n = 0;
  for (const v of readJsonl<T>(file, () => n++)) out.push({ v, line: ++n });
  // NOTE: readJsonl skips malformed lines silently for us; line numbers here are 1-based among PARSED lines,
  // close enough for citation (exact file lines can drift by the skipped count, which is ~0 in practice).
  return out;
}

// ---- REAL TAPE loader ----
function loadTape(runId: string): Loaded {
  const world = loadWorld();
  const manifest = readManifest(RUNS, runId) ?? undefined;
  const rows = readJsonlNumbered<TapeBeat>(join(RUNS, runId, "tape.jsonl"));
  const beats: NormBeat[] = rows.map(({ v, line }) => ({
    tms: Date.parse(v.t), t: v.t, gm: v.gm, kind: v.kind, actor: v.actor, at: v.at,
    data: v.data, src: "tape" as const, line,
  })).filter((b) => Number.isFinite(b.tms)).sort((a, b) => a.tms - b.tms);
  const agents = [...new Set(beats.map((b) => b.actor).filter((x): x is string => !!x))].sort();
  // tape carries gm on every beat — interpolate between neighbours for arbitrary wall times
  const pairs = beats.filter((b) => typeof b.gm === "number").map((b) => [b.tms, b.gm as number] as const);
  const gmOf = makeGmFit(pairs);
  const fromMs = beats.length ? beats[0].tms : Date.parse(manifest?.startedTs ?? "") || 0;
  const toMs = beats.length ? beats[beats.length - 1].tms : fromMs;
  return {
    mode: "tape", label: runId, manifest, beats, agents, world, gmOf,
    missing: [],
    window: { fromMs, toMs },
  };
}

// ---- LEGACY synthesizer ----
function loadLegacy(win: { sinceMs?: number; untilMs?: number }): Loaded {
  const world = loadWorld();
  const inWin = (tms: number) => (win.sinceMs == null || tms >= win.sinceMs) && (win.untilMs == null || tms <= win.untilMs);

  const beats: NormBeat[] = [];
  // events.jsonl
  for (const { v, line } of readJsonlNumbered<EventLine>(join(DATA, "events.jsonl"))) {
    const tms = Date.parse(v.ts ?? "");
    if (!Number.isFinite(tms) || !inWin(tms)) continue;
    beats.push({ tms, t: v.ts, kind: v.kind, actor: v.actor, data: { payload: v.payload, txHash: v.txHash, related_id: v.related_id }, src: "event", line });
  }
  // traces
  const agentsSeen = new Set<string>();
  const gmPairs: Array<readonly [number, number]> = [];
  const traceDir = join(DATA, "traces");
  if (existsSync(traceDir)) {
    for (const f of readdirSync(traceDir)) {
      if (!f.endsWith(".jsonl")) continue;
      for (const { v, line } of readJsonlNumbered<TraceLine>(join(traceDir, f))) {
        const tms = Date.parse(v.ts ?? "");
        if (!Number.isFinite(tms) || !inWin(tms)) continue;
        agentsSeen.add(v.id);
        if (typeof v.gameMin === "number") gmPairs.push([tms, v.gameMin] as const);
        const x = v.perceived?.at?.x, y = v.perceived?.at?.y;
        const building = v.perceived?.shop ?? buildingAt(x, y, world as unknown as World);
        beats.push({
          tms, t: v.ts, gm: v.gameMin, kind: "tick", actor: v.id,
          at: typeof x === "number" && typeof y === "number" ? { x, y, building } : undefined,
          data: {
            plan: v.plan, reasoning: v.reasoning, actions: (v.actions ?? []).map((a) => a.tool),
            costUsd: v.result?.cost_usd, turns: v.result?.num_turns, error: v.result?.error ?? undefined,
          },
          src: "trace", line,
        });
      }
    }
  }
  const gmOf = makeGmFit(gmPairs);
  // dialogues — NO wall ts in the legacy format; scope by the gm window observed in this run's traces and
  // SAY the caveat (gm ranges from different clock epochs can overlap — see the audit).
  const gms = gmPairs.map(([, g]) => g);
  const gmMin = gms.length ? Math.min(...gms) - 10 : undefined;
  const gmMax = gms.length ? Math.max(...gms) + 30 : undefined;
  const msOfGm = invertGmFit(gmPairs);
  for (const { v, line } of readJsonlNumbered<DialogueLine>(join(DATA, "dialogue.jsonl"))) {
    const g = v.startedAtGameMin;
    if (typeof g !== "number" || gmMin == null || gmMax == null || g < gmMin || g > gmMax) continue;
    const tms = msOfGm(g) ?? (win.sinceMs ?? 0);
    beats.push({
      tms, t: new Date(tms).toISOString(), gm: g, kind: "dialogue",
      actor: v.participants?.[0],
      data: { id: v.id, participants: v.participants, turns: v.turns, outcome: v.outcome, topic: v.topic },
      src: "dialogue", line,
    });
  }
  beats.sort((a, b) => a.tms - b.tms || (a.src === "event" ? 0 : 1) - (b.src === "event" ? 0 : 1));
  // mark legacy DOUBLE-EMITS (audit §5: sim + citizen both record produce ~2ms apart): same actor+kind ≤2s.
  const lastByActorKind = new Map<string, number>();
  for (const b of beats) {
    if (b.src !== "event") continue;
    const k = `${b.actor}|${b.kind}`;
    const prev = lastByActorKind.get(k);
    if (prev != null && b.tms - prev <= 2000) b.dup = true;
    else lastByActorKind.set(k, b.tms);
  }
  // backfill game-time onto event beats from the wall→game fit (traces anchor it), so every story line
  // gets a game-clock and the idle detector can reason in game-minutes across ALL beat kinds.
  for (const b of beats) if (b.gm == null) b.gm = gmOf(b.tms);
  for (const b of beats) if (b.actor) agentsSeen.add(b.actor);
  const fromMs = beats.length ? beats[0].tms : (win.sinceMs ?? 0);
  const toMs = beats.length ? beats[beats.length - 1].tms : fromMs;
  return {
    mode: "legacy",
    label: win.sinceMs ? `legacy since ${new Date(win.sinceMs).toISOString()}` : "legacy (whole log)",
    beats, agents: [...agentsSeen].filter((a) => a !== "?").sort(), world, gmOf,
    missing: [
      "pos (tile-by-tile walk paths) — sim never persisted positions; only ~4-8 LLM-tick samples/agent exist",
      "path (planned A* routes) — never persisted",
      "enter/leave (interior transitions) — WS/RAM only in legacy runs",
      "spot (seat/station takes with interior coords) — InteriorPresence was in-memory only",
      "earshot (who actually heard a say) — the overheard/nearby rings were RAM-only",
      "run manifest (exact start/end + roster) — no run identity existed; window inferred from wall-clock",
      "dialogue wall-times — legacy dialogue.jsonl has no ts; scoped by game-minute window (epoch-overlap caveat, see audit)",
    ],
    window: { fromMs, toMs },
  };
}

// linear wall↔game clock fit from observed (tms, gm) pairs (piecewise-linear interpolation, clamped ends).
function makeGmFit(pairs: ReadonlyArray<readonly [number, number]>): (tms: number) => number | undefined {
  const p = [...pairs].sort((a, b) => a[0] - b[0]);
  if (p.length === 0) return () => undefined;
  return (tms: number) => {
    if (p.length === 1) return p[0][1];
    if (tms <= p[0][0]) return p[0][1];
    if (tms >= p[p.length - 1][0]) return p[p.length - 1][1];
    for (let i = 1; i < p.length; i++) {
      if (tms <= p[i][0]) {
        const [t0, g0] = p[i - 1], [t1, g1] = p[i];
        return t1 === t0 ? g0 : g0 + ((tms - t0) / (t1 - t0)) * (g1 - g0);
      }
    }
    return p[p.length - 1][1];
  };
}
function invertGmFit(pairs: ReadonlyArray<readonly [number, number]>): (gm: number) => number | undefined {
  const p = [...pairs].sort((a, b) => a[1] - b[1]);
  if (p.length === 0) return () => undefined;
  return (gm: number) => {
    if (p.length === 1) return p[0][0];
    if (gm <= p[0][1]) return p[0][0];
    if (gm >= p[p.length - 1][1]) return p[p.length - 1][0];
    for (let i = 1; i < p.length; i++) {
      if (gm <= p[i][1]) {
        const [t0, g0] = p[i - 1], [t1, g1] = p[i];
        return g1 === g0 ? t0 : t0 + ((gm - g0) / (g1 - g0)) * (t1 - t0);
      }
    }
    return p[p.length - 1][0];
  };
}

// ───────────────────────── time formatting (mirrors run-state clockOf — never a second clock) ────────────
function gmClock(gm: number | undefined): string {
  if (typeof gm !== "number") return "  --:--  ";
  const m = Math.max(0, Math.floor(gm));
  const day = Math.floor(m / 1440) + 1, hh = Math.floor((m % 1440) / 60), mm = m % 60;
  return `d${day} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function wallShort(t: string): string {
  return t.slice(11, 19) + "Z";
}
/** Parse --map/--at times: raw gm number · "HH:MM" (on the run's last day) · "d3 21:58". */
function parseGameTime(s: string, beats: NormBeat[]): number | undefined {
  const gms = beats.map((b) => b.gm).filter((g): g is number => typeof g === "number");
  if (!gms.length) return undefined;
  const lastDay = Math.floor(Math.max(...gms) / 1440);
  let m = /^d(\d+)\s+(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (m) return (Number(m[1]) - 1) * 1440 + Number(m[2]) * 60 + Number(m[3]);
  m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (m) return lastDay * 1440 + Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// ───────────────────────── humanizing one beat ─────────────────────────
function str(v: unknown): string { return v == null ? "" : String(v); }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function oneline(s: string | undefined, max = 110): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
function locSuffix(b: NormBeat): string {
  const at = b.at;
  if (!at) return "";
  const inside = at.inside ? ` in ${at.inside.b}@(${at.inside.ix},${at.inside.iy})${at.inside.spot ? `[${at.inside.spot}]` : "[no spot — doorway]"}` : "";
  return `${c.gray} @(${at.x},${at.y})${at.building ? ` ${at.building}` : ""}${inside}${c.reset}`;
}
function describe(b: NormBeat, forTimeline: boolean): string | null {
  const d = (b.data ?? {}) as Record<string, unknown>;
  const p = (d.payload ?? {}) as Record<string, unknown>;
  switch (b.kind) {
    case "run-begin": return `${c.cyan}▶ RUN BEGINS${c.reset} ${c.dim}${JSON.stringify(d.duration ?? {})}${c.reset}`;
    case "run-end": return `${c.cyan}■ RUN ENDS${c.reset} ${c.dim}(${str(d.reason)})${c.reset}`;
    case "run-pause": return `${c.dim}⏸ paused (${str(d.reason)})${c.reset}`;
    case "run-resume": return `${c.dim}⏵ resumed${c.reset}`;
    case "run-reopen": return `${c.dim}↻ tape reopened after sim restart${c.reset}`;
    case "pos": return forTimeline ? null : null; // rendered only via --map (too chatty for prose)
    case "path": return `🚶 sets out for ${str(d.to) || `(${str(d.tx)},${str(d.ty)})`} ${c.dim}(${num(d.steps)} steps)${c.reset}`;
    case "enter": return `🚪 enters ${str(d.building)}`;
    case "leave": return `🚪 leaves ${str(d.building)}`;
    case "spot": return `🪑 takes ${str(d.label) || str(d.spot)} in ${str(d.building)} at (${str(d.ix)},${str(d.iy)})`;
    case "earshot": {
      const aud = (d.audience as string[]) ?? [];
      return `${c.dim}👂 in earshot of that ${str(d.kind)}: ${aud.length ? aud.join(", ") : "no one"}${c.reset}`;
    }
    case "nearby": return `${c.dim}👀 ${str(d.verb)} ${str(d.place)} — sensed by ${((d.audience as string[]) ?? []).join(", ") || "no one"}${c.reset}`;
    case "dialogue": {
      const parts = ((d.participants as string[]) ?? []).join("↔");
      const turns = num(d.turns);
      return `💬 ${parts} — ${turns} turn${turns === 1 ? "" : "s"}, ${str(d.outcome)}${d.topic ? `: “${oneline(str(d.topic), 60)}”` : ""}`;
    }
    case "online": return `🟢 ${str(p.name) || b.actor} comes online`;
    case "move": return `→ intends to head to ${str(p.to)} ${c.dim}(free-text intent)${c.reset}`;
    case "say": return `🗣 to ${str(p.to)}: “${oneline(str(p.text), 90)}”`;
    case "status": return `${str(p.emoji) ? str(p.emoji) + " " : ""}${oneline(str(p.text) || str(p.verb), 60)}${p.at ? ` @ ${str(p.at)}` : ""}`;
    case "produce": return `🛠 produces ${str(p.good)}${p.have != null ? ` (have ${num(p.have)})` : ""}`;
    case "consume": return `🍽 consumes ${str(p.item)} (left ${num(p.remaining)})`;
    case "use": return `🔧 uses ${str(p.item)}`;
    case "give": return `🎁 gives ${str(p.item)} to ${str(p.to)}`;
    case "pick_up": return `✋ picks up ${str(p.item)} at ${str(p.place)}`;
    case "drop": return `📦 drops ${str(p.item)} at ${str(p.place)}`;
    case "purchase": return `💸 buys ${str(p.item)} for $${num(p.price_usdc)} at ${str(p.shop)}${(d.txHash as string) ? ` ${c.green}tx ${(d.txHash as string).slice(0, 10)}…${c.reset}` : ` ${c.red}(NO txHash)${c.reset}`}`;
    case "plan-step": return `🎯 plan: ${oneline(str(p.step), 80)}${p.until ? ` ${c.dim}(until ${str(p.until)})${c.reset}` : ""}`;
    case "decision": return `🧭 decides: ${oneline(str(p.reason), 90)}`;
    // D32 causal-chain beats (sim hooks + the peers' shared kinds)
    case "perceive": return forTimeline ? `${c.dim}👁 perceives: ${oneline(JSON.stringify(b.data ?? {}), 110)}${c.reset}` : null;
    case "act-fail": return `${c.red}⛔ act FAILED: ${str(d.action)} — ${oneline(str(d.reason), 90)}${c.reset}`;
    case "say-rejected": return `${c.red}🚫 say to ${str(d.to)} rejected: ${str(d.reason)}${c.reset}`;
    case "suppressed": return `${c.dim}🤐 did NOT ${str(p.trigger) || "act"}${p.target ? ` (→${str(p.target)})` : ""}: ${oneline(str(p.reason), 80)}${c.reset}`;
    case "menu": {
      const opts = (p.options as string[]) ?? [];
      return `📋 options here: ${opts.length ? `[${opts.slice(0, 8).join(", ")}${opts.length > 8 ? ", …" : ""}]` : `${c.red}NONE — empty menu${c.reset}`}`;
    }
    case "choice": return `👉 chose ${oneline(str(p.chosen), 60)}${p.of != null ? ` ${c.dim}(of ${num(p.of)} options)${c.reset}` : ""}`;
    case "custody": return `🔁 custody: ${str(d.item)} ${str(d.from) || "?"}→${str(d.to)}${(d.txHash as string) ? ` ${c.dim}tx ${(d.txHash as string).slice(0, 10)}…${c.reset}` : ""}`;
    case "usage": return forTimeline ? `${c.dim}⏱ tick usage ${oneline(JSON.stringify(b.data ?? {}), 90)}${c.reset}` : null;
    case "gossip-passed": return `🗨️ passes gossip “${oneline(str(p.topic), 40)}” to ${str(p.to)}${Array.isArray(p.chain) ? ` ${c.dim}(chain ${(p.chain as string[]).join("→")})${c.reset}` : ""}`;
    case "buy-attempt": return `🛒 tries to buy ${str(p.item)} at ${str(p.shop)}`;
    case "buy-402": return `💳 got 402 challenge (${str(p.amount) || str(p.price)})`;
    case "buy-settled": return `✅ settlement confirmed ${(str(p.txHash) || str(d.txHash)).slice(0, 12)}…`;
    case "buy-failed": return `${c.red}❌ buy FAILED: ${oneline(str(p.reason), 80)}${c.reset}`;
    // the peers' FINAL T0 vocabulary (life-spine + social-weave): affordances arrives in BOTH
    // shapes — lifegiver {options[], at, plan, turn} · socialweaver {eligible[], suppressed[{id,reason}]}.
    case "affordances": {
      const opts = (p.options as string[]) ?? (p.eligible as string[]) ?? [];
      const sup = (p.suppressed as Array<{ id: string; reason: string }>) ?? [];
      const supStr = sup.length ? ` ${c.dim}· suppressed ${sup.length}: ${sup.slice(0, 3).map((s) => `${s.id}(${s.reason})`).join(", ")}${sup.length > 3 ? "…" : ""}${c.reset}` : "";
      return `📋 can: ${opts.length ? `[${opts.slice(0, 6).join(", ")}${opts.length > 6 ? ", …" : ""}]` : `${c.red}NOTHING actionable${c.reset}`}${supStr}`;
    }
    case "ignition": {
      const cand = (p.candidates as Array<{ id: string; status: string }>) ?? [];
      if (p.decision === "fired") return `🔥 social ignition: ${str(p.mode)}${p.partner ? ` → ${str(p.partner)}` : ""} ${c.dim}(${cand.length} candidate${cand.length === 1 ? "" : "s"})${c.reset}`;
      return forTimeline ? `${c.dim}🤐 social pass: ${str(p.reason)} (${cand.length} candidate${cand.length === 1 ? "" : "s"})${c.reset}` : null;
    }
    case "blocked": return `${c.yellow}🧱 blocked: ${str(p.tool)}${p.to ? ` → ${str(p.to)}` : ""}${p.spot ? ` → ${str(p.spot)}` : ""} (${oneline(str(p.reason), 70)})${c.reset}`;
    case "stuck": return `${c.red}🌀 STUCK ×${num(p.consecutive)}: ${oneline(str(p.why), 80)}${c.reset}`;
    case "warming": return forTimeline ? `${c.dim}♨ warming ${str(p.what)} (${num(p.ms)}ms)${c.reset}` : null;
    case "tick": {
      if (!forTimeline) return null; // thoughts belong to the per-agent view, not the town story
      const cost = num(d.costUsd);
      const zombie = cost === 0 ? ` ${c.red}(cost $0 — zombie tell)${c.reset}` : "";
      const acts = (d.actions as string[]) ?? [];
      const thought = oneline(str(d.reasoning), 100);
      return `🧠 tick${zombie}${acts.length ? ` ${c.dim}tools:[${acts.join(",")}]${c.reset}` : ""}${thought ? ` — “${thought}”` : ""}${d.plan ? ` ${c.cyan}plan:${oneline(str(d.plan), 50)}${c.reset}` : ""}`;
    }
    default: return `${b.kind}${Object.keys(p).length ? " " + oneline(JSON.stringify(p), 80) : ""}`;
  }
}

// ───────────────────────── anomaly detectors ─────────────────────────
type Flag = { code: string; severity: "high" | "med" | "info"; who?: string; when?: string; msg: string };

function detectFlags(L: Loaded, idleGmThreshold: number): Flag[] {
  const flags: Flag[] = [];
  const beats = L.beats.filter((b) => !b.dup);
  const say = (f: Flag) => flags.push(f);

  // 1) STATUS-vs-POSITION (the doorway detector's legacy half): a status claiming `at: B` while the
  //    nearest known position (±150s) resolves elsewhere. Real tape: the beat carries its own position.
  for (const b of beats) {
    if (b.kind !== "status" || !b.actor) continue;
    const claimed = str(((b.data ?? {}) as { payload?: { at?: unknown } }).payload?.at);
    if (!claimed) continue;
    if (b.at) {
      // tape: position is ON the beat
      const whereB = b.at.inside?.b ?? b.at.building ?? null;
      if (whereB && whereB !== claimed) {
        say({ code: "status-position-mismatch", severity: "high", who: b.actor, when: b.t, msg: `status says "${claimed}" but the beat's own position is ${whereB} @(${b.at.x},${b.at.y}) — one layer is lying` });
      } else if (b.at.inside && !b.at.inside.spot) {
        say({ code: "working-from-the-doorway", severity: "med", who: b.actor, when: b.t, msg: `status "${oneline(str((b.data as { payload?: { text?: string } }).payload?.text), 30)}" emitted while inside ${b.at.inside.b} at the door tile (${b.at.inside.ix},${b.at.inside.iy}) with NO station/seat — the operator's doorway-baker case` });
      }
      continue;
    }
    // legacy: nearest same-actor trace sample
    const near = beats
      .filter((x) => x.src === "trace" && x.actor === b.actor && x.at && Math.abs(x.tms - b.tms) <= 150_000)
      .sort((x, y) => Math.abs(x.tms - b.tms) - Math.abs(y.tms - b.tms))[0];
    if (!near) {
      say({ code: "status-unverifiable", severity: "info", who: b.actor, when: b.t, msg: `status claims "${claimed}" but NO position sample exists within ±150s (legacy tape has no pos beats) — cannot verify` });
    } else {
      const whereB = near.at!.building ?? null;
      const age = Math.round(Math.abs(near.tms - b.tms) / 1000);
      if (whereB !== claimed) {
        say({ code: "status-position-mismatch", severity: "high", who: b.actor, when: b.t, msg: `status says "${claimed}" but the nearest position sample (${age}s away, trace line ${near.line}) puts them at ${whereB ?? `(${near.at!.x},${near.at!.y})`} — sim state and claim DISAGREE` });
      }
    }
  }

  // 2) doorway dwell + inside-no-purpose (REAL TAPE ONLY — legacy cannot see enter/spot/leave)
  if (L.mode === "tape") {
    type Span = { b: string; enterGm?: number; spotted: boolean; purposeful: boolean; enterT: string };
    const open = new Map<string, Span>();
    for (const b of beats) {
      if (!b.actor) continue;
      if (b.kind === "enter") open.set(b.actor, { b: str((b.data as { building?: unknown })?.building), enterGm: b.gm, spotted: false, purposeful: false, enterT: b.t });
      else if (b.kind === "spot") { const s = open.get(b.actor); if (s) s.spotted = true; }
      else if (b.kind === "leave") {
        const s = open.get(b.actor);
        if (s) {
          const dwell = typeof b.gm === "number" && typeof s.enterGm === "number" ? Math.round(b.gm - s.enterGm) : undefined;
          if (!s.spotted && dwell != null && dwell >= 30) say({ code: "at-door-dwell", severity: "med", who: b.actor, when: s.enterT, msg: `spent ${dwell} game-min inside ${s.b} without ever taking a seat/station (stood at the door tile)` });
          if (!s.purposeful && dwell != null && dwell >= 30) say({ code: "inside-no-purpose", severity: "med", who: b.actor, when: s.enterT, msg: `entered ${s.b} and left ${dwell} game-min later with zero events inside (no work, no talk, no buy)` });
          open.delete(b.actor);
        }
      } else if (!["pos", "tick"].includes(b.kind)) {
        const s = open.get(b.actor);
        if (s) s.purposeful = true;
      }
    }
    for (const [who, s] of open) {
      if (!s.spotted) say({ code: "at-door-dwell", severity: "med", who, when: s.enterT, msg: `still inside ${s.b} at tape end without ever taking a seat/station` });
    }
    // 3) say-unheard: an earshot fan with an empty audience AND no addressee delivery
    for (const b of beats) {
      if (b.kind !== "earshot") continue;
      const aud = ((b.data as { audience?: string[] })?.audience) ?? [];
      const to = str((b.data as { to?: unknown })?.to);
      if (aud.length === 0 && !to) say({ code: "say-unheard", severity: "info", who: b.actor, when: b.t, msg: `spoke with NO ONE in earshot — words into the void` });
    }
  } else {
    say({ code: "detector-offline", severity: "info", msg: `doorway-dwell / inside-no-purpose / say-unheard detectors need tape beats (enter/spot/leave/earshot) — legacy source has none; they will light up on the first taped run` });
  }

  // 4) idle gaps: consecutive same-agent beats too far apart in game-minutes (run-active spans only)
  const byAgent = new Map<string, NormBeat[]>();
  for (const b of beats) if (b.actor && !["pos"].includes(b.kind)) (byAgent.get(b.actor) ?? byAgent.set(b.actor, []).get(b.actor)!).push(b);
  for (const [who, bs] of byAgent) {
    for (let i = 1; i < bs.length; i++) {
      const g0 = bs[i - 1].gm, g1 = bs[i].gm;
      if (typeof g0 === "number" && typeof g1 === "number" && g1 - g0 > idleGmThreshold) {
        say({ code: "idle-gap", severity: "med", who, when: bs[i - 1].t, msg: `${Math.round(g1 - g0)} game-min (${Math.round((bs[i].tms - bs[i - 1].tms) / 1000)}s wall) with no beats between ${gmClock(g0)} and ${gmClock(g1)}` });
      }
    }
  }

  // 5) zombie ticks (trace result cost 0 — the INC-2026-06-18 tell)
  for (const b of beats) {
    if (b.src === "trace" && b.kind === "tick" && num((b.data as { costUsd?: unknown })?.costUsd) === 0) {
      say({ code: "zombie-tick", severity: "high", who: b.actor, when: b.t, msg: `tick completed with cost $0 (trace line ${b.line}) — the zombie-loop tell` });
    }
  }

  // 6) duplicate emits (legacy double-write: sim /act + citizen /event ~2ms apart)
  const dups = L.beats.filter((b) => b.dup);
  const dupByKind = new Map<string, number>();
  for (const d of dups) dupByKind.set(d.kind, (dupByKind.get(d.kind) ?? 0) + 1);
  for (const [kind, n] of dupByKind) {
    say({ code: "duplicate-event", severity: "med", msg: `${n} ${kind} event(s) are double-emits (same actor+kind ≤2s apart; sim /act + citizen POST /event both record) — counts using raw events.jsonl overstate ${kind} by ${n}` });
  }

  // 7) purchases without settlement hash
  for (const b of beats) {
    if (b.kind === "purchase" && !str((b.data as { txHash?: unknown })?.txHash)) {
      say({ code: "buy-no-settlement", severity: "high", who: b.actor, when: b.t, msg: `purchase recorded WITHOUT a txHash (line ${b.line}) — money moved off-tape or the buy failed silently` });
    }
  }

  // 8) D32: every failed act is an anomaly (the act-fallthrough trap made loud), and an EMPTY affordance
  //    menu while present in a place is the stuck precursor (operator addendum).
  for (const b of beats) {
    const p = ((b.data ?? {}) as { payload?: Record<string, unknown> }).payload ?? {};
    if (b.kind === "act-fail" || b.kind === "buy-failed") {
      say({ code: b.kind, severity: "high", who: b.actor, when: b.t, msg: `${str((b.data as { action?: unknown })?.action) || b.kind}: ${oneline(str((b.data as { reason?: unknown })?.reason) || str(p.reason), 90)}` });
    }
    if (b.kind === "menu" || b.kind === "affordances") {
      const actionable = ((p.options as string[]) ?? (p.eligible as string[]) ?? []) as string[];
      const sup = (p.suppressed as Array<{ id: string; reason: string }>) ?? [];
      if (Array.isArray(actionable) && actionable.length === 0) {
        const supStr = sup.length ? ` (all ${sup.length} suppressed: ${sup.slice(0, 4).map((s) => s.reason).join(", ")})` : "";
        say({ code: "no-affordances-perceived", severity: "high", who: b.actor, when: b.t, msg: `perceived ZERO actionable affordances${b.at?.inside ? ` inside ${b.at.inside.b}` : b.at?.building ? ` at ${b.at.building}` : ""}${supStr} — the stuck precursor` });
      }
    }
    if (b.kind === "stuck") {
      say({ code: "stuck", severity: "high", who: b.actor, when: b.t, msg: `stuck ×${num(p.consecutive)}: ${oneline(str(p.why), 90)}` });
    }
  }
  return flags;
}

// ───────────────────────── the "why did X not happen" query (D32 — suppressions first-class) ────────────
function whyView(L: Loaded, agent: string): string {
  const out: string[] = [`\n${c.bold}  WHY-NOT — every evaluated-but-unfired trigger, failed act, and exclusion involving ${agent.toUpperCase()}${c.reset}`];
  const WHY_KINDS = new Set(["suppressed", "act-fail", "say-rejected", "buy-failed", "menu", "affordances", "blocked", "stuck", "ignition"]);
  let n = 0;
  for (const b of L.beats) {
    if (b.dup) continue;
    const d = (b.data ?? {}) as Record<string, unknown>;
    const p = (d.payload ?? {}) as Record<string, unknown>;
    // (a) the agent's own suppressions/failures (a NON-empty menu and a FIRED ignition aren't "why nots")
    if (b.actor === agent && WHY_KINDS.has(b.kind)) {
      if ((b.kind === "menu" || b.kind === "affordances") && (((p.options as string[]) ?? (p.eligible as string[]) ?? []).length > 0 && !(p.suppressed as unknown[])?.length)) continue;
      if (b.kind === "ignition" && p.decision === "fired") continue;
      const line = describe(b, true);
      if (line) { out.push(`  ${c.cyan}${gmClock(b.gm)}${c.reset} ${c.gray}${wallShort(b.t)}${c.reset}  ${line}${locSuffix(b)}`); n++; }
      continue;
    }
    // (b) earshot fans that EXCLUDED this agent — why they didn't hear something nearby
    if (b.kind === "earshot") {
      const ex = (d.excluded as Array<{ id: string; why: string }>) ?? [];
      const hit = ex.find((e) => e.id === agent);
      if (hit) {
        out.push(`  ${c.cyan}${gmClock(b.gm)}${c.reset} ${c.gray}${wallShort(b.t)}${c.reset}  ${c.dim}🙉 did not hear ${b.actor}'s ${str(d.kind)} — ${hit.why}${c.reset}`);
        n++;
      }
    }
  }
  if (!n) {
    out.push(L.mode === "legacy"
      ? `  ${c.yellow}no suppression/act-fail beats exist in legacy data — this query lights up on the first run taped with the D32 hooks (suppressed/act-fail/menu/earshot-excluded beats)${c.reset}`
      : `  ${c.green}nothing was suppressed, failed, or excluded for ${agent} in this run${c.reset}`);
  }
  return out.join("\n");
}

// ───────────────────────── views ─────────────────────────
function header(L: Loaded): string {
  const out: string[] = [];
  const rule = c.gray + "─".repeat(96) + c.reset;
  out.push("");
  out.push(`${c.bold}${c.cyan}  FLIGHT-TAPE REPLAY${c.reset}  ${c.dim}— ${L.label}${c.reset}`);
  out.push(rule);
  const counts = new Map<string, number>();
  for (const b of L.beats.filter((x) => !x.dup)) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  const kindStr = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join("  ");
  out.push(`  ${c.dim}source:${c.reset} ${L.mode === "tape" ? "real flight tape" : "LEGACY synthesis (events+traces+dialogue)"}   ${c.dim}agents:${c.reset} ${L.agents.join(", ")}`);
  out.push(`  ${c.dim}window:${c.reset} ${new Date(L.window.fromMs).toISOString()} → ${new Date(L.window.toMs).toISOString()}   ${c.dim}game:${c.reset} ${gmClock(L.beats.find((b) => b.gm != null)?.gm)} → ${gmClock([...L.beats].reverse().find((b) => b.gm != null)?.gm)}`);
  if (L.manifest) {
    out.push(`  ${c.dim}manifest:${c.reset} started ${L.manifest.startedTs} (gm ${L.manifest.startedGameMin}) · ended ${L.manifest.endedTs ?? "OPEN"} (${L.manifest.endReason ?? "—"}) · ${JSON.stringify(L.manifest.duration ?? {})}`);
  }
  out.push(`  ${c.dim}beats:${c.reset} ${kindStr || "none"}`);
  if (L.missing.length) {
    out.push(`  ${c.yellow}${c.bold}this source CANNOT show:${c.reset}`);
    for (const m of L.missing) out.push(`    ${c.yellow}✗${c.reset} ${m}`);
  }
  out.push(rule);
  return out.join("\n");
}

function storyView(L: Loaded): string {
  const out: string[] = [`\n${c.bold}  THE TOWN'S DAY — chronological story${c.reset}`];
  let shown = 0;
  for (const b of L.beats) {
    if (b.dup) continue;
    const line = describe(b, false);
    if (line == null) continue;
    out.push(`  ${c.cyan}${gmClock(b.gm)}${c.reset} ${c.gray}${wallShort(b.t)}${c.reset}  ${c.bold}${(b.actor ?? "").padEnd(9)}${c.reset}${line}${locSuffix(b)}`);
    shown++;
  }
  if (!shown) out.push(`  ${c.dim}(no world-visible beats in this window)${c.reset}`);
  return out.join("\n");
}

function timelineView(L: Loaded, only?: string): string {
  const out: string[] = [];
  for (const agent of L.agents) {
    if (only && agent !== only) continue;
    out.push(`\n${c.bold}  ${agent.toUpperCase()} — day timeline${c.reset}`);
    let n = 0;
    for (const b of L.beats) {
      if (b.dup || b.actor !== agent) continue;
      const line = describe(b, true);
      if (line == null) continue;
      out.push(`  ${c.cyan}${gmClock(b.gm)}${c.reset} ${c.gray}${wallShort(b.t)}${c.reset}  ${line}${locSuffix(b)}`);
      n++;
    }
    if (!n) out.push(`  ${c.dim}(no beats)${c.reset}`);
  }
  return out.join("\n");
}

function mapView(L: Loaded, atStr: string): string {
  const gmTarget = parseGameTime(atStr, L.beats);
  if (gmTarget == null) return `\n  ${c.red}cannot parse game-time "${atStr}" (use gm, "HH:MM", or "d3 21:58") or no game-clock in this source${c.reset}`;
  // last known position per agent at-or-before target
  const pos = new Map<string, { x: number; y: number; gm: number }>();
  for (const b of L.beats) {
    if (!b.actor || !b.at || typeof b.gm !== "number" || b.gm > gmTarget) continue;
    pos.set(b.actor, { x: b.at.x, y: b.at.y, gm: b.gm });
  }
  const agents = [...pos.entries()].map(([id, p]) => ({ id: `${id} (as of ${gmClock(p.gm)}${L.mode === "legacy" ? ", sparse legacy sample" : ""})`, x: p.x, y: p.y }));
  const tm = townMapAscii(L.world, agents.map((a, i) => ({ id: a.id, x: a.x, y: a.y })));
  const out = [`\n${c.bold}  TOWN MAP @ ${gmClock(gmTarget)}${c.reset}${L.mode === "legacy" ? `  ${c.yellow}(positions are the last LLM-tick sample ≤ that time — the legacy tape has no per-step positions)${c.reset}` : ""}`];
  out.push("  " + tm.lines.join("\n  "));
  out.push(`  ${c.dim}${tm.legend.join(" · ")}${c.reset}`);
  return out.join("\n");
}

function interiorView(L: Loaded, buildingId: string, atStr?: string): string {
  const b = L.world.buildings.find((x) => x.id === buildingId);
  if (!b) return `\n  ${c.red}no such building: ${buildingId}${c.reset}`;
  if (!b.interior) return `\n  ${c.yellow}${b.label} has NO interior model (see WORLD-ATLAS smells) — nothing to draw truthfully${c.reset}`;
  let occupants: Array<{ id: string; x: number; y: number }> = [];
  let caveat = "";
  if (L.mode === "tape") {
    const gmTarget = atStr ? parseGameTime(atStr, L.beats) : undefined;
    const state = new Map<string, { b: string; ix: number; iy: number }>();
    for (const bt of L.beats) {
      if (gmTarget != null && typeof bt.gm === "number" && bt.gm > gmTarget) break;
      if (!bt.actor) continue;
      if (bt.kind === "enter" && str((bt.data as { building?: unknown })?.building) === buildingId) {
        const inside = bt.at?.inside;
        state.set(bt.actor, { b: buildingId, ix: inside?.ix ?? b.interior.spawnInside.x, iy: inside?.iy ?? b.interior.spawnInside.y });
      } else if (bt.kind === "spot" && str((bt.data as { building?: unknown })?.building) === buildingId) {
        state.set(bt.actor, { b: buildingId, ix: num((bt.data as { ix?: unknown }).ix), iy: num((bt.data as { iy?: unknown }).iy) });
      } else if (bt.kind === "leave" && str((bt.data as { building?: unknown })?.building) === buildingId) {
        state.delete(bt.actor);
      }
    }
    occupants = [...state.entries()].map(([id, s]) => ({ id, x: s.ix, y: s.iy }));
    caveat = gmTarget != null ? ` @ ${gmClock(gmTarget)}` : " (tape end)";
  } else {
    caveat = ` — ${c.yellow}occupancy UNKNOWABLE from legacy data (no enter/spot/leave beats were ever persisted; the floorplan below is layout only)${c.reset}`;
  }
  const fp = floorplanAscii(b.interior, occupants);
  const out = [`\n${c.bold}  ${b.label} — interior${caveat}${c.reset}`];
  out.push("  " + fp.lines.join("\n  "));
  out.push(`  ${c.dim}${fp.legend.join(" · ")}${c.reset}`);
  return out.join("\n");
}

function flagsView(flags: Flag[]): string {
  const out: string[] = [`\n${c.bold}  ANOMALY FLAGS (${flags.length})${c.reset}`];
  const sevIcon = { high: `${c.red}⛔${c.reset}`, med: `${c.yellow}⚠️ ${c.reset}`, info: `${c.gray}ℹ️ ${c.reset}` } as const;
  const order = { high: 0, med: 1, info: 2 } as const;
  for (const f of [...flags].sort((a, b) => order[a.severity] - order[b.severity])) {
    out.push(`  ${sevIcon[f.severity]} ${c.bold}${f.code}${c.reset}${f.who ? ` ${c.cyan}${f.who}${c.reset}` : ""}${f.when ? ` ${c.gray}${wallShort(f.when)}${c.reset}` : ""} — ${f.msg}`);
  }
  if (!flags.length) out.push(`  ${c.green}none — a clean tape${c.reset}`);
  return out.join("\n");
}

// ───────────────────────── main ─────────────────────────
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.data) { DATA = args.data; RUNS = join(DATA, "runs"); }

  if (args.list) {
    const ids = listRunIds(RUNS);
    if (!ids.length) { console.log("no recorded runs yet (sim/data/runs is empty — the tape starts recording once the lead mounts the hooks)"); return; }
    for (const id of ids) {
      const m = readManifest(RUNS, id);
      console.log(`${id}  ${m?.startedTs ?? "?"} → ${m?.endedTs ?? "OPEN"}  ${m?.endReason ?? ""}  beats:${m?.beats ?? "?"}`);
    }
    return;
  }

  let L: Loaded;
  const runIds = listRunIds(RUNS);
  if (args.run || (!args.legacy && runIds.length)) {
    const id = !args.run || args.run === "latest" ? runIds[runIds.length - 1] : args.run;
    if (!id || !existsSync(join(RUNS, id))) {
      console.error(`no such run: ${args.run} (have: ${runIds.join(", ") || "none"})`);
      process.exitCode = 1;
      return;
    }
    L = loadTape(id);
  } else {
    let sinceMs: number | undefined, untilMs: number | undefined;
    if (args.since) sinceMs = Date.parse(args.since);
    if (args.until) untilMs = Date.parse(args.until);
    if (args.today || (!args.since && !args.until)) {
      const today = new Date().toISOString().slice(0, 10);
      sinceMs = Date.parse(`${today}T00:00:00Z`);
    }
    L = loadLegacy({ sinceMs, untilMs });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(L.beats, null, 1) + "\n");
    return;
  }

  const wantAll = !args.story && !args.timelines && !args.flags && !args.map && !args.interior && !args.why;
  process.stdout.write(header(L) + "\n");
  if (args.why) { process.stdout.write(whyView(L, args.why) + "\n"); }
  if (args.map) { process.stdout.write(mapView(L, args.map) + "\n"); }
  if (args.interior) { process.stdout.write(interiorView(L, args.interior, args.at) + "\n"); }
  if (wantAll || args.story) process.stdout.write(storyView(L) + "\n");
  if (wantAll || args.timelines) process.stdout.write(timelineView(L, args.agent) + "\n");
  if (wantAll || args.flags) {
    const flags = detectFlags(L, args.idleGm ?? (L.mode === "tape" ? 60 : 240));
    process.stdout.write(flagsView(flags) + "\n");
  }
}

main();
