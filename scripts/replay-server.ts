// scripts/replay-server.ts — watch a RECORDED run in the real renderer, with NO citizens and NO LLM.
//
// The live sim (sim/sim-server.ts) is the world authority while Claude-session citizens act on it. Every beat
// it saw went onto the flight tape (sim/flight-tape.ts). This server plays a tape back over the SAME wire the
// renderer already speaks (WS world/tick/event/dialogue/interior + the GET routes the feed, HUD, inspector
// cards and interior scene poll), so the whole GUI works on a recorded day: walking, bubbles, interiors,
// day/night, the activity tab. Nothing here can spawn a citizen: POST /control and /observe are refused.
//
//   npm run replay-server                                   # the bundled sample, 8x speed
//   npm run replay-server -- --tape sim/data/runs/<runId>   # any run the live sim recorded
//   npm run replay-server -- --speed 20 --from 12:00 --loop
//
// A tape dir holds tape.jsonl + manifest.json, and optionally dialogues.jsonl (closed conversations with
// their transcripts, joined by id) and traces.jsonl (per-tick citizen traces for the ACTIVITY tab). For a live
// run's dir, the sim's own sim/data/dialogue.jsonl and sim/data/traces/*.jsonl are used when those are absent.
import express from "express";
import { WebSocketServer } from "ws";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { SHOP_OWNER } from "../shops/registry.js";
import { agentActivity } from "../sim/telemetry.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = dirname(HERE); // repo root

// ---- args ----
const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const TAPE_DIR = resolve(ROOT, arg("tape", "samples/run-2026-07-18")!);
const SPEED = Number(arg("speed", "8")); // tape-seconds per real second
const MAX_GAP_MS = Number(arg("max-gap", "4")) * 1000; // quiet stretches (cold start, long LLM turns) compress to this
const PORT = Number(arg("port", process.env.PORT ?? "4042"));
const LOOP = argv.includes("--loop");
const FROM = arg("from"); // "HH:MM" game time to fast-forward to

// ---- load ----
type Loc = { x: number; y: number; building?: string | null; inside?: { b: string; ix: number; iy: number; spot?: string } };
type Beat = { t: string; gm: number; seq: number; kind: string; actor?: string; at?: Loc; data?: Record<string, any> };
const readJsonl = <T>(p: string): T[] =>
  existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }) : [];

if (!existsSync(join(TAPE_DIR, "tape.jsonl"))) {
  console.error(`no tape.jsonl in ${TAPE_DIR}`);
  process.exit(1);
}
const beats = readJsonl<Beat>(join(TAPE_DIR, "tape.jsonl")).sort((a, b) => a.seq - b.seq);
const manifest = existsSync(join(TAPE_DIR, "manifest.json")) ? JSON.parse(readFileSync(join(TAPE_DIR, "manifest.json"), "utf8")) : {};
// a live run dir sits at sim/data/runs/<id>/, so its sim-wide files are two levels up
const simData = resolve(TAPE_DIR, "..", "..");
const dialogueRows = existsSync(join(TAPE_DIR, "dialogues.jsonl"))
  ? readJsonl<Record<string, any>>(join(TAPE_DIR, "dialogues.jsonl"))
  : readJsonl<Record<string, any>>(join(simData, "dialogue.jsonl"));
const dialogueById = new Map(dialogueRows.map((d) => [String(d.id), d]));
const traces: Array<{ ts: string; id: string; [k: string]: unknown }> = existsSync(join(TAPE_DIR, "traces.jsonl"))
  ? readJsonl(join(TAPE_DIR, "traces.jsonl"))
  : existsSync(join(simData, "traces"))
    ? readdirSync(join(simData, "traces")).flatMap((f) => readJsonl<any>(join(simData, "traces", f)))
    : [];

const world = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8"));
for (const b of world.buildings) if (b.type === "shop") b.owner = SHOP_OWNER[b.id];

// ---- virtual timeline: tape wall-clock with quiet gaps capped, so a replay never sits on a frozen town ----
const vt: number[] = [];
{
  let v = 0;
  let prev = beats.length ? Date.parse(beats[0].t) : 0;
  for (const b of beats) {
    const t = Date.parse(b.t);
    v += Math.min(Math.max(0, t - prev), MAX_GAP_MS);
    prev = t;
    vt.push(v);
  }
}
const END_V = vt.length ? vt[vt.length - 1] : 0;

