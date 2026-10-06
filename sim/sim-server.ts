import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { usdc } from "../lib.js";
import * as inventory from "../economy/inventory.js";
import { SHOP_OWNER, GOOD_TO_SHOP } from "../shops/registry.js";
import { RunState, type RosterEntry, type Duration } from "./run-state.js";
import { WorldTree, SeenSubgraph } from "./world-tree.js";
import { assemblePerception } from "./perception.js";
import { computeTelemetry, loadTelemetryInput, loadAgentActivity } from "./telemetry.js";
import { InteriorPresence, interiorOf } from "./interiors.js";
import { earshotAudience, agentLoc, approachDeltas, type NearbyEventVerb } from "./earshot.js";
import { FlightTape, type TapeLoc } from "./flight-tape.js"; // T0-tape (flightrecorder H1)
import { stepAt } from "../citizens/schedules.js"; // T0-spine §3: pure schedule data — the sim still never calls an LLM

// Phase 2 — movement + perception. The sim-server is the world authority (never calls an LLM):
// grid A* pathfinding, POST /act (goTo/moveTo), GET /perceive (senses), co-location/adjacency,
// and a 2 Hz tick loop that steps paths and broadcasts the world. A scripted driver (npm run drive)
// posts random goTo's; Phase 3 swaps that for real Claude citizens.
const HERE = dirname(fileURLToPath(import.meta.url)); // sim/
const ROOT = dirname(HERE); // repo root
const world = JSON.parse(readFileSync(join(HERE, "world.json"), "utf8"));
// W2b: the map-as-tree (env→NL) + per-agent seen-subgraphs (the sim owns them — it has every position).
const tree = new WorldTree(world as any);
const seenByAgent = new Map<string, SeenSubgraph>();
const seenFor = (id: string): SeenSubgraph => {
  let s = seenByAgent.get(id);
  if (!s) { s = new SeenSubgraph(tree, id); seenByAgent.set(id, s); }
  return s;
};
const W: number = world.width;
const Hh: number = world.height;
const streetTop: number = world.street.rows[0];

// Tag each shop with its owner (citizen id) so the renderer/inspector can show shop balances.
for (const b of world.buildings) if (b.type === "shop") b.owner = SHOP_OWNER[b.id];

// ---- walkability: the street + sidewalk lanes, plus each shop/home door + the tile just inside ----
const lanes = new Set<number>([...world.street.rows, ...world.sidewalks.rows]);
const tileBuilding = new Map<string, string>(); // "x,y" (door + inside tile) -> buildingId
function insideTile(b: any): [number, number] {
  // T0-spine §1: the footprint row ADJACENT TO THE DOOR. The old north/south-of-street heuristic assumed
  // every south building's door faces north — college/dorm/pub have SOUTH doors, so their inside tile landed
  // on the far row with no walkable neighbor → astar []→ goTo answered steps:0 → "you are already at pub".
  const doorBelow = b.door.y >= b.y + b.h; // door sits under the south edge
  return [b.door.x, doorBelow ? b.y + b.h - 1 : b.y];
}
for (const b of world.buildings) {
  const [ix, iy] = insideTile(b);
  tileBuilding.set(`${ix},${iy}`, b.id);
  tileBuilding.set(`${b.door.x},${b.door.y}`, b.id);
}
// T0-spine §0: THE MAP WAS TWO ISLANDS — rows-only walkability ignored world.json lanes.cols (the x=31/32
// Johnson Park bridge), disconnecting the north corridor (all 5 shops) from the south (pub/college/dorm).
type LaneCol = { x: number; y0: number; y1: number };
const laneCols: LaneCol[] = world.lanes?.cols ?? [];
function walkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= W || y >= Hh) return false;
  if (lanes.has(y) || tileBuilding.has(`${x},${y}`)) return true;
  return laneCols.some((c) => x === c.x && y >= c.y0 && y <= c.y1);
}

// ---- A* (4-connected, Manhattan heuristic) ----
function astar(sx: number, sy: number, tx: number, ty: number): Array<[number, number]> {
  if (!walkable(tx, ty) || (sx === tx && sy === ty)) return [];
  const h = (x: number, y: number) => Math.abs(x - tx) + Math.abs(y - ty);
  const g = new Map<string, number>([[`${sx},${sy}`, 0]]);
  const f = new Map<string, number>([[`${sx},${sy}`, h(sx, sy)]]);
  const came = new Map<string, string>();
  const open = new Set<string>([`${sx},${sy}`]);
  while (open.size) {
    let cur = "";
    let best = Infinity;
    for (const k of open) {
      const fv = f.get(k) ?? Infinity;
      if (fv < best) { best = fv; cur = k; }
    }
    const [cx, cy] = cur.split(",").map(Number);
    if (cx === tx && cy === ty) {
      const path: Array<[number, number]> = [];
      let k = cur;
      while (came.has(k)) {
        const [px, py] = k.split(",").map(Number);
        path.unshift([px, py]);
        k = came.get(k)!;
      }
      return path;
    }
    open.delete(cur);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(nx, ny)) continue;
      const nk = `${nx},${ny}`;
      const ng = (g.get(cur) ?? Infinity) + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        came.set(nk, cur);
        g.set(nk, ng);
        f.set(nk, ng + h(nx, ny));
        open.add(nk);
      }
    }
  }
  return [];
}

// ---- agents ----
const COLORS = ["#ff9100", "#00d4ff", "#6ee7b7", "#ff5247", "#c084fc", "#fbbf24", "#34d399", "#f472b6"];
type Agent = { id: string; x: number; y: number; color: string; address?: string; path: Array<[number, number]>; adjacentTo: string[] };
let ids = ["baker", "barista", "grocer", "courier", "smith"];
const addrById: Record<string, string> = {};
const ks = join(ROOT, "citizens.local.json");
if (existsSync(ks)) {
  try {
    const cs = JSON.parse(readFileSync(ks, "utf8")) as Array<{ id: string; address: string }>;
    ids = cs.map((c) => c.id);
    for (const c of cs) addrById[c.id] = c.address;
  } catch { /* keep defaults */ }
}
const spawns: Record<string, { x: number; y: number }> = world.spawns ?? {};
const agents: Agent[] = ids.map((id, i) => {
  const s = spawns[id] ?? { x: 8 + i * 5, y: 7 };
  return { id, x: s.x, y: s.y, color: COLORS[i % COLORS.length], address: addrById[id], path: [], adjacentTo: [] };
});
const byId = new Map(agents.map((a) => [a.id, a]));

