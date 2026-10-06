import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { payForItem } from "../buy.js";
import { GOOD_TO_SHOP, SHOP_OWNER, shopUrl } from "../shops/registry.js";
import { canBuy } from "./guard.js";
import { recentDigest } from "../economy/ledger.js";
import { personaFor, type Persona } from "./personas.js";
import { buildingMapFor, buildingLabel, onShiftNow } from "./building-map.js";
import { stepAt, agendaLines, scheduleFor, type ScheduleBlock } from "./schedules.js";
import { affordancesFor, renderAffordanceMenu, affordanceBeatPayload, type AffordanceView } from "./affordances.js";
import type { HeardSay } from "./ignition.js";
import { buildInteriorMenu } from "../cognition/interior-awareness.js";
import type { OverheardRecord, NearbyEventRecord } from "../sim/earshot.js";
import type { Mind } from "../cognition/mind.js";

// The citizen's in-process MCP "world" server (Seam B): its senses (look/perceive) and hands
// (move/enterShop/evaluate_purchase/buy/talk). Each tool is a thin wrapper over the sim's existing
// HTTP API (GET /perceive, POST /act) + the x402 buy primitive (buy.ts) + the shop registry.
//
// SINGLE-WRITER discipline: tools do NOT write events.jsonl. They POST /event to the sim, which is the
// one writer + WS broadcaster (sim/sim-server.ts). The ledger READ helpers (recentDigest) read the file
// directly — safe from any process.

const HERE = dirname(fileURLToPath(import.meta.url)); // citizens/
const ROOT = dirname(HERE); // repo root
const SIM = process.env.SIM_URL ?? "http://localhost:4042";

const txt = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });

// good id -> numeric USDC price, parsed once from world.json (e.g. "$0.01" -> 0.01).
const world = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8")) as {
  buildings: Array<{ id: string; goods?: Array<{ id: string; price: string }> }>;
};
const PRICE: Record<string, number> = {};
for (const b of world.buildings) for (const g of b.goods ?? []) PRICE[g.id] = Number(g.price.replace(/[^0-9.]/g, ""));
export const priceOf = (good: string): number => PRICE[good] ?? 0;

// S1-2: ROLE-SPECIFIC producer verbs. Each role gets ONE distinctly-named producer tool (agent-tool design rules —
// "one verb per tool" + "mirror your domain": a baker calls `bake`, a smith `forge`, NOT a generic `produce`).
// The verb mints one unit of the role's primary good into the producer's OWN inventory (the supply side of the
// demand loop). The good is the producer's shop's FIRST good in world.json (bakery→bread, cafe→coffee, …).
const SHOP_PRIMARY_GOOD: Record<string, string> = {};
for (const b of world.buildings) if (b.goods && b.goods[0]) SHOP_PRIMARY_GOOD[b.id] = b.goods[0].id;
// role → { verb, good }. The verb name matches persona.tools[0] (the role token S1-1 declared); the good is
// derived from that role's shop so this stays a single source of truth with the registry + world.json.
// A3 status: `emoji` + a SHORT `text` (≤24 chars) are SEPARATE fields per scenewright's renderer contract —
// the renderer draws `emoji` over the actor + `text` in the bubble (and maps verb→emoji itself as a fallback).
const PRODUCER: Record<string, { verb: string; flavor: string; emoji: string; text: string }> = {
  baker: { verb: "bake", flavor: "pull a fresh loaf from the oven", emoji: "🥖", text: "baking…" },
  barista: { verb: "brew", flavor: "pull a fresh shot", emoji: "☕", text: "brewing…" },
  grocer: { verb: "restock", flavor: "restock the shelf", emoji: "🛒", text: "restocking…" },
  courier: { verb: "deliver", flavor: "bring in a delivery", emoji: "📦", text: "delivering…" },
  smith: { verb: "forge", flavor: "forge a new piece", emoji: "🔨", text: "forging…" },
};
// The good a given citizen's producer verb makes (their shop's primary good), or undefined if they're not a producer.
function producedGoodFor(id: string): string | undefined {
  const shopId = personaFor(id).shopId;
  return shopId ? SHOP_PRIMARY_GOOD[shopId] : undefined;
}

// A3: passive "I'm doing my thing" status bubbles for the non-producer roles when they're at their workplace
// (producers emit theirs on the produce verb). Keyed by citizen id. Same {emoji,text} split as PRODUCER above.
const PASSIVE_STATUS: Record<string, { emoji: string; text: string }> = {
  musician: { emoji: "🎸", text: "busking…" },
  student: { emoji: "📖", text: "studying…" },
  regular: { emoji: "🍺", text: "holding court…" },
};

// A1: every real building id (parsed once from world.json) so we can detect when a plan line NAMES a building.
const BUILDING_IDS: string[] = (world.buildings ?? []).map((b) => b.id);

// A1/B6: turn a plan-step's text into the building id it's about. Order (B6 reordered so work-intent + on-shift
// beat the home/coffee fallbacks — the showcase bug was a musician's "perform first set at The Rose & Crown" line
// routing HOME because `dinner` was tested before work-verbs and the pub's LABEL wasn't matched):
//   (1) an explicit building id OR LABEL named in the step (longest match — "home-baker" beats "bakery";
//       "The Rose & Crown" → pub);
//   (2) work-verbs → workplace (busk/play/study/forge/deliver/work… — checked BEFORE home/coffee);
//   (3) if ON-SHIFT, default to the workplace (an evening-worker musician at 17:00 belongs at the pub, not home);
//   (4) home keywords → home;  (5) relax/hangout keywords → hangout;
//   (6) time-of-day default — workplace by day, home at night.
// Always returns a real building id so a downstream move() can't target a ghost.
export function inferStepTarget(stepText: string, places: { workId: string; homeId: string; hangoutId: string }, period: string, onShift = false): string {
  const t = (stepText || "").toLowerCase();
  // (1) explicit building id OR label named in the step — prefer the LONGEST match.
  const byId = BUILDING_IDS.filter((b) => t.includes(b.toLowerCase()));
  const byLabel = BUILDING_IDS.filter((b) => { const l = buildingLabel(b).toLowerCase(); return l !== b.toLowerCase() && t.includes(l); });
  const named = [...byId, ...byLabel].sort((a, b) => b.length - a.length)[0];
  if (named) return named;
  // (2) WORK intent → workplace (checked before home/coffee so "talk through the set" doesn't go home).
  if (/\b(work|shop|shift|open|sell|serve|study|class|college|lecture|seminar|library|busk|perform|gig|set|play|stage|soundcheck|forge|smith|bake|brew|roast|restock|deliver|delivery|round|counter|desk)\b/.test(t)) return places.workId;
  // (3) ON-SHIFT default → workplace (the fix for evening/early workers whose plan line is vague mid-shift).
  if (onShift) return places.workId;
  // (4) home, (5) hangout
  if (/\b(home|sleep|bed|wake|rest|nap|breakfast|dinner|turn in)\b/.test(t)) return places.homeId;
  if (/\b(relax|drink|pub|tavern|cafe|coffee|chat|gossip|hang|socialise|socialize|unwind|evening out)\b/.test(t)) return places.hangoutId;
  // (6) time-of-day default
  return period === "night" || period === "evening" ? places.homeId : places.workId;
}