// ---- replay state (same shapes the sim broadcasts) ----
const COLORS = ["#ff9100", "#00d4ff", "#6ee7b7", "#ff5247", "#c084fc", "#fbbf24", "#34d399", "#f472b6"];
const rosterIds: string[] = (manifest.roster ?? []).map((r: { id: string }) => r.id);
for (const b of beats) if (b.actor && !rosterIds.includes(b.actor)) rosterIds.push(b.actor);
type Agent = { id: string; x: number; y: number; color: string; moving: boolean; adjacentTo: string[] };
type Occupant = { id: string; x: number; y: number; sublocationId?: string };
type Ev = { ts: string; actor: string; kind: string; payload?: unknown };

let agents: Agent[] = [];
let inside = new Map<string, { b: string; occ: Occupant }>();
let eventLog: Ev[] = [];
let dialogueLog: Array<Record<string, unknown>> = [];
let cursor = 0; // index of the next beat to apply
let vNow = 0; // virtual ms into the tape
let tickNo = 0;
let broadcast: (o: unknown) => void = () => {};
const RING = 200;

function reset() {
  const spawns = world.spawns ?? {};
  agents = rosterIds.map((id, i) => {
    const first = beats.find((b) => b.actor === id && b.at);
    const s = first?.at ?? spawns[id] ?? { x: 8 + i * 5, y: 7 };
    return { id, x: s.x, y: s.y, color: COLORS[i % COLORS.length], moving: false, adjacentTo: [] };
  });
  inside = new Map();
  eventLog = [];
  dialogueLog = [];
  cursor = 0;
  vNow = 0;
}
const byId = (id: string) => agents.find((a) => a.id === id);
const occupantsOf = (b: string): Occupant[] => [...inside.values()].filter((v) => v.b === b).map((v) => v.occ);

// Apply one beat. `live` = broadcast it (false while fast-forwarding with --from).
function apply(b: Beat, live: boolean) {
  const a = b.actor ? byId(b.actor) : undefined;
  if (a && b.at) {
    a.x = b.at.x;
    a.y = b.at.y;
    if (b.kind === "pos") a.moving = !!b.data?.moving;
    const was = inside.get(a.id)?.b ?? null;
    const now = b.at.inside?.b ?? null;
    if (now) inside.set(a.id, { b: now, occ: { id: a.id, x: b.at.inside!.ix, y: b.at.inside!.iy, ...(b.at.inside!.spot ? { sublocationId: b.at.inside!.spot } : {}) } });
    else inside.delete(a.id);
    if (live) for (const bid of new Set([was, now].filter(Boolean) as string[])) broadcast({ type: "interior", building: bid, occupants: occupantsOf(bid) });
  }
  if (b.kind === "dialogue" && b.data) {
    // the tape keeps the summary; the transcript (the actual back-and-forth) lives in the dialogue log
    const d = { ...b.data, ...(dialogueById.get(String(b.data.id)) ?? {}) };
    dialogueLog.push(d);
    if (dialogueLog.length > RING) dialogueLog.shift();
    if (live) broadcast({ type: "dialogue", op: "record", ...d });
  } else if (a && b.data && "payload" in b.data) {
    // an event beat (the sim's recordEvent choke-point): forward it to the feed + on-map bubbles
    const ev: Ev = { ts: b.t, actor: a.id, kind: b.kind, payload: b.data.payload };
    eventLog.push(ev);
    if (eventLog.length > RING) eventLog.shift();
    if (live) broadcast({ type: "event", ...ev });
  }
}

function gameMinutesNow(): number {
  if (!beats.length) return 0;
  const i = Math.min(cursor, beats.length - 1);
  const prev = cursor > 0 ? cursor - 1 : 0;
  const v0 = vt[prev], v1 = vt[i], g0 = beats[prev].gm, g1 = beats[i].gm;
  const f = v1 > v0 ? Math.min(1, Math.max(0, (vNow - v0) / (v1 - v0))) : 1;
  return g0 + (g1 - g0) * f;
}
const finished = () => cursor >= beats.length;
function runState() {
  const gm = Math.floor(gameMinutesNow());
  return {
    status: finished() ? "stopped" : "running",
    reason: finished() ? "replay-ended" : null,
    duration: manifest.duration ?? null,
    elapsedMs: Math.round(vNow),
    remainingMs: Math.max(0, Math.round((END_V - vNow) / Math.max(SPEED, 0.01))),
    gameClock: { day: Math.floor(gm / 1440) + 1, hh: Math.floor((gm % 1440) / 60), mm: gm % 60 },
    gameMinutes: gm,
    viewers: wss ? wss.clients.size : 0,
    ceilingUsd: manifest.ceilingUsd ?? 0,
    fleetUsd: 0,
    roster: rosterIds.map((id) => ({ id, name: id, enabled: true, model: "replay" })),
    replay: { runId: manifest.runId ?? null, speed: SPEED, beats: beats.length, at: cursor },
  };
}
const usage = () => ({ fleet: { ticks: 0, apiEquivUsd: 0, tokensIn: 0, tokensOut: 0, cacheWrite: 0, cacheRead: 0, lastTickAt: null }, perAgent: {}, ceilingUsd: manifest.ceilingUsd ?? 0 });
const tickAgents = () => agents.map((a) => ({ id: a.id, x: a.x, y: a.y, color: a.color, moving: a.moving, adjacentTo: a.adjacentTo }));