// ---- roster (enable/disable + per-agent model) — the data-driven control surface for the fleet.
// W0: derived from the live agent ids with safe defaults; the full 25-citizen roster lands later. The SIM
// is the authority for enabled/model — citizens read their own entry from GET /run-state and gate on it.
const DEFAULT_MODEL = process.env.CITIZEN_MODEL ?? "claude-haiku-4-5-20251001";
const roster: RosterEntry[] = ids.map((id) => ({ id, name: id, enabled: true, model: DEFAULT_MODEL }));

function buildingTarget(bid: string): [number, number] | null {
  const b = world.buildings.find((x: any) => x.id === bid);
  return b ? insideTile(b) : null;
}

// ---- HTTP ----
const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, "renderer")));

// ---- events: the sim is the SINGLE writer to events.jsonl + the WS broadcaster ----
// Citizens POST /event (or /act say/buyResult); the sim records + broadcasts {type:"event"} so the
// renderer feed and the tx-overlay both see every action and every on-chain settlement.
const DATA = join(ROOT, "sim", "data");
mkdirSync(DATA, { recursive: true });
const EVENTS = join(DATA, "events.jsonl");
const DIALOGUES = join(DATA, "dialogue.jsonl"); // W2b: closed conversation summaries (the sim is the single writer)
// W2b: in-memory rings of recent dialogues + trades, surfaced per-agent via /perceive so the PARTNER (and the
// seller) folds the tie into its OWN relationship graph on its next tick (the initiator/buyer already did).
const dialogueLog: Array<Record<string, unknown>> = [];
const tradeLog: Array<Record<string, unknown>> = [];
const eventLog: Array<Record<string, unknown>> = []; // #15: recent-event ring so the feed can hydrate on refresh
const sayLog: Array<Record<string, unknown>> = []; // #18: recent one-way say()s so /perceive can surface inbound says DIRECTLY (un-drowned by the listener's own activity)
const interiors = new InteriorPresence(); // B1: the sim OWNS interior presence (world authority); citizens mutate via /act only
const RING = 200;
// interior EARSHOT (interiorist): nearby agents OVERHEAR a say/dialogue, and SENSE presence-deltas (X entered/
// left/sat/moved). Fanned to the in-earshot audience via the pure sim/earshot.ts. Additive rings (like sayLog);
// surfaced per-listener in /perceive (overheard + nearbyEvents). The MATH is pure; only the sim knows all positions.
const overheardLog: Array<Record<string, unknown>> = [];
const nearbyEventsLog: Array<Record<string, unknown>> = [];
const nowGM = () => runState.snapshot(roster).gameMinutes;
function locsForEarshot() {
  return agents.map((a) => {
    const w = interiors.whereInside(a.id);
    return agentLoc(a.id, { x: a.x, y: a.y }, w ? { buildingId: w.buildingId, occupant: w.occupant } : undefined);
  });
}
function fanOverheard(speaker: string, participants: string[], gist: string, kind: "say" | "dialogue", to?: string, mentionedBelief?: boolean) {
  const at = interiors.whereInside(speaker)?.occupant.sublocationId;
  const listeners: string[] = []; // T0-tape H6: capture the audience — earshot delivery used to live only in this RAM ring
  for (const listener of earshotAudience(speaker, participants, locsForEarshot())) {
    listeners.push(listener);
    overheardLog.push({ listener, from: speaker, gist, atGameMin: nowGM(), kind, ...(to ? { to } : {}), ...(at ? { at } : {}), ...(mentionedBelief != null ? { mentionedBelief } : {}) });
  }
  if (overheardLog.length > RING) overheardLog.splice(0, overheardLog.length - RING);
  tape.earshot(speaker, tapeLoc(speaker), { kind, ...(to ? { to } : {}), audience: listeners, gist: gist.slice(0, 80) }); // T0-tape
}
function fanNearbyEvent(actor: string, verb: NearbyEventVerb, place: string) {
  const listeners: string[] = []; // T0-tape H7
  for (const listener of earshotAudience(actor, [actor], locsForEarshot())) {
    listeners.push(listener);
    nearbyEventsLog.push({ listener, actor, verb, place, atGameMin: nowGM() });
  }
  if (nearbyEventsLog.length > RING) nearbyEventsLog.splice(0, nearbyEventsLog.length - RING);
  tape.nearby(actor, { verb, place, audience: listeners }); // T0-tape
}
let prevLocs: ReturnType<typeof locsForEarshot> = []; // T0-weave S4: last tick's fleet positions for street-approach deltas
let broadcast: (o: unknown) => void = () => {};
function recordEvent(e: { actor: string; kind: string; payload?: unknown; related_id?: string; txHash?: string }) {
  tape.event(e, tapeLoc(e.actor)); // T0-tape H3: the single-writer choke-point — every beat, located at emit time
  const ev: Record<string, unknown> = { ts: new Date().toISOString(), ...e };
  if (e.txHash) ev.explorer = `https://sepolia.basescan.org/tx/${e.txHash}`;
  try {
    appendFileSync(EVENTS, JSON.stringify(ev) + "\n");
  } catch {
    /* ignore disk errors */
  }
  broadcast({ type: "event", ...ev });
  eventLog.push(ev); // #15: keep a recent ring so a browser refresh can re-hydrate the activity feed (GET /events)
  if (eventLog.length > RING) eventLog.shift();
  // #18: tap one-way say()s into a dedicated ring so the TARGET hears them via /perceive heardRecently — they
  // were getting drowned in recentDigest's last-8 window under the listener's own 7-14x activity (559 says:10 replies).
  if (e.kind === "say" && e.payload && typeof e.payload === "object") {
    const p = e.payload as { to?: string; text?: string };
    sayLog.push({ id: `${ev.ts}|${e.actor}|${p.to ?? ""}`, from: e.actor, to: p.to, text: p.text, ts: ev.ts });
    if (sayLog.length > RING) sayLog.shift();
  }
  // W2b: tap purchases into the trade ring so both the buyer and the seller form trade-graph edges.
  if (e.kind === "purchase" && e.payload && typeof e.payload === "object") {
    const p = e.payload as { item?: string; counterparty?: string; price_usdc?: number };
    tradeLog.push({ id: e.txHash ?? `${ev.ts}|${e.actor}|${p.item}`, buyer: e.actor, seller: p.counterparty, item: p.item, priceUsdc: p.price_usdc });
    if (tradeLog.length > RING) tradeLog.shift();
  }
}