// A3: throttle the passive role-action status (musician/student/regular at their workplace) to at most once per
// game-hour, so a stationary agent's "busking…" doesn't flood events.jsonl every 8-second tick. Keyed by id →
// the absolute game-hour we last emitted for. (Producers emit on their verb instead, which is already occasional.)
const lastPassiveStatusHour: Record<string, number> = {};

// Per-citizen turn counter (idempotency key for the GUARD). Each tool call this tick shares the turn.
const turnByCitizen: Record<string, number> = {};
export const setTurn = (id: string, t: number) => (turnByCitizen[id] = t);
const currentTurn = (id: string) => turnByCitizen[id] ?? 0;

// T0 NEVER-STUCK (operator D28 invariant 1): per-citizen per-tick outcome tally — how many world-tool calls
// SUCCEEDED vs came back BLOCKED (unreachable move, ghost go_inside, rejected talk). The citizen loop reads
// this after each ACT turn (takeTurnOutcome resets) to detect "N consecutive ticks where nothing landed" and
// force a change of approach. Kept here because the tools are the only place that sees every outcome.
const turnOutcome: Record<string, { ok: number; blocked: number }> = {};
const tallyOutcome = (id: string, kind: "ok" | "blocked") => {
  const t = (turnOutcome[id] ??= { ok: 0, blocked: 0 });
  t[kind]++;
};
export function takeTurnOutcome(id: string): { ok: number; blocked: number } {
  const t = turnOutcome[id] ?? { ok: 0, blocked: 0 };
  turnOutcome[id] = { ok: 0, blocked: 0 };
  return t;
}

