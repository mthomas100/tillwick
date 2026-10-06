// COMMERCE CHOREOGRAPHY (town-alive B3 — the operator's north-star vignette, generalized): the physical
// shape of a purchase. A customer whose plan says "coffee" ENTERS Hobbs Cafe, TAKES A SEAT if the barista
// isn't at the counter yet, WALKS TO THE REGISTER when she is, ORDERS (a say the clerk answers), PAYS over
// the real x402 rails (custody on txHash — the existing buy loop, untouched), then SITS and CONSUMES at a
// table, where the A3/B1 co-location ignition turns neighbors into table-talk. The clerk's mirror: be at
// your register station, restock (produce) when the shelf is low, greet the customer at your counter.
//
// DELIBERATELY A DERIVED-STATE MACHINE, NOT A STORED ONE: the "state" is recomputed from perception every
// tick (where am I, who's at the register, what do I own) — nothing persists, so tick starvation, restarts,
// and missed ticks can never desync it; it just re-derives "the next sensible step" from the world. The LLM
// stays the CHOOSER (whether to pursue coffee at all — the plan) and the FLAVORER (what the order line
// sounds like); this module owns only the SEQUENCE. Zero-LLM testable end-to-end with a fake payer.
//
// SCENES ARE DATA: every shop's register/prep/seats come from world.json's interior blocks via
// sim/interiors.ts (cafe → cafe-counter + espresso-machine + 2 tables; bakery → bakery-counter + oven;
// grocer → grocer-register; smithy → smithy-counter + forge; depot → supply-counter + workbench), so the
// same machine runs Moreno-Bakery-bread and Willows-Market-supplies without new code. The Rose & Crown has
// a bar-counter but sells nothing in world.json — and musician tips would need a NEW money rail (no shop,
// no good, no port), so per the brief that is REPORTED as discovered, not built.

import { interiorOf, type Sublocation } from "../sim/interiors.js";
import { SHOP_OWNER, GOOD_TO_SHOP } from "../shops/registry.js";

// ---- the scene (per-shop layout, derived once from world.json) -------------------------------------------

export type Scene = {
  shopId: string;
  ownerId: string; // the clerk (SHOP_OWNER)
  registerSpotId: string; // where ordering/paying happens (counter-kind station, or "register" in the id)
  prepSpotId?: string; // where the clerk PREPARES (espresso-machine / oven / forge …) — a non-register station
  tableIds: string[]; // seatable spots (kind "table"/"seat") for waiting/consuming
};

/** Derive a shop's scene from its modelled interior. Null when the building has no interior or no station
 *  (nothing to choreograph — the plain enterShop/buy flow still works without us). */
export function sceneFor(shopId: string): Scene | null {
  const def = interiorOf(shopId);
  const ownerId = SHOP_OWNER[shopId];
  if (!def || !ownerId) return null;
  const stations = def.sublocations.filter((s) => s.station);
  if (stations.length === 0) return null;
  const register =
    stations.find((s) => s.kind === "counter" || /register|counter/.test(s.id)) ?? stations[0];
  const prep = stations.find((s) => s.id !== register.id);
  const tables = def.sublocations.filter((s) => s.kind === "table" || s.kind === "seat").map((s) => s.id);
  return {
    shopId,
    ownerId,
    registerSpotId: register.id,
    ...(prep ? { prepSpotId: prep.id } : {}),
    tableIds: tables,
  };
}

// ---- perception slice (exactly what renderTick already has in hand) --------------------------------------

export type OccupantView = { id: string; sublocationId?: string };

export type CommerceView = {
  selfId: string;
  /** Goods I tend to want (persona.buys). */
  buys: string[];
  /** What I currently own (inventory counts). */
  owns: Record<string, number>;
  /** The shop I'm standing in (perception currentShop), with its goods. */
  currentShop?: { id: string; goods: Array<{ id: string; price?: string }> } | null;
  /** Interior occupancy (perception insideHere.occupants) — [] until main's /perceive insideHere fix lands,
   *  which degrades this to counter-blind (see buyerNextStep note). */
  occupants: OccupantView[];
  /** My own current spot inside (derived from occupants, passed for convenience). */
  selfSpot?: string | null;
};

// ---- the actions (each maps 1:1 onto existing world tools — nothing new for lifegiver to build) ----------