// Rebuild the custody store from the event ledger so holdings survive a sim restart.
try {
  const lines = existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").split("\n").filter(Boolean) : [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as { kind?: string; actor?: string; txHash?: string; payload?: any };
      // T0-weave S2: NET custody replay. Purchases-only replay re-minted every good ever bought (baker booted
      // with coffee×209 — a replay artifact) → "don't over-buy" reasoning killed all demand since 2026-06-18.
      if (e.kind === "purchase" && e.actor && e.payload?.item) {
        inventory.transfer({ to: e.actor, from: e.payload.counterparty, item: e.payload.item, txHash: e.txHash, shop: e.payload.shop });
      } else if ((e.kind === "consume" || e.kind === "use") && e.actor && e.payload?.item) {
        inventory.consume(e.actor, String(e.payload.item));
      } else if (e.kind === "give" && e.actor && e.payload?.item && e.payload?.to) {
        inventory.gift(e.actor, String(e.payload.to), String(e.payload.item));
      } else if (e.kind === "produce" && e.actor && e.payload?.good) {
        inventory.produce(e.actor, String(e.payload.good));
      } else if (e.kind === "pick_up" && e.actor && e.payload?.item && e.payload?.place) {
        inventory.pickUp(e.actor, String(e.payload.place), String(e.payload.item));
      } else if (e.kind === "drop" && e.actor && e.payload?.item && e.payload?.place) {
        inventory.drop(e.actor, String(e.payload.place), String(e.payload.item));
      }
    } catch {
      /* skip bad line */
    }
  }
} catch {
  /* no ledger yet */
}

// T0-weave S3: seed the sayLog ring from the ledger tail so a say near run-end is answerable next run
// (courier's 19:29 say to barista died in RAM today when the run stopped).
try {
  const lines = existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").split("\n").filter(Boolean) : [];
  for (const l of lines.slice(-200)) {
    try {
      const e = JSON.parse(l) as { ts?: string; kind?: string; actor?: string; payload?: { to?: string; text?: string } };
      if (e.kind === "say" && e.actor) {
        sayLog.push({ id: `${e.ts}|${e.actor}|${e.payload?.to ?? ""}`, from: e.actor, to: e.payload?.to, text: e.payload?.text, ts: e.ts });
        if (sayLog.length > RING) sayLog.shift();
      }
    } catch {
      /* skip bad line */
    }
  }
} catch {
  /* no ledger yet */
}

// ---- run-state machine + roster persistence (the INC-2026-06-18 governor; sim owns it, citizens gate on it) ----
const runState = new RunState(join(DATA, "run-state.json"));
const ROSTER_STATE = join(DATA, "roster-state.json");
function loadRosterState() {
  try {
    if (!existsSync(ROSTER_STATE)) return;
    const saved = JSON.parse(readFileSync(ROSTER_STATE, "utf8")) as Record<string, { enabled?: boolean; model?: string }>;
    for (const e of roster) {
      const s = saved[e.id];
      if (s) {
        if (typeof s.enabled === "boolean") e.enabled = s.enabled;
        if (s.model) e.model = s.model;
      }
    }
  } catch {
    /* keep defaults */
  }
}
function saveRosterState() {
  try {
    const o: Record<string, { enabled: boolean; model: string }> = {};
    for (const e of roster) o[e.id] = { enabled: e.enabled, model: e.model };
    writeFileSync(ROSTER_STATE, JSON.stringify(o, null, 2));
  } catch {
    /* ignore disk errors */
  }
}
loadRosterState();

// T0-tape H2: the flight tape — every world beat, located in both coord spaces, run-scoped (audit 2026-07-18).
// ORDERING: must be created AFTER runState (the constructor may reopen a dangling run and call the clock).
const tape = new FlightTape(join(DATA, "runs"), (): number => Number(runState.snapshot(roster).gameMinutes) || 0, { resumeOpenRun: runState.snapshot(roster).status !== "stopped" });
const tapeLoc = (id: string): TapeLoc | undefined => {
  const a = byId.get(id);
  if (!a) return undefined;
  const w = interiors.whereInside(id);
  return {
    x: a.x, y: a.y,
    building: tileBuilding.get(`${a.x},${a.y}`) ?? null,
    ...(w ? { inside: { b: w.buildingId, ix: w.occupant.x, iy: w.occupant.y, ...(w.occupant.sublocationId ? { spot: w.occupant.sublocationId } : {}) } } : {}),
  };
};

// ---- usage / token-meter aggregation (operator visibility into fleet burn; API-equiv, notional on a subscription) ----
type Usage = { ticks: number; apiEquivUsd: number; tokensIn: number; tokensOut: number; cacheWrite: number; cacheRead: number; lastTickAt: number | null };
const zeroUsage = (): Usage => ({ ticks: 0, apiEquivUsd: 0, tokensIn: 0, tokensOut: 0, cacheWrite: 0, cacheRead: 0, lastTickAt: null });
const perAgentUsage = new Map<string, Usage>();
function usagePayload() {
  const fleet = zeroUsage();
  const perAgent: Record<string, Usage & { model: string; enabled: boolean }> = {};
  for (const e of roster) {
    const u = perAgentUsage.get(e.id) ?? zeroUsage();
    fleet.ticks += u.ticks;
    fleet.apiEquivUsd += u.apiEquivUsd;
    fleet.tokensIn += u.tokensIn;
    fleet.tokensOut += u.tokensOut;
    fleet.cacheWrite += u.cacheWrite;
    fleet.cacheRead += u.cacheRead;
    perAgent[e.id] = { ...u, model: e.model, enabled: e.enabled };
  }
  return { fleet, perAgent, ceilingUsd: runState.ceilingUsd() };
}