// Resilient to a momentary sim blip: a fetch/connection error or non-JSON body returns {} rather than
// throwing, so a single flaky call never crashes a tool or the whole tick. (In normal operation the sim
// is up — the lead starts it before citizens — but ticks should degrade, not die.)
async function getJson(url: string): Promise<any> {
  try {
    const res = await fetch(url);
    return await res.json().catch(() => ({}));
  } catch {
    return {};
  }
}
async function post(path: string, body: unknown): Promise<any> {
  try {
    const res = await fetch(`${SIM}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json().catch(() => ({}));
  } catch {
    return {};
  }
}
// Record an event via the sim (the single writer): POST /event {kind, actor, payload, related_id?}.
async function emit(kind: string, actor: string, payload: Record<string, unknown>, related_id = ""): Promise<void> {
  try {
    await post("/event", { kind, actor, payload, related_id });
  } catch {
    /* sim may be momentarily down; the buy itself still settled on-chain */
  }
}

export function makeWorldServer(id: string) {
  const look = tool(
    "look",
    "Perceive your surroundings. Returns nearby citizens and buildings, your position and USDC balance, who you are adjacent to, and — if you are standing inside a shop — that shop's goods and prices.",
    {},
    async () => txt(await getJson(`${SIM}/perceive?agent=${id}`)),
  );

  const move = tool(
    "move",
    "Start walking toward a building by id (e.g. 'bakery','cafe','grocer','depot','smithy', or a home). Movement happens AUTOMATICALLY over the next few game-ticks — you do NOT arrive within this turn. Call this AT MOST ONCE per turn: after you call it you are already en route, so do something else (or end your turn) rather than calling move again.",
    { to: z.string().describe("building id to walk to") },
    async ({ to }) => {
      await emit("move", id, { to });
      const r = await post("/act", { agent: id, action: "goTo", to });
      // RICH RETURN (anti-loop): movement resolves over GAME-ticks, not within this ACT turn — so the model
      // must not re-issue move() waiting to "arrive" (that burns maxTurns; the lead saw baker loop on this).
      // Tell it plainly: you're en route, N tiles to go, ~N ticks, do NOT call move again this turn.
      const steps = typeof r?.steps === "number" ? r.steps : undefined;
      if (r?.ok && steps != null) {
        // T0 TRUTHFULNESS (audit A1, 2026-07-18): the sim answers {ok, steps:0} BOTH for "you're standing on
        // the target" AND for "A* found no path" (an unreachable target tile — the pub/college/dorm geometry
        // bug). Saying "you are already at pub" to an agent on the far side of town misled musician/student
        // into 9-turn guess-loops EVERY tick (5/5 error_max_turns). On steps:0, VERIFY against perception:
        // only claim arrival when the agent is actually standing at `to`; otherwise say plainly that no path
        // exists right now and forbid a retry this turn. (The sim-side half — an explicit unreachable flag +
        // door-adjacent targets — lives in sim/sim-server.ts goTo; this stays as defense.)
        if (steps === 0) {
          const p = await getJson(`${SIM}/perceive?agent=${id}`);
          const hereNow: string | null = (p as { here?: { buildingId?: string } }).here?.buildingId ?? p?.currentShop?.id ?? null;
          if (hereNow !== to) {
            tallyOutcome(id, "blocked");
            // D32: a blocked action is a tape beat — the stuck-detector + replayer need the reason.
            await emit("blocked", id, { tool: "move", to, reason: "unreachable", turn: currentTurn(id) });
            return txt({
              ok: false,
              unreachable: true,
              to,
              note: `you can't find a way to ${to} from where you stand — no path is open right now. Do NOT call move({to:"${to}"}) again this turn. Do something worthwhile where you are (or head somewhere you know you can reach), and try ${to} again another time.`,
            });
          }
        }
        tallyOutcome(id, "ok");
        return txt({
          ok: true,
          enRoute: true,
          to,
          tilesToGo: steps,
          etaTicks: steps, // ~one tile per game-tick
          note: steps === 0
            ? `you are already at ${to}.`
            : `you are now walking to ${to} — ${steps} tiles to go (~${steps} ticks). You'll advance AUTOMATICALLY each tick; do NOT call move() again this turn. End your turn or take a different action.`,
        });
      }
      return txt(r); // bad target / error — surface as-is so the model can correct
    },
  );

  const enterShop = tool(
    "enterShop",
    "Look at the shop you are currently standing in: returns its goods and prices (free window-shopping). Use after you've moved onto a shop's tile.",
    { id: z.string().describe("shop id you are at, e.g. 'bakery'") },
    async () => {
      const p = await getJson(`${SIM}/perceive?agent=${id}`);
      return txt(p.currentShop ?? { note: "you are not inside a shop — move onto its door tile first" });
    },
  );

  const inventory = tool(
    "inventory",
    "Check what goods you currently own (with counts), so you don't buy something you already have plenty of.",
    {},
    async () => {
      const inv = await getJson(`${SIM}/inventory/${id}`);
      // { id, counts: Record<item,number>, holdings: Holding[] } — surface counts (cheap + decision-relevant).
      return txt({ owns: inv.counts ?? {}, total: Object.values(inv.counts ?? {}).reduce((s: number, n) => s + Number(n), 0) });
    },
  );

  const consume = tool(
    "consume",
    "Use up one unit of a good you own (eat the bread, drink the coffee, use the nail). This is how your needs come back — once consumed you'll want to buy more. Only works on goods you actually hold.",
    { item: z.string().describe("good id you hold and want to use, e.g. 'bread'") },
    async ({ item }) => {
      // Custody mutation goes through the sim (single writer); the sim also emits the `consume` ledger event.
      const r = await post("/act", { agent: id, action: "consume", item });
      if (r?.consumed == null) return txt({ ok: false, item, note: `you have no ${item} to consume` });
      return txt({ ok: true, item, remaining: r.remaining ?? 0 });
    },
  );

  const evaluatePurchase = tool(
    "evaluate_purchase",
    "Decide whether an item is worth buying, given its price, your budget, and your role's needs. You MUST call this before buy. Returns mayBuy — your spending cap may veto even if you think it's worth it.",
    {
      item: z.string().describe("good id, e.g. 'bread'"),
      price_usdc: z.number().describe("the item's price in USDC, e.g. 0.01"),
      reason: z.string().describe("one short sentence: why you do or don't want it"),
      worth: z.boolean().describe("your judgment: is it worth buying right now?"),
    },
    async (a) => {
      const g = await canBuy(id, a.item, a.price_usdc, currentTurn(id));
      const mayBuy = a.worth && g.ok;
      await emit("decision", id, {
        item: a.item,
        price_usdc: a.price_usdc,
        reason: a.reason,
        worth: a.worth,
        mayBuy,
        balance: g.balance,
        guard: g.why ?? "ok",
        turn: currentTurn(id),
      });
      return txt({ ...a, balance: g.balance, mayBuy, guard: g.why ?? "ok" });
    },
  );

  const buy = tool(
    "buy",
    "Pay for an item via x402 (testnet USDC) from the shop that sells it. Only call after evaluate_purchase returned mayBuy=true.",
    { item: z.string().describe("good id to buy, e.g. 'bread'") },
    async ({ item }) => {
      const shopId = GOOD_TO_SHOP[item];
      if (!shopId) {
        // D32: a failed buy is a LOUD tape beat, never a silent ok:false (socialweaver's buy-failed spec).
        await emit("buy-failed", id, { item, reason: "no-shop-sells-item", turn: currentTurn(id) }).catch(() => {});
        return txt({ ok: false, error: `no shop sells "${item}"` });
      }
      const owner = SHOP_OWNER[shopId];
      const price = priceOf(item);
      try {
        const r = await payForItem(id, shopUrl(shopId), item); // buy.ts (own wallet); 402→sign→retry→200
        const ok = r.status < 300;
        if (!ok) await emit("buy-failed", id, { item, shop: shopId, reason: `http-${r.status}`, turn: currentTurn(id) }).catch(() => {});
        await emit(
          "purchase",
          id,
          { item, price_usdc: price, shop: shopId, counterparty: owner, turn: currentTurn(id), idempotency_key: `${id}|${item}|${currentTurn(id)}` },
          r.txHash,
        );
        // Tell the sim the buy happened (it may flash the buyer / update inventory).
        await post("/act", { agent: id, action: "buyResult", item, txHash: r.txHash });
        return txt({ ok, item, shop: shopId, txHash: r.txHash, status: r.status });
      } catch (e) {
        await emit("buy-failed", id, { item, shop: shopId, reason: (e as Error).message.slice(0, 120), turn: currentTurn(id) }).catch(() => {});
        return txt({ ok: false, item, error: (e as Error).message });
      }
    },
  );

  const talk = tool(
    "talk",
    "Say one short line to a citizen ADJACENT to you (greet them, react to a purchase, reply to something they said). You can ONLY talk to someone standing right beside you — you can't call out across the map or to someone who isn't here. Keep it to one sentence.",
    {
      toId: z.string().describe("the id of the adjacent citizen you're speaking to (must be standing next to you)"),
      msg: z.string().describe("one short sentence to say"),
    },
    async ({ toId, msg }) => {
      // task #13 (layer C, fast self-correction): a `say` must be grounded in proximity — you only talk to who
      // you're co-located with. Pre-check adjacency from live perception BEFORE emitting, so a cross-map / not-
      // present talk gets a rich rejection and never reaches the feed. (The authoritative gate is server-side in
      // the /event handler — this is just the cheap fast path so the citizen self-corrects without a wasted emit.)
      const p = await getJson(`${SIM}/perceive?agent=${id}`);
      const adjacent: string[] = Array.isArray(p.adjacentTo) ? p.adjacentTo : [];
      if (!adjacent.includes(toId)) {
        tallyOutcome(id, "blocked");
        return txt({
          ok: false,
          rejected: "not_adjacent",
          toId,
          adjacentTo: adjacent,
          note: adjacent.length
            ? `you can't talk to ${toId} — they're not beside you. You can only talk to whoever is adjacent right now: ${adjacent.join(", ")}.`
            : `you can't talk to ${toId} — no one is standing next to you. Move next to someone first, then talk.`,
        });
      }
      tallyOutcome(id, "ok");
      await emit("say", id, { to: toId, text: msg, turn: currentTurn(id) });
      // Mirror to the sim's say input (for the speech bubble / feed). Contract: {to: toId, text}.
      return txt(await post("/act", { agent: id, action: "say", toId, text: msg }));
    },
  );

  // ─── S1-3: carry-and-give (the party verbs) ───────────────────────────────────────────────────────
  // give() hands a held good to an ADJACENT citizen as a GIFT — real custody moves, but NO money/x402
  // (distinct from buy). The sim is the single writer: it moves custody (inventory.gift) + emits the `give`
  // event. Rich return value so the model learns the outcome (gave/refused + why) without re-perceiving.
  const give = tool(
    "give",
    "Hand one unit of a good you HOLD to a citizen adjacent to you, as a GIFT (no money changes hands — this is NOT a sale). Use this to bring someone a present (e.g. a cake or balloons at a party). You must already own the item and be standing next to the recipient.",
    {
      item: z.string().describe("good id you hold and want to give away, e.g. 'cake'"),
      toId: z.string().describe("the id of the adjacent citizen you're giving it to"),
    },
    async ({ item, toId }) => {
      // The sim verifies adjacency + custody and is the single writer of the `give` event + custody move.
      const r = await post("/act", { agent: id, action: "give", item, toId, turn: currentTurn(id) });
      if (r?.ok && r?.given) {
        // sim's /act give already records the event (single-writer) — no duplicate emit here.
        return txt({ ok: true, gave: item, to: toId, note: `you gave your ${item} to ${toId} as a gift (no money moved)` });
      }
      return txt({ ok: false, item, to: toId, note: r?.note ?? `could not give ${item} to ${toId} (do you hold it? are you adjacent?)` });
    },
  );

  // pick_up() / drop(): move a unit between your hands and the ground at the place you're standing in.
  const pickUp = tool(
    "pick_up",
    "Pick up one unit of a good lying on the ground where you are standing, into your own inventory. Use after you see an item left at a place.",
    { item: z.string().describe("good id lying here you want to pick up, e.g. 'balloons'") },
    async ({ item }) => {
      const r = await post("/act", { agent: id, action: "pick_up", item, turn: currentTurn(id) });
      if (r?.ok && r?.picked) {
        // sim's /act pick_up already records the event (single-writer) — no duplicate emit here.
        return txt({ ok: true, pickedUp: item, note: `you picked up a ${item}` });
      }
      return txt({ ok: false, item, note: r?.note ?? `no ${item} on the ground here to pick up` });
    },
  );

  const dropTool = tool(
    "drop",
    "Set down one unit of a good you hold onto the ground where you are standing (e.g. leave a balloon at the park). It stays there for someone to pick up.",
    { item: z.string().describe("good id you hold and want to set down, e.g. 'cake'") },
    async ({ item }) => {
      const r = await post("/act", { agent: id, action: "drop", item, turn: currentTurn(id) });
      if (r?.ok && r?.dropped) {
        // sim's /act drop already records the event (single-writer) — no duplicate emit here.
        return txt({ ok: true, dropped: item, note: `you set down your ${item} here` });
      }
      return txt({ ok: false, item, note: r?.note ?? `you have no ${item} to drop` });
    },
  );

  // use() generalizes consume — eat/drink/use up one held unit so the need recurs. Mirrors `consume`.
  const use = tool(
    "use",
    "Use up one unit of a good you own (eat the cake, drink the coffee, pop a balloon). Once used you'll want more. Only works on goods you actually hold. (Same as consume — a friendlier name.)",
    { item: z.string().describe("good id you hold and want to use, e.g. 'cake'") },
    async ({ item }) => {
      const r = await post("/act", { agent: id, action: "use", item });
      if (r?.used == null && r?.consumed == null) return txt({ ok: false, item, note: `you have no ${item} to use` });
      return txt({ ok: true, item, remaining: r.remaining ?? 0, note: `you used a ${item}` });
    },
  );

  // B4: move to a SUB-LOCATION inside the building you're currently in — sit at a table, step up to the counter,
  // go to your desk/the stage/a bed. The sim (presence authority) moves you within the interior's local grid; a
  // `table` picks the nearest FREE seat so two agents at one table take different seats (→ table-talk via the A3
  // co-location trigger). You learn the available spots from `insideHere.sublocations` in your perception. This is
  // how "agents DO stuff inside" reads on the map. Rich return so the model knows where it ended up.
  const goInside = tool(
    "go_inside",
    "Move to a specific spot INSIDE the building you're currently in — e.g. sit at a table, step up to the counter, go to your desk or the stage. Pass the sub-location id (you can see the spots in your perception's interior list). Use this once you're inside your workplace/home/hangout to actually take your place there (work the counter, sit down to study, take the stage).",
    { spot: z.string().describe("the sub-location id to go to inside this building, e.g. 'cafe-counter' or 'pub-table-1'") },
    async ({ spot }) => {
      const r = await post("/act", { agent: id, action: "goInside", sublocationId: spot });
      if (r?.ok && r?.inside) {
        tallyOutcome(id, "ok");
        return txt({ ok: true, atSpot: r.sublocationId ?? spot, label: r.label ?? spot, note: `you take your place at ${r.label ?? spot}.` });
      }
      tallyOutcome(id, "blocked");
      await emit("blocked", id, { tool: "go_inside", spot, reason: "not-inside-or-no-such-spot", turn: currentTurn(id) }); // D32 beat
      return txt({ ok: false, spot, note: r?.note ?? `couldn't go to "${spot}" — are you inside the building, and is that a real spot here? (check your perception's interior list)` });
    },
  );

  // S1-2: this citizen's ROLE-SPECIFIC producer verb (if they're a producer). One distinctly-named tool
  // (bake/brew/forge/restock/deliver) that mints one unit of their good into their OWN inventory via the sim
  // (single writer — the tool POSTs `/act produce`; the sim does the mint + emits the `produce` event). NOT a
  // purchase: no money, no txHash (see economy/inventory.ts produce). Rich return.
  const role = personaFor(id).role;
  const spec = PRODUCER[role];
  const good = producedGoodFor(id);
  const producerTool =
    spec && good
      ? tool(
          spec.verb,
          `Make a unit of your own stock — ${spec.flavor}. This is your craft: it adds one ${good} to your inventory to sell. No money is spent (you made it). Use it when your shelf is running low.`,
          {},
          async () => {
            const r = await post("/act", { agent: id, action: "produce", good, turn: currentTurn(id) });
            if (r?.ok && r?.produced) {
              // NOTE: no citizen-side emit("produce") — the sim's /act produce handler already records the
              // event (single-writer); the double emit made 15 real produces read as 30 on the tape
              // (flightrecorder, 2026-07-18). Same fix applied to give/pick_up/drop below.
              tallyOutcome(id, "ok");
              // A3: a VISIBLE role-action status the renderer draws as a bubble (emoji over the actor + "baking…").
              // The generic /event recorder (sim-server.ts:350) accepts kind:"status" as-is (only `say` is
              // adjacency-gated), so this needs no sim change. `at` is this producer's workplace (anchor hint).
              await emit("status", id, { text: spec.text, emoji: spec.emoji, verb: spec.verb, at: buildingMapFor(id).workId, turn: currentTurn(id) });
              return txt({ ok: true, made: good, onHand: r.have ?? 0, note: `you ${spec.verb === "restock" ? "restocked" : spec.verb + (spec.verb.endsWith("e") ? "d" : "ed")} — 1 ${good} added (now ${r.have ?? "?"} on hand to sell)` });
            }
            return txt({ ok: false, good, note: r?.note ?? `could not ${spec.verb} right now` });
          },
        )
      : null;

  // The SHARED CORE every citizen always gets (sense/move/buy/talk + the S1-3 carry-and-give verbs), PLUS this
  // role's one producer verb. Core is guaranteed regardless of persona.tools[] so a persona typo can't strip
  // `buy`/`look`. `roleToolNames(id)` mirrors this exact set for citizen.ts ALLOWED (single source of truth).
  const core = [look, move, enterShop, inventory, consume, evaluatePurchase, buy, talk, give, pickUp, dropTool, use, goInside];
  const tools = producerTool ? [...core, producerTool] : core;

  return createSdkMcpServer({
    name: "world",
    version: "1.0.0",
    tools,
    // S0-1 (kill the ToolSearch tax): force the world tools to load EAGERLY — present in the turn-1 prompt and
    // directly callable, never deferred behind a `ToolSearch` round-trip. Applies `_meta['anthropic/alwaysLoad']`
    // (== `defer_loading:false` on the API) to every tool here. The other half (citizen.ts `tools:[]`) strips the
    // inherited built-ins (Gmail/Calendar/Cron/Task/ToolSearch) so ONLY these role tools are surfaced. Together:
    // 0 ToolSearch calls, ~2× fewer ACT round-trips. makeWorldServer is local + synchronous so the ≤5s connect
    // blocking the alwaysLoad doc warns about is effectively instant here.
    alwaysLoad: true,
  });
}