export type CommerceAction =
  | { kind: "wait-seated"; spot: string; line: string } // clerk not at register yet → take a seat
  | { kind: "to-register"; spot: string; line: string } // clerk is there → step up
  | { kind: "order-and-pay"; clerkId: string; item: string; orderMsg: string; line: string } // talk + evaluate_purchase + buy
  | { kind: "sit-to-consume"; spot: string; item: string; line: string } // paid → take a table
  | { kind: "consume-here"; item: string; line: string } // seated with the good → consume
  | { kind: "clerk-to-station"; spot: string; line: string } // clerk: man the register
  | { kind: "clerk-restock"; line: string } // clerk: shelf empty → produce (bake/brew/…)
  | { kind: "clerk-serve"; customerId: string; line: string }; // clerk: customer at the counter → greet/serve

/**
 * The CUSTOMER's next choreography step, derived purely from the view. Null when there's nothing commerce-
 * shaped to do here (not in a shop, nothing wanted here, or already satisfied) — the caller falls back to
 * plan/social prompts. Sequence (the vignette): want → [clerk absent? sit and wait] → register → order+pay →
 * table → consume. Custody/settlement stay the existing rails: order-and-pay maps to talk() +
 * evaluate_purchase() + buy() in ONE ACT turn (maxTurns allows it), txHash custody via /act buyResult.
 */
export function buyerNextStep(v: CommerceView): CommerceAction | null {
  const shop = v.currentShop;
  if (!shop) return null;
  const scene = sceneFor(shop.id);
  if (!scene || scene.ownerId === v.selfId) return null; // no modelled scene, or it's MY shop (clerk path)

  const sold = new Set(shop.goods.map((g) => g.id));
  const want = v.buys.find((b) => sold.has(b) && !(v.owns[b] > 0));
  const held = v.buys.find((b) => sold.has(b) && v.owns[b] > 0);
  const selfSpot = v.selfSpot ?? v.occupants.find((o) => o.id === v.selfId)?.sublocationId ?? null;
  const clerkPresent = v.occupants.some((o) => o.id === scene.ownerId);
  const clerkAtRegister = v.occupants.some((o) => o.id === scene.ownerId && o.sublocationId === scene.registerSpotId);
  const seated = !!selfSpot && scene.tableIds.includes(selfSpot);

  // Already holding what I came for → sit down and consume it here (tables permitting).
  if (!want && held) {
    if (seated) {
      return { kind: "consume-here", item: held, line: `You're settled at your table with your ${held} — enjoy it: consume({item:"${held}"}). Chat with anyone sitting near you.` };
    }
    if (scene.tableIds.length) {
      return { kind: "sit-to-consume", spot: scene.tableIds[0], item: held, line: `You've got your ${held} — take a seat to enjoy it: go_inside({spot:"${scene.tableIds[0]}"}).` };
    }
    return { kind: "consume-here", item: held, line: `You've got your ${held} — enjoy it: consume({item:"${held}"}).` };
  }
  if (!want) return null; // nothing here I want that I don't have

  // Want something. Is the clerk workable? (occupants may be empty until the insideHere wire-fix lands —
  // then clerkPresent is false and we degrade to the seat-and-wait branch only if seats exist, else order
  // "blind": the talk() adjacency gate + buy still work on the shared shop tile.)
  if (clerkAtRegister || (clerkPresent && !scene.tableIds.length)) {
    if (selfSpot === scene.registerSpotId) {
      const price = shop.goods.find((g) => g.id === want)?.price ?? "";
      return {
        kind: "order-and-pay",
        clerkId: scene.ownerId,
        item: want,
        orderMsg: `One ${want}, please!`,
        line:
          `You're at the ${scene.registerSpotId} and ${scene.ownerId} is serving. Order and pay NOW, in this turn: ` +
          `talk({toId:"${scene.ownerId}", msg:"One ${want}, please!"}) then evaluate_purchase({item:"${want}", price_usdc:${numPrice(price)}, ...}) and (if mayBuy) buy({item:"${want}"}).`,
      };
    }
    return { kind: "to-register", spot: scene.registerSpotId, line: `${scene.ownerId} is at the ${scene.registerSpotId} — step up to order: go_inside({spot:"${scene.registerSpotId}"}).` };
  }
  if (v.occupants.length === 0) {
    // occupancy-blind (insideHere absent): fall back to ordering at the register — the rails still work.
    return { kind: "to-register", spot: scene.registerSpotId, line: `Step up to the ${scene.registerSpotId} to order your ${want}: go_inside({spot:"${scene.registerSpotId}"}).` };
  }
  if (scene.tableIds.length) {
    if (seated) return null; // already waiting — let the social/plan prompts fill the moment (table-talk)
    return { kind: "wait-seated", spot: scene.tableIds[0], line: `${scene.ownerId} isn't at the ${scene.registerSpotId} yet — take a seat while you wait: go_inside({spot:"${scene.tableIds[0]}"}).` };
  }
  return null;
}