// WS broadcast helpers for the GUI control plane (the `broadcast` fn is assigned with the WSS below).
function broadcastRunState() {
  broadcast({ type: "run-state", ...runState.snapshot(roster) });
}
function broadcastUsage() {
  broadcast({ type: "usage", ...usagePayload() });
}

app.get("/meta", (_q, r) =>
  r.json({ agents: agents.map((a) => a.id), buildings: world.buildings.map((b: any) => b.id) }),
);

// W2b: the town map-as-tree rendered to NL (the keystone), for the GUI / inspector / debugging.
app.get("/world-tree", (_q, r) =>
  r.json({ town: tree.townToNL(), areas: (world.areas ?? []).map((a: any) => a.id), buildings: tree.buildings().map((b) => b.id) }),
);
app.get("/world-tree/:id", (req, r) => {
  const b = tree.building(req.params.id);
  return b ? r.json({ id: b.id, nl: tree.buildingToNL(b, true), rooms: b.rooms }) : r.status(404).json({ error: "no such building" });
});

app.get("/snapshot", (_q, r) =>
  r.json({ agents: agents.map((a) => ({ id: a.id, x: a.x, y: a.y, color: a.color, moving: a.path.length > 0, adjacentTo: a.adjacentTo })) }),
);

// Citizen inventory read-path (cheap, in-memory) — backs the `inventory` tool.
app.get("/inventory/:id", (req, r) => {
  const a = byId.get(req.params.id);
  if (!a) return r.status(404).json({ error: "no such agent" });
  return r.json({ id: a.id, counts: inventory.counts(a.id), holdings: inventory.get(a.id) });
});

// B1: who is inside a building right now (interior-local coords) — renderer occupancy badge + B2 interior scene.
app.get("/who-inside/:building", (req, r) => {
  const building = String(req.params.building);
  return r.json({ building, occupants: interiors.occupantsOf(building) });
});

app.post("/act", (req, r) => {
  const { agent, action, to, x, y } = req.body ?? {};
  const a = byId.get(agent);
  if (!a) return r.status(404).json({ error: "no such agent" });
  if (action === "say") return r.json({ ok: true }); // canonical say comes via POST /event
  if (action === "buyResult") {
    // Tie custody to the on-chain settlement: move one unit of `item` from the SELLER (shop owner)
    // to the buyer, stamped with the txHash that paid for it.
    const { item, txHash } = req.body ?? {};
    const shopId = GOOD_TO_SHOP[item as string];
    const seller = shopId ? SHOP_OWNER[shopId] : undefined;
    if (item && seller) inventory.transfer({ to: agent, from: seller, item, txHash, shop: shopId });
    return r.json({ ok: true });
  }
  if (action === "consume") {
    // Use up one held unit so the need recurs → the citizen rebuys (the demand loop).
    const { item } = req.body ?? {};
    const consumed = item ? inventory.consume(agent, item) : null;
    const remaining = inventory.counts(agent)[item as string] ?? 0;
    if (consumed) recordEvent({ actor: agent, kind: "consume", payload: { item, remaining } }); // sim is the single writer
    return r.json({ ok: true, consumed, remaining });
  }
  if (action === "give") {
    // S1-3: hand one HELD unit to an ADJACENT citizen as a GIFT — real custody moves, NO money/txHash.
    const { item, toId } = req.body ?? {};
    const recip = toId ? byId.get(String(toId)) : undefined;
    if (!item || !recip) return r.json({ ok: false, given: false, note: "give needs {item, toId} and a real recipient" });
    const cheb = Math.max(Math.abs(recip.x - a.x), Math.abs(recip.y - a.y));
    if (cheb > 1) return r.json({ ok: false, given: false, note: `you must be adjacent to ${recip.id} to give them something` });
    const moved = inventory.gift(agent, recip.id, String(item)); // NON-minting: null if you don't hold it
    if (!moved) return r.json({ ok: false, given: false, note: `you have no ${item} to give` });
    recordEvent({ actor: agent, kind: "give", payload: { item, to: recip.id } }); // single writer; NO txHash (a gift isn't paid)
    return r.json({ ok: true, given: true, item, to: recip.id });
  }
  if (action === "pick_up") {
    // S1-3: pick up one unit lying on the ground where you stand.
    const { item } = req.body ?? {};
    const place = tileBuilding.get(`${a.x},${a.y}`) ?? `${a.x},${a.y}`;
    const picked = item ? inventory.pickUp(agent, place, String(item)) : null;
    if (!picked) return r.json({ ok: false, picked: false, place, note: `no ${item} on the ground here` });
    recordEvent({ actor: agent, kind: "pick_up", payload: { item, place } });
    return r.json({ ok: true, picked: true, item, place });
  }
  if (action === "drop") {
    // S1-3: set down one held unit onto the ground where you stand.
    const { item } = req.body ?? {};
    const place = tileBuilding.get(`${a.x},${a.y}`) ?? `${a.x},${a.y}`;
    const dropped = item ? inventory.drop(agent, place, String(item)) : null;
    if (!dropped) return r.json({ ok: false, dropped: false, place, note: `you have no ${item} to drop` });
    recordEvent({ actor: agent, kind: "drop", payload: { item, place } });
    return r.json({ ok: true, dropped: true, item, place });
  }
  if (action === "use") {
    // S1-3: use up one held unit (generalizes consume). Same custody effect + a `use` event.
    const { item } = req.body ?? {};
    const used = item ? inventory.consume(agent, String(item)) : null;
    const remaining = inventory.counts(agent)[item as string] ?? 0;
    if (used) recordEvent({ actor: agent, kind: "use", payload: { item, remaining } });
    return r.json({ ok: true, used, remaining });
  }
  if (action === "produce") {
    // S1-2: a producer makes one unit of stock into their OWN inventory. NO money, NO txHash (they made it).
    const { good } = req.body ?? {};
    if (!good) return r.json({ ok: false, produced: false, note: "produce needs {good}" });
    const made = inventory.produce(agent, String(good));
    const have = inventory.counts(agent)[good as string] ?? 0;
    recordEvent({ actor: agent, kind: "produce", payload: { good, have } }); // single writer; no related_id (not a buy)
    return r.json({ ok: true, produced: true, good, have });
  }
  if (action === "goInside") {
    // B4: move the agent to a sub-location WITHIN the interior it's currently inside (sit/work/study/busk spot).
    const { sublocationId } = req.body ?? {};
    const pos = sublocationId ? interiors.moveToSublocation(agent, String(sublocationId)) : null;
    if (!pos) return r.json({ ok: false, inside: false, note: `you're not inside a building with a spot called "${sublocationId}" — enter the building first (move there), then go_inside a listed spot` });
    const where = interiors.whereInside(agent)!;
    const sub = interiorOf(where.buildingId)?.sublocations.find((s) => s.id === pos.sublocationId);
    broadcast({ type: "interior", building: where.buildingId, occupants: interiors.occupantsOf(where.buildingId) }); // live-update the interior scene
    // earshot: people in the room sense X sat/moved (go_inside always lands ON a spot — never clears one, so never "stood")
    fanNearbyEvent(agent, sub?.kind === "table" || sub?.kind === "seat" ? "sat" : "moved", pos.sublocationId ?? where.buildingId);
    tape.spot(agent, tapeLoc(agent), { building: where.buildingId, spot: pos.sublocationId ?? "", label: sub?.label, ix: pos.x, iy: pos.y, kind: sub?.kind }); // T0-tape H5: the station-take beat — the missing evidence behind "baker in the doorway"
    return r.json({ ok: true, inside: true, sublocationId: pos.sublocationId, label: sub?.label ?? pos.sublocationId, x: pos.x, y: pos.y });
  }
  let target: [number, number] | null = null;
  if (action === "goTo") {
    target = buildingTarget(to);
    if (!target) return r.status(400).json({ error: "bad target" });
    const already = a.x === target[0] && a.y === target[1];
    a.path = astar(a.x, a.y, target[0], target[1]);
    tape.path(agent, tapeLoc(agent), action, { to }, a.path); // T0-tape H4: intent + planned route
    // T0-spine §2: an empty path to a place you are NOT at is UNREACHABLE, not "already there" — the old
    // steps:0 reply made the move tool tell a stranded agent "you are already at pub" (5/5 wasted ticks).
    if (!already && a.path.length === 0)
      return r.json({ ok: false, unreachable: true, steps: 0, note: `no path from (${a.x},${a.y}) to ${to}` });
    return r.json({ ok: true, steps: a.path.length });
  }
  if (action === "moveTo") {
    target = [Number(x), Number(y)];
    if (!Number.isFinite(target[0]) || !Number.isFinite(target[1])) return r.status(400).json({ error: "bad target" });
    a.path = astar(a.x, a.y, target[0], target[1]);
    tape.path(agent, tapeLoc(agent), action, { x: target[0], y: target[1] }, a.path); // T0-tape H4
    return r.json({ ok: true, steps: a.path.length });
  }
  return r.status(400).json({ error: "bad target" });
});