// S1-2: the surfaced tool NAMES for a citizen (the shared core + this role's producer verb), as `mcp__world__*`.
// SINGLE SOURCE OF TRUTH for both the factory above AND citizen.ts ALLOWED — so the allow-list can't drift from
// what's actually surfaced (the kind of drift that silently broke consume once). A courier's set has `deliver`,
// never `bake`; a citizen with no producer role just gets the core.
const CORE_TOOL_NAMES = ["look", "move", "enterShop", "inventory", "consume", "evaluate_purchase", "buy", "talk", "give", "pick_up", "drop", "use", "go_inside"];
export function roleToolNames(id: string): string[] {
  const role = personaFor(id).role;
  const spec = PRODUCER[role];
  const names = producedGoodFor(id) && spec ? [...CORE_TOOL_NAMES, spec.verb] : [...CORE_TOOL_NAMES];
  return names.map((t) => `mcp__world__${t}`);
}

// A1: derive a human clock from absolute game-minutes (same math as run-state.ts clockOf — kept local so we
// don't widen the run-state contract; gameMinutes is the single source of truth the citizen already polls).
function clockFromGameMin(gameMinutes: number): { day: number; hh: number; mm: number; period: string; label: string } {
  const m = Math.max(0, Math.floor(gameMinutes));
  const hh = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  const day = Math.floor(m / 1440) + 1;
  const period = hh < 6 ? "night" : hh < 12 ? "morning" : hh < 18 ? "afternoon" : hh < 22 ? "evening" : "night";
  const label = `Day ${day}, ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} (${period})`;
  return { day, hh, mm, period, label };
}