// ---- HTTP: the renderer's routes, answered from the tape ----
const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, "renderer")));
app.get("/meta", (_q, r) => r.json({ agents: rosterIds, buildings: world.buildings.map((b: { id: string }) => b.id), replay: true }));
app.get("/snapshot", (_q, r) => r.json({ agents: tickAgents() }));
app.get("/run-state", (_q, r) => r.json(runState()));
app.get("/usage", (_q, r) => r.json(usage()));
app.get("/events", (q, r) => {
  const n = Math.min(Number(q.query.recent) || RING, RING);
  r.json({ events: eventLog.slice(-n), dialogues: dialogueLog.slice(-n) });
});
app.get("/who-inside/:building", (q, r) => r.json({ building: q.params.building, occupants: occupantsOf(q.params.building) }));
app.get("/agent/:id", (q, r) => {
  const a = byId(q.params.id);
  if (!a) return r.status(404).json({ error: "no such agent" });
  let spent = 0, earned = 0;
  for (const e of eventLog) {
    const p = (e.payload ?? {}) as { price_usdc?: number; counterparty?: string };
    if (e.kind === "purchase" && e.actor === a.id) spent += Number(p.price_usdc ?? 0);
    if (e.kind === "purchase" && p.counterparty === a.id) earned += Number(p.price_usdc ?? 0);
  }
  // wallets are not part of a replay: the balance is unknown and the address stays private
  return r.json({ id: a.id, address: "replay · wallet not shown", color: a.color, x: a.x, y: a.y, usdc: null, spent, earned, inventory: [] });
});
app.get("/agent/:id/activity", (q, r) => {
  const now = cursor > 0 ? beats[cursor - 1].t : "";
  const recent = Math.min(Number(q.query.recent) || 50, 500);
  const items = agentActivity(q.params.id, traces.filter((t) => t.ts <= now) as any, eventLog as any, recent);
  r.json({ id: q.params.id, count: items.length, items });
});
const refuse = (_q: unknown, r: express.Response) => r.status(409).json({ ok: false, error: "replay mode: there are no live citizens to control" });
app.post("/control", refuse);
app.post("/observe", refuse);

const server = app.listen(PORT, "127.0.0.1", () => // loopback only, never the LAN
  console.log(`▶ replaying ${manifest.runId ?? TAPE_DIR} (${beats.length} beats, ${dialogueById.size} transcripts, ${traces.length} traces) at ${SPEED}x on http://localhost:${PORT}`),
);
const wss = new WebSocketServer({ server });
broadcast = (o) => {
  const s = JSON.stringify(o);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "world", world, agents: tickAgents() }));
  ws.send(JSON.stringify({ type: "run-state", ...runState() }));
  ws.send(JSON.stringify({ type: "usage", ...usage() }));
  for (const b of new Set([...inside.values()].map((v) => v.b))) ws.send(JSON.stringify({ type: "interior", building: b, occupants: occupantsOf(b) }));
});

// ---- the clock: same 2 Hz cadence as the sim ----
reset();
if (FROM) {
  const [hh, mm] = FROM.split(":").map(Number);
  const target = hh * 60 + (mm || 0);
  const startGm = beats[0]?.gm ?? 0;
  const day0 = Math.floor(startGm / 1440) * 1440;
  const goal = day0 + target < startGm ? day0 + 1440 + target : day0 + target;
  while (!finished() && beats[cursor].gm < goal) { apply(beats[cursor], false); vNow = vt[cursor]; cursor++; }
}
setInterval(() => {
  if (finished()) {
    if (!LOOP) return;
    reset();
    broadcast({ type: "world", world, agents: tickAgents() });
  }
  vNow += 500 * SPEED;
  while (!finished() && vt[cursor] <= vNow) apply(beats[cursor++], true);
  for (const a of agents) a.adjacentTo = [];
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++) {
      const A = agents[i], B = agents[j];
      if (Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y)) <= 1) { A.adjacentTo.push(B.id); B.adjacentTo.push(A.id); }
    }
  tickNo++;
  broadcast({ type: "tick", tick: tickNo, agents: tickAgents() });
  if (tickNo % 4 === 0) broadcast({ type: "run-state", ...runState() });
}, 500);