// Citizens POST every economic/social event here; the sim records + broadcasts it.
app.post("/event", (req, r) => {
  const { actor, kind, payload, related_id, txHash } = req.body ?? {};
  if (!actor || !kind) return r.status(400).json({ error: "actor + kind required" });
  // task #13: GATE say() on ADJACENCY — an agent can only talk to someone standing right beside it. Without
  // this, talk(toId) emitted a say EVENT to ANY id (even a far/disabled agent) and it rendered on the feed
  // ("barista → courier" while courier was across the map + disabled). Cheb≤1 via byId (every agent, incl.
  // disabled, has a live position) — mirrors the S1-3 give-gate. The W2b walk-up-and-talk records via POST
  // /dialogue (a DIFFERENT handler), so this does NOT touch it.
  if (kind === "say") {
    const speaker = byId.get(String(actor));
    const toId = (payload as { to?: string } | undefined)?.to;
    const target = toId ? byId.get(String(toId)) : undefined;
    const adjacent = !!speaker && !!target && Math.max(Math.abs(target.x - speaker.x), Math.abs(target.y - speaker.y)) <= 1;
    if (!adjacent) return r.json({ ok: false, rejected: "not_adjacent", note: `there's no one named ${toId ?? "(unknown)"} right beside you — you can only talk to someone adjacent to you` });
    // earshot: nearby agents (NOT the addressee — that's heardRecently) OVERHEAR the line
    fanOverheard(String(actor), [String(actor), String(toId)], String((payload as { text?: string } | undefined)?.text ?? "").slice(0, 160), "say", toId ? String(toId) : undefined);
  }
  // Citizens pass the settlement hash as related_id; treat a 0x… related_id as the txHash.
  const fromRelated = typeof related_id === "string" && related_id.startsWith("0x") ? related_id : undefined;
  const tx = txHash ?? (payload && (payload as { txHash?: string }).txHash) ?? fromRelated;
  recordEvent({ actor, kind, payload, related_id, txHash: tx });
  return r.json({ ok: true });
});