/**
 * The CLERK's next choreography step at their own shop: man the register; restock (the role's produce verb)
 * when the shelf is empty; greet/serve a customer standing at the counter. `myStock` is the clerk's held
 * count of the shop's primary good; `produceVerb` names the role tool (bake/brew/…), only used in the line.
 */
export function clerkNextStep(v: CommerceView & { myStock: number; produceVerb?: string }): CommerceAction | null {
  const shop = v.currentShop;
  if (!shop) return null;
  const scene = sceneFor(shop.id);
  if (!scene || scene.ownerId !== v.selfId) return null;
  const selfSpot = v.selfSpot ?? v.occupants.find((o) => o.id === v.selfId)?.sublocationId ?? null;

  if (selfSpot !== scene.registerSpotId) {
    return { kind: "clerk-to-station", spot: scene.registerSpotId, line: `Your shop is open — take your station: go_inside({spot:"${scene.registerSpotId}"}).` };
  }
  const customer = v.occupants.find((o) => o.id !== v.selfId && o.sublocationId === scene.registerSpotId);
  if (customer) {
    return { kind: "clerk-serve", customerId: customer.id, line: `${customer.id} is at your counter — serve them: greet with talk({toId:"${customer.id}", msg:"…"})${v.myStock <= 0 && v.produceVerb ? ` and ${v.produceVerb}() so you have stock to sell` : ""}.` };
  }
  if (v.myStock <= 0 && v.produceVerb) {
    const at = scene.prepSpotId ? ` at the ${scene.prepSpotId}` : "";
    return { kind: "clerk-restock", line: `Your shelf is empty — make stock${at}: ${v.produceVerb}().` };
  }
  return null;
}

/**
 * ONE prompt line for renderTick (lifegiver's hook): the next commerce step for this agent at this place,
 * "" when choreography has nothing to add. Chooses the clerk or buyer path by shop ownership. This is the
 * whole integration surface — world-tools calls it with values it already has in scope.
 */
export function commerceHint(v: CommerceView & { myStock?: number; produceVerb?: string }): string {
  const shopId = v.currentShop?.id;
  if (!shopId) return "";
  const action =
    SHOP_OWNER[shopId] === v.selfId
      ? clerkNextStep({ ...v, myStock: v.myStock ?? 0 })
      : buyerNextStep(v);
  return action?.line ?? "";
}

/** Where is `good` bought, physically? (For the volition/plan side: "coffee" → cafe.) */
export function shopSelling(good: string): string | undefined {
  return GOOD_TO_SHOP[good];
}

function numPrice(price: string): number {
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0.01;
}