// The per-tick prompt: live senses + a short memory digest (which surfaces anything a neighbor just
// SAID to this citizen) + role + a decisive single-action instruction.
// A1: `gameMinutes` (the sim game clock the citizen already polls from /run-state) is now PASSED IN so the
// prompt can tell the agent the time of day AND so the daily plan can drive a "go to your role-location"
// action. Optional (defaults 0) so a stale caller still compiles; the citizen runtime always supplies it.
export type PlanMeta = { step: string; until: string; why?: string; building: string; station?: string | null };
// Structural slice of socialweaver's SocialStep that the affordance menu needs (volition + answered-say
// lookups). Structural on purpose — world-tools stays import-free of social-step; citizen.ts passes the
// real instance.
export type SocialView = {
  volitionTarget(): { targetId: string; topic: string; line: string } | null;
  pairs: { isAnswered(sayId: string): boolean };
};
export async function renderTick(
  id: string,
  persona: Persona,
  tick: number,
  mind?: Mind,
  gameMinutes = 0,
  // D28 never-stuck: when the citizen loop detected N no-progress ticks, it passes a note here and the
  // prompt's TOP branch becomes "do something different" (see the lines array).
  stuckNote?: string,
  social?: SocialView,
): Promise<{ prompt: string; perceived: Record<string, unknown>; planStep: string; planMeta: PlanMeta | null; menuCount: number }> {
  setTurn(id, tick);
  const p = await getJson(`${SIM}/perceive?agent=${id}&tick=${tick}`); // &tick joins the perceive digest into the tape's causal chain (H13)
  const self = p.self ?? {};
  const clock = clockFromGameMin(gameMinutes);
  const places = buildingMapFor(id); // {workId, homeId, hangoutId} — the agent's anchors across the WHOLE map
  // where am I right now? the building on my tile (if any), from perception (HereView.buildingId).
  const hereId: string | null = (p as { here?: { buildingId?: string } }).here?.buildingId ?? p.currentShop?.id ?? null;
  // What this citizen already owns (counts). Tolerate the /inventory route being momentarily unavailable.
  const inv = await getJson(`${SIM}/inventory/${id}`).catch(() => ({}));
  const owns: Record<string, number> = inv?.counts ?? {};
  const ownsStr = Object.keys(owns).length
    ? Object.entries(owns).map(([k, v]) => `${k}×${v}`).join(", ")
    : "nothing";
  const said = recentDigest(id, 8); // immediate channel: anything a neighbor just SAID to this citizen
  const situation = JSON.stringify({ at: { x: self.x, y: self.y }, near: p.agents ?? [], buildings: p.buildings ?? [], adjacentTo: p.adjacentTo ?? [], shop: p.currentShop?.id ?? null });
  // B7 EARSHOT (declared early — used both in the cognition memory-fold below AND the prompt block later): what
  // this agent OVERHEARD nearby (a conversation/say it's NOT a participant in) + ambient NEARBY-EVENTS (who
  // entered/sat/left around it). The sim computes the audience (sim/earshot.ts) + surfaces these per-listener.
  const overheard: OverheardRecord[] = Array.isArray((p as { overheard?: unknown }).overheard) ? (p as { overheard: OverheardRecord[] }).overheard : [];
  const nearbyEvents: NearbyEventRecord[] = Array.isArray((p as { nearbyEvents?: unknown }).nearbyEvents) ? (p as { nearbyEvents: NearbyEventRecord[] }).nearbyEvents : [];

  // COGNITION (Park et al. generative agents): perceive→remember, ensure today's plan, then retrieve a
  // RELEVANT working set + the cached agent-summary (the paper's behaviour, superseding the ad-hoc digest).
  // Falls back to recentDigest when no Mind is wired so the loop stays runnable either way. Best-effort —
  // Mind degrades-don't-die internally, so a model/embedding hiccup never blocks the ACT turn.
  let header = persona.system;
  let context: string;
  if (mind) {
    // W2b: observe the RICH NL perception (perception.ts observationText — the interior, who's adjacent,
    // what's nearby) rather than the raw situation JSON; fall back to the JSON if the sim predates the upgrade.
    // T0 THROUGHPUT (audit A4): EXPLICIT importance on the hot-loop observes. Un-annotated observe() spends a
    // full CLI-spawned LLM call on a 1-integer poignancy score — 2-3 of those per tick were a bigger wall-time
    // cost than the ACT turn itself. Routine perception is 3 (mundane); inbound gossip 4. Salient channels
    // (directed says 7, overheard 5/6) were already explicit. LLM poignancy still scores anything un-annotated.
    await mind.observe(p.observationText ?? `I perceive: ${situation}`, { importance: 3 });
    if (said.trim()) await mind.observe(`Heard nearby: ${said}`, { importance: 4 }); // gossip enters the memory stream
    // #18: an inbound say DIRECTED AT me is salient — observe it at higher importance (7) so it competes in
    // retrieval and the agent is primed to reply, instead of it drowning in the recent-8 activity digest.
    const heard = Array.isArray((p as { heardRecently?: unknown }).heardRecently) ? (p as { heardRecently: Array<{ from?: string; text?: string }> }).heardRecently : [];
    for (const h of heard) {
      if (h?.text) await mind.observe(`${h.from ?? "someone"} said to me: "${String(h.text).slice(0, 200)}"`, { importance: 7 });
    }
    // B7 EARSHOT: fold what I OVERHEARD (not directed at me) into memory at importance 5 — above co-presence (3)
    // and partner-POV ingest (4), below a directed say (7). A diffusable rumor (mentionedBelief) gets 6 so info
    // DIFFUSION through overhearing competes in retrieval (the paper's diffusion mechanic). NOT a reply-pressure block.
    for (const o of overheard) {
      if (!o?.gist) continue;
      const whereAt = o.at ? ` at ${buildingLabel(o.at)}`.replace(/ at undefined/, "") : "";
      const text = o.kind === "say"
        ? `I overheard ${o.from ?? "someone"}${whereAt} say: "${String(o.gist).slice(0, 200)}"`
        : `I overheard ${o.from ?? "someone"}${o.to ? ` and ${o.to}` : ""}${whereAt} talking about ${String(o.gist).slice(0, 160)}`;
      await mind.observe(text, { importance: o.mentionedBelief ? 6 : 5 });
    }
    // B7 NEARBY-EVENTS: ambient presence-deltas (who entered/sat/left around me) at low importance (4). FLOOD-
    // MITIGATION (my memory-stream tuning): collapse a same-actor "entered"+"sat" into one line, DROP bare
    // "moved"/"stood" (seat-shuffle noise), cap to the latest few — so ambient context never drowns real
    // observations. This keeps nearbyEvents as the felt "the café is filling up", not a per-tick spam.
    {
      const meaningful = nearbyEvents.filter((e) => e?.actor && e.verb !== "moved" && e.verb !== "stood");
      const byActor = new Map<string, NearbyEventRecord[]>();
      for (const e of meaningful) { const a = byActor.get(e.actor) ?? []; a.push(e); byActor.set(e.actor, a); }
      const folded: string[] = [];
      for (const [actor, evs] of byActor) {
        const verbs = new Set(evs.map((e) => e.verb));
        const place = evs[evs.length - 1].place;
        const where = place ? ` ${buildingLabel(place)}`.replace(/ undefined$/, "") : " nearby";
        if (verbs.has("entered") && verbs.has("sat")) folded.push(`${actor} came in and sat down at${where}`);
        else if (verbs.has("entered")) folded.push(`${actor} entered${where}`);
        else if (verbs.has("sat")) folded.push(`${actor} sat down at${where}`);
        else if (verbs.has("left")) folded.push(`${actor} left${where}`);
        else if (verbs.has("approached")) folded.push(`${actor} is coming your way on the street`); // socialweaver's street-approach fan
      }
      for (const line of folded.slice(-3)) await mind.observe(line, { importance: 4 });
    }
    // A1: ensure today's plan exists, seeded with this agent's REAL buildings (so agenda lines name move()-able
    // ids), then JIT-decompose the current chunk at most once per game-hour (the paper's plan granularity).
    await mind.ensureDailyPlan({ buildings: places });
    await mind.decomposeCurrentHourly();
    header = await mind.summary();
    context = await mind.contextFor(p.observationText ?? situation);
  } else {
    context = recentDigest(id, 12);
  }

  // A1 — THE KEYSTONE, now T0-STRUCTURED: what should this agent be doing RIGHT NOW, and where, at which
  // station? Primary source = the deterministic schedule spine (schedules.ts stepAt — building + station +
  // reason, no regex inference). A react-replan (paper §4.3.1) still overrides it: currentStep() returns the
  // newest plan line for this time-slot, and a line that is NOT one of today's template lines is LLM-born —
  // that reaction wins for its bracket. Degrades to the old inferStepTarget path when neither exists.
  const step = mind ? mind.currentStep(gameMinutes) : null;
  // B6: is this citizen within its own WORK-WINDOW right now, and is it AT its workplace? These drive the
  // work-window override below — the showcase fix so a musician/student/courier doesn't linger at the cafe all
  // shift. onShift also tilts inferStepTarget toward the workplace for vague mid-shift plan lines.
  const onShift = onShiftNow(id, gameMinutes);
  const atWork = hereId === places.workId;
  // T0: the structured schedule block for "now" + the replan-override decision.
  const block: ScheduleBlock | null = stepAt(id, gameMinutes) ?? null;
  const templateLines = new Set(agendaLines(id));
  const replanStep = step && !templateLines.has(step.text) ? step : null;
  // pick the target building: a replan line is inferred (it's free text); the schedule block is explicit.
  const stepTarget = replanStep
    ? inferStepTarget(replanStep.text, places, clock.period, onShift)
    : block
      ? block.buildingId
      : step
        ? inferStepTarget(step.text, places, clock.period, onShift)
        : null;
  const atTarget = !!stepTarget && hereId === stepTarget;
  // the named STATION to hold at the target (schedule-declared; meaningful once inside the building).
  const station = !replanStep && block && block.buildingId === stepTarget ? (block.station ?? null) : null;
  // A3: passive role-action status for NON-producer roles (musician/student/regular have no producer verb) —
  // when they're standing at their workplace, surface a visible "busking/holding court" bubble so the renderer
  // can draw activity inside the pub/college. Producers emit their status on the produce verb instead. Throttled
  // to once per game-hour so a stationary agent doesn't flood events.jsonl every tick.
  if (!PRODUCER[persona.role] && hereId && hereId === places.workId) {
    const passive = PASSIVE_STATUS[id] ?? PASSIVE_STATUS[persona.role];
    const hour = Math.floor(gameMinutes / 60);
    if (passive && lastPassiveStatusHour[id] !== hour) {
      lastPassiveStatusHour[id] = hour;
      await emit("status", id, { text: passive.text, emoji: passive.emoji, at: places.workId, turn: tick });
    }
  }

  // A1/T0: where the day says I should be vs where I am — phrased for the "advance your plan" branch below.
  // The schedule flavor carries the block's time bracket + activity + reason + station so the agent's sense of
  // "what now" is concrete (time of day, step, target station — not just a building).
  const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const planLine = replanStep
    ? (atTarget
        ? `Your plan for now: "${replanStep.text}". You ARE at ${buildingLabel(stepTarget!)} (${stepTarget}) — do it.`
        : `Your plan for now: "${replanStep.text}". You are NOT there yet — it's at ${buildingLabel(stepTarget!)} (${stepTarget}). move({to:"${stepTarget}"}) to go.`)
    : block
      ? (atTarget
          ? `Your day right now (${fmtMin(block.start)}–${fmtMin(block.end)}): ${block.activity}${block.reason ? ` — ${block.reason}` : ""}. You ARE at ${buildingLabel(block.buildingId)}${station ? `; your spot here is ${station}` : ""} — do it.`
          : `Your day right now (${fmtMin(block.start)}–${fmtMin(block.end)}): ${block.activity}${block.reason ? ` — ${block.reason}` : ""}, at ${buildingLabel(block.buildingId)} (${block.buildingId}). You are NOT there yet — move({to:"${block.buildingId}"}) to go.`)
      : step
        ? (atTarget
            ? `Your plan for now: "${step.text}". You ARE at ${buildingLabel(stepTarget!)} (${stepTarget}) — do it.`
            : `Your plan for now: "${step.text}". You are NOT there yet — it's at ${buildingLabel(stepTarget!)} (${stepTarget}). move({to:"${stepTarget}"}) to go.`)
        : `You have no set plan for right now — use your judgment (head to your workplace ${places.workId} if it's the work day, or home ${places.homeId} at night).`;

  // B4+B7 → D28 AFFORDANCE MENU: when inside a modelled building, the prompt reads like a person scanning
  // the room — who's present (at which spot), what you can DO here (occupancy-aware spots via interiorist's
  // buildInteriorMenu: at-own-workplace→station · wantsToBuy→register · busy-table→JOIN · empty table), and
  // where your day goes NEXT (the leave-for affordance). One paragraph, not a stack of nudges.
  type InsideHere = { buildingId: string; sublocations: Array<{ id: string; label: string; kind: string; station?: boolean; seats?: Array<{ x: number; y: number }> }>; occupants: Array<{ id: string; sublocationId?: string }> };
  const inside = (p as { insideHere?: InsideHere }).insideHere;
  const selfSpot = inside?.occupants.find((o) => o.id === id)?.sublocationId ?? null;
  // the NEXT schedule block (for the "leave for …" affordance + plan-step beat): first block starting after
  // the current one, wrapping past midnight to the day's first.
  const blocks = scheduleFor(id) ?? [];
  const nextBlock: ScheduleBlock | null = block
    ? (blocks.find((b) => b.start === block.end) ?? blocks[0] ?? null)
    : null;
  const leaveFor = nextBlock && nextBlock.buildingId !== hereId
    ? `leave for ${nextBlock.activity} at ${buildingLabel(nextBlock.buildingId)} (${nextBlock.buildingId}) from ${fmtMin(nextBlock.start)}`
    : "";
  let interiorLine = "";
  if (inside && inside.sublocations.length) {
    const goods = (p.currentShop?.goods ?? []) as Array<{ id: string; price?: string }>;
    // an unmet-need-here signal: this shop sells something I tend to want and don't already own (matches the buy loop).
    const wantsToBuy = !!p.currentShop && goods.some((g) => persona.buys.includes(g.id) && !(owns[g.id] > 0));
    const menu = buildInteriorMenu({
      buildingId: inside.buildingId,
      selfId: id,
      selfSpot,
      sublocations: inside.sublocations,
      occupants: inside.occupants,
      isShop: !!p.currentShop,
      goods,
      // liveConvosHere: not surfaced to /perceive yet → [] (the menu still distinguishes empty vs occupied tables;
      // the topic-aware "JOIN them — talking about X" lights up once the lead wires building dialogues to /perceive).
      conversations: [],
      atOwnWorkplace: inside.buildingId === places.workId,
      wantsToBuy,
    });
    const subLabel = new Map(inside.sublocations.map((s) => [s.id, s.label]));
    const others = inside.occupants.filter((o) => o.id !== id);
    const present = others.length
      ? others.map((o) => `${o.id}${o.sublocationId ? ` (at the ${subLabel.get(o.sublocationId) ?? o.sublocationId})` : ""}`).join(", ")
      : "no one else";
    const spotBits: string[] = [`spots — ${menu.menuLine}`];
    if (menu.suggestion) spotBits.push(`your place: go_inside({spot:"${menu.suggestion}"})${menu.suggestionWhy ? ` (${menu.suggestionWhy})` : ""}`);
    if (leaveFor) spotBits.push(leaveFor);
    interiorLine = `You're in ${buildingLabel(inside.buildingId)}. Present: ${present}. ${spotBits.join(" · ")}.`;
  }
  // D28 AFFORDANCE MENU (socialweaver's affordancesFor — supersedes the single commerceHint line): the
  // evaluated options OF THIS PLACE, occupancy/stock/funds/answered-aware, rendered as a numbered choice
  // block; ineligible entries carry their suppressor reason for the tape (D32). Atlas vocabulary v0.
  const affs = affordancesFor({
    selfId: id,
    buys: persona.buys,
    owns,
    usdc: typeof self.usdc === "number" ? self.usdc : null,
    currentShop: (p.currentShop ?? null) as AffordanceView["currentShop"],
    occupants: inside?.occupants ?? [],
    ...(producedGoodFor(id) ? { sellerStock: owns[producedGoodFor(id)!] ?? 0 } : {}),
    ...(PRODUCER[persona.role]?.verb ? { produceVerb: PRODUCER[persona.role]!.verb } : {}),
    heardRecently: (Array.isArray((p as { heardRecently?: unknown }).heardRecently) ? (p as { heardRecently: HeardSay[] }).heardRecently : []),
    ...(social ? { isAnswered: (sid: string) => social.pairs.isAnswered(sid) } : {}),
    adjacentTo: Array.isArray(p.adjacentTo) ? p.adjacentTo : [],
    approaching: nearbyEvents.filter((e) => e.verb === "approached" && e.actor).map((e) => e.actor),
    volition: social?.volitionTarget() ?? null,
  });
  const menuBlock = renderAffordanceMenu(affs);

  const lines = [
    // A1: a CLEAR sense of time — the agent can finally tell morning from afternoon (the grocer said "quiet
    // morning" at 14:10 because the prompt only had an opaque TICK n). This is the single most-load-bearing line.
    `It is ${clock.label}. You are ${id}. ${header}`,
    `Your workplace is ${buildingLabel(places.workId)} (${places.workId}); your home is ${buildingLabel(places.homeId)} (${places.homeId}); you relax at ${buildingLabel(places.hangoutId)} (${places.hangoutId}).`,
    planLine,
    interiorLine, // D28: situational awareness — who's present at which spot + your place + leave-for
    menuBlock, // D28: the numbered affordance menu of THIS place ("" when nothing affords)
    `You have ${self.usdc ?? "?"} testnet USDC. Keep a small reserve — don't go broke.`,
    `You tend to want: ${persona.buys.join(", ")}.`,
    `You currently OWN: ${ownsStr}. (Don't over-buy; consume what you hold to satisfy a need.)`,
    `You perceive: ${p.observationText ?? situation}`,
    p.currentShop
      ? `You are INSIDE ${p.currentShop.label ?? p.currentShop.id}. Goods: ${JSON.stringify(p.currentShop.goods ?? [])}.`
      : `You are out on Main Street (not inside a shop).`,
    said.trim() ? `Just said to you:\n${said}` : `No one has spoken to you just now.`,
    // #18: inbound says get their OWN high-salience block (un-drowned by the activity digest) so the agent
    // actually answers — this is what turns one-way says into two-way conversation.
    (() => {
      const heard = Array.isArray((p as { heardRecently?: unknown }).heardRecently) ? (p as { heardRecently: Array<{ from?: string; text?: string }> }).heardRecently : [];
      const adj: string[] = Array.isArray(p.adjacentTo) ? p.adjacentTo : [];
      if (!heard.length) return "";
      const last = heard[heard.length - 1];
      const stillHere = last?.from && adj.includes(last.from);
      return `💬 ${last?.from ?? "someone"} just said to you: "${String(last?.text ?? "").slice(0, 200)}". ` +
        (stillHere ? `They are RIGHT BESIDE you — REPLY now with talk({toId:"${last?.from}", msg:"…"}).` : `Move next to ${last?.from ?? "them"} if you want to reply.`);
    })(),
    // B7: AMBIENT — what you OVERHEAR around you (NOT directed at you, so no reply pressure; it's context, and an
    // invitation to JOIN if a conversation interests you). Distinct from the directed-say block above.
    (() => {
      if (!overheard.length) return "";
      const o = overheard[overheard.length - 1];
      const whereAt = o.at ? ` at ${buildingLabel(o.at)}`.replace(/ at undefined/, "") : "";
      const what = o.kind === "say"
        ? `${o.from ?? "someone"}${whereAt} say "${String(o.gist).slice(0, 160)}"`
        : `${o.from ?? "someone"}${o.to ? ` & ${o.to}` : ""}${whereAt} talking about ${String(o.gist).slice(0, 140)}`;
      return `👂 You overhear ${what}. (You're not part of it — but you could wander over to join in, or just take it in.)`;
    })(),
    `Relevant memories + today's plan:\n${context}`,
    `Decide what you do this tick:`,
    // D28 NEVER-STUCK: when the loop detected consecutive no-progress ticks, breaking the loop OUTRANKS
    // everything — the schedule spine resumes next tick once something lands.
    stuckNote
      ? `- ⚠ YOU ARE STUCK: ${stuckNote} Do something DIFFERENT this tick — do NOT repeat the failed action. Pick another reachable destination, act where you stand, or talk to whoever is near.`
      : "",
    // B6/T0 — WORK-WINDOW OVERRIDE, now aimed at the SCHEDULED place (not raw workId): if it's your working
    // hours and you are NOT where your day says (your station's building, or a scheduled round/errand stop —
    // the courier's route and the baker's lunch errand are both "the scheduled place"), getting there comes
    // FIRST — above chit-chat. Off-shift = reply-first freedom.
    onShift && !atTarget && stepTarget
      ? `- IT IS YOUR WORKING HOURS and your day is at ${buildingLabel(stepTarget)} (${stepTarget}) — you are NOT there. GO NOW: move({to:"${stepTarget}"}).${PASSIVE_STATUS[id] ? ` Your craft (${PASSIVE_STATUS[id].text.replace("…", "")}) happens there, not here.` : ""} A quick hello to someone beside you is fine, but go this turn.`
      : onShift && !atWork && !stepTarget
        ? `- IT IS YOUR WORKING HOURS (${buildingLabel(places.workId)}) and you are NOT there. GO NOW: move({to:"${places.workId}"}).`
        : `- If a citizen adjacent to you just said something to you, reply with talk() — answering them comes FIRST.`,
    // T0 STATION PINNING: at the right building with a declared station → take the spot AND do the work in the
    // SAME turn (a 2-3 call chain). At 4-8 acted ticks/day (audit A4), arrive→sit→work as three separate ticks
    // was a whole day; the chain collapses it to one, and holding the spot is what the interior view draws.
    (() => {
      if (!atTarget || !station || !inside) return "";
      const verb = producedGoodFor(id) && PRODUCER[persona.role] ? `${PRODUCER[persona.role]!.verb}()` : null;
      return selfSpot === station
        ? `- You are AT your spot (${station}). ${block ? block.activity : "Do what you came for"} — ${verb ? `${verb} if your shelf is low, serve whoever's here, or talk to whoever's beside you` : "do it now, or talk to whoever's beside you"}.`
        : `- TAKE YOUR SPOT NOW: go_inside({spot:"${station}"}) — and THEN, in this same turn, ${verb ? `${verb} or serve` : "do your thing there"}. Chain both calls this tick.`;
    })(),
    // A1: the daily plan DRIVES movement. This branch is what makes agents live across the whole map and keep
    // a schedule (instead of hugging the top street): go where the day says, then do the thing there.
    onShift && !atTarget && stepTarget
      ? `- If someone is talking to you, one short reply is OK — then move({to:"${stepTarget}"}).`
      : stepTarget
        ? (atTarget
            ? `- Otherwise ADVANCE YOUR PLAN: you're at the right place (${stepTarget}) — do the step's action now${producedGoodFor(id) ? ` (e.g. ${PRODUCER[persona.role]?.verb}() if your shelf is low, or serve/consume/buy as the moment calls for)` : ` (work/study/busk/rest, or consume/buy as it calls for)`}.`
            : `- Otherwise ADVANCE YOUR PLAN: you are not at the plan's place yet — move({to:"${stepTarget}"}) toward ${buildingLabel(stepTarget!)}. Don't linger on the street; your day is elsewhere.`)
        : `- Otherwise head to your workplace ${places.workId} (work day) or home ${places.homeId} (night) with move().`,
    // B7: ONE occupancy-aware interior nudge (supersedes the old B4 "take your place" + B6 located-action lines —
    // buildInteriorMenu's suggestion already covers "work your station" / "join the busy table" / "take an empty
    // one"). Only push it when inside AND not already at a spot, so it doesn't nag an agent already working/seated.
    inside && !inside.occupants.find((o) => o.id === id)?.sublocationId
      ? `- You're inside ${buildingLabel(inside.buildingId)} — take a place: ${interiorLine.includes("go_inside") ? "use the go_inside suggestion above" : "go_inside a spot that fits (your station to work, a busy table to join the talk, or an empty one to sit)"}.`
      : "",
    `- If you OWN a good that meets a current need, consume() it rather than buying more.`,
    `- If you are inside a shop and want a good you DON'T already have, call evaluate_purchase then (if mayBuy) buy.`,
    `- You can always greet an adjacent citizen with talk().`,
    `Be decisive. One short sentence of reasoning, then act. Moving somewhere = ONE move() and end your turn. Already at your place = you may CHAIN 2-3 calls (take your spot, then work/serve/talk).`,
  ];
  // Return the perception too (W2b): the citizen loop drives walk-up-and-talk off THIS pre-ACT perception, so the
  // dialogue fires on who was adjacent at perception time (not after this tick's move). T0 (additive): planStep
  // — the resolved "what/where/station now" — so the citizen loop can stamp it into the per-tick trace (§7 plan).
  const planStep = replanStep
    ? `[replan] ${replanStep.text} → ${stepTarget ?? "?"}`
    : block
      ? `${fmtMin(block.start)}-${fmtMin(block.end)} ${block.activity} @${block.buildingId}${station ? `#${station}` : ""}`
      : step
        ? `${step.text} → ${stepTarget ?? "?"}`
        : "";
  // D32: the plan-step beat's structured payload (the citizen loop emits it once per CHANGE, not per tick).
  const planMeta: PlanMeta | null = block && !replanStep
    ? { step: block.activity, until: fmtMin(block.end), ...(block.reason ? { why: block.reason } : {}), building: block.buildingId, station: station }
    : replanStep
      ? { step: replanStep.text, until: "replan", building: stepTarget ?? "", station: null }
      : null;
  // D32: the PRESENTED OPTION SET is a tape beat — "which choices did the agent SEE when it made a poor one".
  // Canonical kind:"menu" (flight-tape-schema layer 3): options[] = the eligible entry ids (atlas-vocab-
  // tagged via the eligible/suppressed detail from affordanceBeatPayload — suppressors WITH reasons ride in
  // the same beat, so an empty options[] plus its reasons is the stuck-precursor flag). tick joins the chain.
  const menuCount = affs.filter((a) => a.eligible).length;
  await emit("menu", id, {
    tick,
    turn: tick,
    at: hereId,
    plan: planStep,
    options: affs.filter((a) => a.eligible).map((a) => a.id),
    ...affordanceBeatPayload(affs),
  });
  return { prompt: lines.join("\n"), perceived: p, planStep, planMeta, menuCount };
}

export { personaFor };