// W2b: citizen-side dialogue records its CLOSED conversation here (D6 — the conversation already ran in the
// initiator's process; the sim NEVER calls an LLM). The sim is the single writer of dialogue.jsonl + broadcasts
// it for the feed/inspector. No turn-gate (the conversation is atomic citizen-side). Best-effort append.
app.post("/dialogue", (req, r) => {
  const { op, summary } = req.body ?? {};
  if (op !== "record" || !summary || typeof summary !== "object") {
    return r.status(400).json({ error: "op:'record' + a summary object are required" });
  }
  try {
    appendFileSync(DIALOGUES, JSON.stringify(summary) + "\n");
  } catch {
    /* ignore disk errors — the conversation already happened in the agents' memory */
  }
  dialogueLog.push(summary as Record<string, unknown>);
  if (dialogueLog.length > RING) dialogueLog.shift();
  { const s = summary as { participants?: string[] };
    tape.dialogue(tapeLoc(String(s.participants?.[0] ?? "")), summary as Parameters<typeof tape.dialogue>[1]); } // T0-tape H8: ts+gm+run-stamped (dialogue.jsonl lines are unscopable across clock resets)
  broadcast({ type: "dialogue", op: "record", ...summary });
  // earshot: agents near the conversation (NOT the 2 participants) overhear topic + last line; mentionedBelief diffuses rumors (imp 5->6)
  { const s = summary as { participants?: string[]; topic?: string; transcript?: Array<{ text?: string }>; mentionedBelief?: boolean };
    fanOverheard(String(s.participants?.[0]), (s.participants ?? []).map(String), `${s.topic ?? ""}: "${(s.transcript?.[s.transcript.length - 1]?.text ?? "").slice(0, 120)}"`, "dialogue", undefined, s.mentionedBelief); }
  return r.json({ ok: true });
});

const balCache = new Map<string, { v: number; t: number }>();
async function cachedBal(addr?: string): Promise<number | null> {
  if (!addr) return null;
  const c = balCache.get(addr);
  const now = Date.now();
  if (c && now - c.t < 15000) return c.v;
  try {
    const v = await usdc(addr as `0x${string}`);
    balCache.set(addr, { v, t: now });
    return v;
  } catch {
    return c?.v ?? null;
  }
}

app.get("/perceive", async (req, r) => {
  const a = byId.get(String(req.query.agent));
  if (!a) return r.status(404).json({ error: "no such agent" });
  const cheb = (o: Agent) => Math.max(Math.abs(o.x - a.x), Math.abs(o.y - a.y));
  const R = 6;
  const near = agents.filter((o) => o.id !== a.id && cheb(o) <= R).map((o) => ({ id: o.id, x: o.x, y: o.y, dist: cheb(o) }));
  const nearB = world.buildings
    .filter((b: any) => Math.abs(b.x + b.w / 2 - a.x) <= R + 3)
    .map((b: any) => ({ id: b.id, label: b.label, type: b.type }));
  const hereId = tileBuilding.get(`${a.x},${a.y}`);
  const hereB = hereId ? world.buildings.find((b: any) => b.id === hereId) : null;
  const currentShop = hereB && hereB.type === "shop" ? { id: hereB.id, label: hereB.label, goods: hereB.goods ?? [] } : null;
  const bal = await cachedBal(a.address);
  // W2b: assemble the rich perception (interior NL, seen-subgraph, the observation for mind.observe()).
  // PINNED: the five fields below stay exactly as they were; perception only ADDS keys.
  const inside = interiors.whereInside(a.id); // B1 interior presence: {buildingId, ...} | undefined
  const percept = assemblePerception(tree, seenFor(a.id), {
    self: { id: a.id, x: a.x, y: a.y, usdc: bal, moving: a.path.length > 0 },
    hereBuildingId: hereId ?? null,
    nearBuildings: nearB,
    nearAgents: near,
    adjacentTo: a.adjacentTo,
    insideBuildingId: inside?.buildingId ?? null,
    insideOccupants: inside ? interiors.occupantsOf(inside.buildingId) : [],
  });
  return r.json({
    self: { id: a.id, x: a.x, y: a.y, usdc: bal, moving: a.path.length > 0 },
    agents: near,
    buildings: nearB,
    currentShop,
    adjacentTo: a.adjacentTo,
    // ADDITIVE (W2b-perception) — the world→memory bridge:
    here: percept.here,
    area: percept.area,
    seen: percept.seen,
    seenText: percept.seenText,
    observationText: percept.observationText,
    nearbyObjects: percept.nearbyObjects,
    // T0-weave S1: THE DROPPED WIRE — assemblePerception has built insideHere (occupancy + enriched spots)
    // since B4/B7, but this route never spread it; the whole interior-awareness menu was dead in live runs.
    ...(percept.insideHere ? { insideHere: percept.insideHere } : {}),
    // ADDITIVE (W2b-relations) — recent ties for the partner/seller to ingest into its OWN graph (dedup by id):
    recentDialogues: dialogueLog.filter((d) => Array.isArray(d.participants) && (d.participants as string[]).includes(a.id)).slice(-5),
    recentTrades: tradeLog.filter((t) => t.buyer === a.id || t.seller === a.id).slice(-5),
    // #18: inbound one-way says DIRECTED AT this agent — a DEDICATED ear so they aren't drowned in the
    // listener's own activity. The citizen renders these as a high-salience "reply to this" prompt block.
    heardRecently: sayLog.filter((s) => s.to === a.id).slice(-3),
    // interior earshot (interiorist): conversations you OVERHEARD nearby + presence-deltas you sensed in your space
    overheard: overheardLog.filter((o) => o.listener === a.id).slice(-4),
    nearbyEvents: nearbyEventsLog.filter((e) => e.listener === a.id).slice(-4),
  });
});

// Agent inspector data: identity, live USDC balance, and inventory (each good bought + its txHash).
app.get("/agent/:id", async (req, r) => {
  const a = byId.get(req.params.id);
  if (!a) return r.status(404).json({ error: "no such agent" });
  const balance = await cachedBal(a.address);
  let spent = 0;
  let earned = 0;
  try {
    const lines = existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").split("\n").filter(Boolean) : [];
    for (const l of lines) {
      let e: { kind?: string; actor?: string; payload?: Record<string, unknown> };
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e.kind === "purchase" && e.actor === a.id) spent += Number((e.payload ?? {}).price_usdc ?? 0);
      if (e.kind === "purchase" && (e.payload ?? {}).counterparty === a.id) earned += Number((e.payload ?? {}).price_usdc ?? 0);
    }
  } catch {
    /* ignore */
  }
  // Real custody store (survives restart via the ledger replay above) — each holding carries its txHash.
  return r.json({ id: a.id, address: a.address, color: a.color, x: a.x, y: a.y, usdc: balance, spent, earned, inventory: inventory.get(a.id) });
});