// ---- runnable self-test (ZERO tokens, fake payer) --------------------------------------------------------
// `tsx citizens/commerce-choreography.ts` walks the FULL cafe vignette as a simulated world: student wants
// coffee → seat-while-waiting → barista arrives at the counter → student steps to the register → orders and
// PAYS via a FAKE payer (asserting custody lands with a txHash) → sits → consumes. Then the clerk mirror
// (station → restock-when-empty → serve-at-counter) and the bakery/grocer generalization. Pure — no sim, no
// model, no network; the only I/O is world.json via interiorOf (read-only).
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
  };

  // --- scenes derive from world.json for every real shop ---
  const cafe = sceneFor("cafe");
  assert(cafe?.registerSpotId === "cafe-counter" && cafe?.prepSpotId === "espresso-machine", `cafe scene: register+prep derived (got ${JSON.stringify(cafe)})`);
  assert(cafe!.tableIds.length >= 2, "cafe has seatable tables");
  assert(sceneFor("bakery")?.registerSpotId === "bakery-counter", "bakery scene derives (bread at the register)");
  assert(sceneFor("grocer")?.registerSpotId === "grocer-register", "grocer scene derives (supplies at checkout)");
  assert(sceneFor("smithy")?.registerSpotId === "smithy-counter" && sceneFor("depot")?.registerSpotId === "supply-counter", "smithy + depot scenes derive");
  assert(sceneFor("nonexistent") === null, "no interior → no scene (degrade)");

  // --- the FULL cafe path, driven by a fake world + fake payer ---
  const world = {
    occupants: [] as OccupantView[], // cafe interior occupancy
    owns: {} as Record<string, number>, // student's holdings
    paid: [] as Array<{ item: string; txHash: string }>,
  };
  const fakePay = (item: string) => {
    const txHash = `0xfake${world.paid.length + 1}`;
    world.paid.push({ item, txHash });
    world.owns[item] = (world.owns[item] ?? 0) + 1; // custody on settlement (the /act buyResult mirror)
    return txHash;
  };
  const view = (): CommerceView => ({
    selfId: "student",
    buys: ["coffee", "bread"],
    owns: { ...world.owns },
    currentShop: { id: "cafe", goods: [{ id: "coffee", price: "$0.02" }] },
    occupants: [...world.occupants],
    selfSpot: world.occupants.find((o) => o.id === "student")?.sublocationId ?? null,
  });
  const setSpot = (id: string, spot?: string) => {
    world.occupants = world.occupants.filter((o) => o.id !== id);
    world.occupants.push({ id, ...(spot ? { sublocationId: spot } : {}) });
  };

  const path: string[] = [];
  // Step 1: student walks in; barista not yet at the counter (occupants: student only) → wait seated.
  setSpot("student");
  let a = buyerNextStep(view());
  assert(a?.kind === "wait-seated" && cafe!.tableIds.includes((a as { spot: string }).spot), `clerk absent → wait at a table (got ${JSON.stringify(a)})`);
  path.push(a!.kind);
  setSpot("student", (a as { spot: string }).spot);

  // Step 2: seated and waiting → choreography yields (social fills the moment), no thrash.
  a = buyerNextStep(view());
  assert(a === null, "seated-and-waiting → null (no action thrash while the clerk is away)");

  // Step 3: the barista takes her station → step up to the register.
  setSpot("barista", "cafe-counter");
  a = buyerNextStep(view());
  assert(a?.kind === "to-register" && (a as { spot: string }).spot === "cafe-counter", "clerk at station → go to the register");
  path.push(a!.kind);
  setSpot("student", "cafe-counter");

  // Step 4: at the register, clerk serving → order AND pay (talk + evaluate + buy in one turn).
  a = buyerNextStep(view());
  assert(a?.kind === "order-and-pay", "at the register with the clerk → order-and-pay");
  const op = a as { clerkId: string; item: string; orderMsg: string; line: string };
  assert(op.clerkId === "barista" && op.item === "coffee", "order names the clerk + the wanted good");
  assert(/talk\(/.test(op.line) && /evaluate_purchase/.test(op.line) && /buy\(/.test(op.line), "the hint line spells out the exact tool calls");
  path.push(a!.kind);
  const tx = fakePay(op.item); // the FAKE x402 payer settles; custody lands with the txHash
  assert(world.paid.length === 1 && world.paid[0].txHash === tx && world.owns.coffee === 1, "fake payer: custody moved on settlement (txHash recorded)");

  // Step 5: paid and holding → take a table to consume.
  a = buyerNextStep(view());
  assert(a?.kind === "sit-to-consume" && (a as { item: string }).item === "coffee", "holding the good → sit to consume");
  path.push(a!.kind);
  setSpot("student", (a as { spot: string }).spot);

  // Step 6: seated with the good → consume here (and the line invites table-talk).
  a = buyerNextStep(view());
  assert(a?.kind === "consume-here" && /consume\(\{item:"coffee"\}\)/.test(a!.line), "seated with the good → consume-here");
  assert(/chat/i.test(a!.line), "the consume line invites table-talk (ignition takes it from there)");
  path.push(a!.kind);
  world.owns.coffee = 0; // consumed — the need will recur (the rebuy loop)

  // Step 7: nothing held, clerk still there, I'm at a table → the machine loops back PHYSICALLY: walk to
  // the register again (the demand loop restarts the same path, not a teleported re-order).
  a = buyerNextStep(view());
  assert(a?.kind === "to-register", "after consuming, the want recurs → walk back to the register");

  assert(
    JSON.stringify(path) === JSON.stringify(["wait-seated", "to-register", "order-and-pay", "sit-to-consume", "consume-here"]),
    `ACCEPTANCE — the cafe state machine walks its full path (got ${path.join(" → ")})`,
  );

  // --- occupancy-blind degrade (insideHere missing until main's wire-fix): still reaches the register ---
  const blind = buyerNextStep({ selfId: "student", buys: ["coffee"], owns: {}, currentShop: { id: "cafe", goods: [{ id: "coffee", price: "$0.02" }] }, occupants: [] });
  assert(blind?.kind === "to-register", "no occupancy data → degrade straight to the register (rails still work)");

  // --- the CLERK mirror: station → restock-when-empty → serve-at-counter ---
  let c = clerkNextStep({ selfId: "barista", buys: [], owns: {}, currentShop: { id: "cafe", goods: [{ id: "coffee" }] }, occupants: [{ id: "barista" }], myStock: 0, produceVerb: "brew" });
  assert(c?.kind === "clerk-to-station" && (c as { spot: string }).spot === "cafe-counter", "clerk off-station → take the register");
  c = clerkNextStep({ selfId: "barista", buys: [], owns: {}, currentShop: { id: "cafe", goods: [{ id: "coffee" }] }, occupants: [{ id: "barista", sublocationId: "cafe-counter" }], myStock: 0, produceVerb: "brew" });
  assert(c?.kind === "clerk-restock" && /brew\(\)/.test(c!.line) && /espresso-machine/.test(c!.line), "empty shelf → restock at the prep station (espresso machine)");
  c = clerkNextStep({ selfId: "barista", buys: [], owns: {}, currentShop: { id: "cafe", goods: [{ id: "coffee" }] }, occupants: [{ id: "barista", sublocationId: "cafe-counter" }, { id: "student", sublocationId: "cafe-counter" }], myStock: 3, produceVerb: "brew" });
  assert(c?.kind === "clerk-serve" && (c as { customerId: string }).customerId === "student", "customer at the counter → serve them");

  // --- commerceHint dispatches by ownership and stays quiet with nothing to do ---
  assert(/go_inside/.test(commerceHint({ selfId: "student", buys: ["coffee"], owns: {}, currentShop: { id: "cafe", goods: [{ id: "coffee" }] }, occupants: [] })), "hint: buyer path");
  assert(/station|register|counter/.test(commerceHint({ selfId: "barista", buys: [], owns: {}, currentShop: { id: "cafe", goods: [{ id: "coffee" }] }, occupants: [{ id: "barista" }], myStock: 2, produceVerb: "brew" })), "hint: clerk path");
  assert(commerceHint({ selfId: "student", buys: ["nail"], owns: {}, currentShop: { id: "cafe", goods: [{ id: "coffee" }] }, occupants: [] }) === "", "hint: shop doesn't sell what I want → silent");
  assert(commerceHint({ selfId: "student", buys: [], owns: {}, occupants: [] }) === "", "hint: not in a shop → silent");

  // --- generalization: the same machine runs the bakery (bread at the register) ---
  const bread = buyerNextStep({ selfId: "regular", buys: ["bread", "milk"], owns: {}, currentShop: { id: "bakery", goods: [{ id: "bread", price: "$0.01" }] }, occupants: [{ id: "baker", sublocationId: "bakery-counter" }, { id: "regular" }] });
  assert(bread?.kind === "to-register" && (bread as { spot: string }).spot === "bakery-counter", "bakery: same machine, bread at the register");

  console.log("commerce-choreography.ts self-test: ALL ASSERTIONS PASSED (scene derivation ×5 shops · FULL cafe path with fake payer + custody-on-txHash · rebuy loop · occupancy-blind degrade · clerk station/restock/serve · hint dispatch · bakery generalization)");
}