// ---- run-control + token-meter API: the GUI control plane consumes these; citizens poll GET /run-state ----
app.get("/run-state", (_q, r) => r.json(runState.snapshot(roster)));
app.get("/usage", (_q, r) => r.json(usagePayload()));
// #15: recent-event backlog so the GUI activity feed survives a refresh (the renderer hydrates this on WS open,
// then the live WS streams from there). Returns the newest N events + dialogues (capped at the ring size).
app.get("/events", (q, r) => {
  const n = Math.min(Number(q.query.recent) || 200, RING);
  r.json({ events: eventLog.slice(-n), dialogues: dialogueLog.slice(-n) });
});

// A2 (telemetry) — God's-eye scorecard (M1-M8) + per-agent activity stream. Pure reads over the data files;
// the sim never calls an LLM. computeTelemetry/loadTelemetryInput/loadAgentActivity live in sim/telemetry.ts.
app.get("/telemetry", (q, r) => {
  try {
    const since = typeof q.query.since === "string" ? q.query.since : undefined;
    const last = q.query.last ? Number(q.query.last) : undefined;
    const input = loadTelemetryInput({ sinceTs: since, lastN: Number.isFinite(last) ? last : undefined });
    r.json(computeTelemetry(input));
  } catch (e) { r.status(500).json({ error: "telemetry failed", detail: (e as Error).message }); }
});
app.get("/agent/:id/activity", (req, r) => {
  if (!roster.find((e) => e.id === req.params.id)) return r.status(404).json({ error: "no such agent in roster" });
  try {
    const recent = Math.min(Number(req.query.recent) || 50, 500);
    const items = loadAgentActivity(req.params.id, { recent });
    r.json({ id: req.params.id, count: items.length, items });
  } catch (e) { r.status(500).json({ error: "activity failed", detail: (e as Error).message }); }
});

// Citizens report per-tick usage here; the sim aggregates + enforces the fleet budget ceiling.
app.post("/usage", (req, r) => {
  const { id, apiEquivUsd = 0, tokensIn = 0, tokensOut = 0, cacheWrite = 0, cacheRead = 0 } = req.body ?? {};
  if (!id) return r.status(400).json({ error: "id required" });
  const u = perAgentUsage.get(String(id)) ?? zeroUsage();
  u.ticks += 1;
  u.apiEquivUsd += Number(apiEquivUsd) || 0;
  u.tokensIn += Number(tokensIn) || 0;
  u.tokensOut += Number(tokensOut) || 0;
  u.cacheWrite += Number(cacheWrite) || 0;
  u.cacheRead += Number(cacheRead) || 0;
  u.lastTickAt = Date.now();
  perAgentUsage.set(String(id), u);
  const tripped = runState.addUsage(Number(apiEquivUsd) || 0);
  broadcastUsage();
  if (tripped) broadcastRunState();
  return r.json({ ok: true, status: runState.status, reason: runState.reason });
});

// Observability: open THIS agent's live log + inner-life dashboard in an iTerm split-pane on the host
// (the GUI inspector "open in iTerm" button posts here). The sim runs ON the host Mac, so it can drive
// iTerm via scripts/open-observer.ts (which encapsulates the osascript + degrade-don't-die). Fire-and-
// forget: we spawn detached and respond immediately; a failed open NEVER crashes the sim (best-effort).
app.post("/observe", (req, r) => {
  const id = String((req.body ?? {}).id ?? "");
  if (!id) return r.status(400).json({ error: "id required" });
  if (!roster.find((e) => e.id === id)) return r.status(404).json({ error: "no such agent in roster" });
  try {
    const child = execFile("npx", ["tsx", "scripts/open-observer.ts", id], { cwd: ROOT }, (err) => {
      if (err) console.error(`[sim] /observe open-observer failed for ${id}: ${err.message}`);
    });
    child.unref(); // don't keep the sim event loop alive on the viewer process
  } catch (e) {
    console.error(`[sim] /observe spawn error for ${id}: ${(e as Error).message}`); // best-effort — still 200
  }
  return r.json({ ok: true });
});

// Operator control plane: start (REQUIRES an explicit duration), pause/resume/stop, set-duration, set-agent.
app.post("/control", (req, r) => {
  const { action, duration, id, enabled, model } = req.body ?? {};
  switch (action) {
    case "start": {
      const d = duration as Duration | undefined;
      if (!d || !d.kind) return r.status(400).json({ error: "a duration is required to start a run" });
      perAgentUsage.clear(); // fresh meter per run (the budget ceiling is per-run)
      runState.start(d);
      // T0-spine §4: optional startAtHour jumps the clock FORWARD to the next HH:00 (never backwards —
      // memories are stamped) so a watched run covers a full waking day instead of resuming at e.g. 21:54.
      const startAtHour = Number((req.body ?? {}).startAtHour);
      if (Number.isFinite(startAtHour)) runState.jumpToHourOfDay(startAtHour);
      tape.beginRun({ duration: d, roster: roster.map((r2) => ({ ...r2 })), gameMinPerRealSec: Number(process.env.GAME_MIN_PER_REAL_SEC ?? 1.2), ceilingUsd: runState.ceilingUsd() }); // T0-tape H10: mints runId + manifest
      // Spawn the bounded citizen fleet so GUI Start is self-sufficient (the brains are external procs). Same
      // fire-and-forget detached pattern as POST /observe: a failed spawn must NEVER crash the sim — still 200.
      // spawn-fleet.ts reads /run-state for the enabled roster + duration, tees logs, and self-tears-down off
      // run-state. It guards against double-spawn (pgrep) so a stale Start can't stack a second fleet.
      try {
        const child = execFile("npx", ["tsx", "scripts/spawn-fleet.ts"], { cwd: ROOT }, (err) => {
          if (err) console.error(`[sim] /control start spawn-fleet failed: ${err.message}`);
        });
        child.unref(); // don't keep the sim event loop alive on the supervisor process
      } catch (e) {
        console.error(`[sim] /control start spawn-fleet spawn error: ${(e as Error).message}`); // best-effort — still 200
      }
      break;
    }
    case "pause":
      runState.pause("operator");
      break;
    case "resume":
      runState.resume();
      break;
    case "stop":
      runState.stop("operator");
      break;
    case "set-duration":
      if (duration) runState.setDuration(duration as Duration);
      break;
    case "set-agent": {
      const e = roster.find((x) => x.id === id);
      if (!e) return r.status(404).json({ error: "no such agent in roster" });
      if (typeof enabled === "boolean") e.enabled = enabled;
      if (typeof model === "string" && model) e.model = model;
      saveRosterState();
      break;
    }
    default:
      return r.status(400).json({ error: `unknown control action: ${action}` });
  }
  broadcastRunState();
  broadcastUsage();
  return r.json({ ok: true, runState: runState.snapshot(roster) });
});

const PORT = 4042;
const server = app.listen(PORT, "127.0.0.1", () => // loopback only: wallets + control plane, never the LAN
  console.log(`🏙  Tillwick at http://localhost:${PORT} — ${agents.length} citizens · movement + perception`),
);

const wss = new WebSocketServer({ server });
broadcast = (o) => {
  const s = JSON.stringify(o);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
// viewer liveness drives pause-on-no-viewer: when the last GUI tab closes, the fleet pauses (zero burn).
function countViewers() {
  let n = 0;
  for (const c of wss.clients) if (c.readyState === 1) n++;
  return n;
}
function updateViewers() {
  if (runState.onViewerChange(countViewers())) broadcastRunState();
}
let tick = 0;
function tickAgents() {
  return agents.map((a) => ({ id: a.id, x: a.x, y: a.y, color: a.color, moving: a.path.length > 0, adjacentTo: a.adjacentTo }));
}
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "world", world, agents: tickAgents() }));
  ws.send(JSON.stringify({ type: "run-state", ...runState.snapshot(roster) }));
  ws.send(JSON.stringify({ type: "usage", ...usagePayload() }));
  updateViewers();
  ws.on("close", () => updateViewers());
});

setInterval(() => {
  // pause-on-no-viewer (defensive: also covers a run started with no browser attached)
  if (runState.isRunnable() && runState.viewers === 0) {
    runState.pause("no-viewer");
    broadcastRunState();
  }
  const statusChanged = runState.tickAdvance(500); // advance the game clock + enforce the duration limit
  tick++;
  if (runState.isRunnable()) {
    // step paths only while running — pause/stop FREEZES the world (and any token spend)
    for (const a of agents) {
      const wasInside = interiors.whereInside(a.id)?.buildingId ?? null;
      const step = a.path.shift();
      if (step) { a.x = step[0]; a.y = step[1]; tape.pos(a.id, tapeLoc(a.id)!, a.path.length > 0); } // T0-tape H9: the walk, tick-true
      // B1 arrival semantics: enter the interior when the path empties on a modelled building's tile; leave the old one when stepping toward another.
      const hereBuilding = tileBuilding.get(`${a.x},${a.y}`) ?? null;
      const hereHasInterior = hereBuilding ? !!interiorOf(hereBuilding) : false;
      if (hereHasInterior && a.path.length === 0 && wasInside !== hereBuilding) {
        // T0-spine §3: schedule-aware ARRIVAL — land directly on the scheduled station (oven/desk/stage)
        // instead of parking at spawnInside until a whole extra acted tick is spent. Doorway = pass-through.
        const blk = stepAt(a.id, runState.snapshot(roster).gameMinutes as number);
        const station = blk && blk.buildingId === hereBuilding ? blk.station : undefined;
        interiors.enter(a.id, hereBuilding!, station); // enter() falls back to spawnInside on unknown/ghost station
        fanNearbyEvent(a.id, "entered", hereBuilding!);
        tape.enter(a.id, tapeLoc(a.id), hereBuilding!); // T0-tape H9
        broadcast({ type: "interior", building: hereBuilding!, occupants: interiors.occupantsOf(hereBuilding!) });
      } else if (wasInside && wasInside !== hereBuilding) {
        fanNearbyEvent(a.id, "left", wasInside); // BEFORE leave — the leaver still shares the room, so its old peers hear it
        interiors.leave(a.id);
        tape.leave(a.id, tapeLoc(a.id), wasInside); // T0-tape H9 (after leave — `at` shows the agent outside)
        broadcast({ type: "interior", building: wasInside, occupants: interiors.occupantsOf(wasInside) });
      }
    }
    // T0-weave S4: street-approach presence — the street was presence-delta blind (interior transitions only).
    // Fan "approached" to the converging PAIR directly (it concerns them), not the whole earshot audience.
    const locsNow = locsForEarshot();
    for (const { a: la, b: lb } of approachDeltas(prevLocs, locsNow)) {
      nearbyEventsLog.push({ listener: la, actor: lb, verb: "approached", place: "street", atGameMin: nowGM() });
      nearbyEventsLog.push({ listener: lb, actor: la, verb: "approached", place: "street", atGameMin: nowGM() });
    }
    if (nearbyEventsLog.length > RING) nearbyEventsLog.splice(0, nearbyEventsLog.length - RING);
    prevLocs = locsNow;
  }
  for (const a of agents) a.adjacentTo = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const A = agents[i], B = agents[j];
      if (Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y)) <= 1) {
        A.adjacentTo.push(B.id);
        B.adjacentTo.push(A.id);
      }
    }
  }
  broadcast({ type: "tick", tick, agents: tickAgents() });
  if (statusChanged || tick % 4 === 0) broadcastRunState(); // periodic clock/status push to the GUI
  { const s = runState.snapshot(roster); tape.syncStatus(s.status as string, (s as { reason?: string | null }).reason ?? null); } // T0-tape H9: catches ALL stop paths (duration/budget/no-viewer/operator)
}, 500);
