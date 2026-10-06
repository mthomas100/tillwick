// cognition/interior-awareness.ts — INTERIOR OBJECT-AWARENESS: turn the flat "who's inside" presence into a
// per-sublocation picture (empty vs occupied · WHO is at each spot · what's purchasable · is a conversation
// happening there) AND a clear, occupancy-aware DECISION MENU the ACT prompt presents so an agent can choose
// where to go inside — work the register, buy at the counter, sit at an EMPTY table, or JOIN a table where
// people are talking (the operator's exact decision list, Pillar II).
//
// PURE + STATELESS (the seam pattern: like perception.ts / interiors.ts defs — no I/O, no LLM, no SDK). Consumes
// ONLY plain data the perception already has: the `InsideHere` block (sublocations + flat occupants, both
// interior-local), the building's goods (for "purchasable"), and an optional list of live conversations at this
// building (from earshot/dialogue). Returns enriched spots + the menu strings. behaviorist's perception.ts /
// world-tools.ts call these; this module invents no new transport.
//
// WHY THIS EXISTS: the data to tell an EMPTY table from one where
// "Klaus & Sam are talking" is ALREADY in `insideHere.occupants` (each carries its `sublocationId`), but the
// current menu (world-tools.ts:534) ignores it — it lists spots without occupancy, so an agent literally can't
// choose "the empty one" or "join them." This module is that missing join + the decision phrasing.

// Mirror the shapes perception.ts already publishes (kept structural so this module doesn't import the sim).
export type SublocationLike = {
  id: string;
  label: string;
  kind: string;        // SublocationKind from interiors.ts (counter|table|register|stage|bed|desk|seat|shelf|appliance)
  station?: boolean;   // a work spot
  seats?: Array<{ x: number; y: number }>;
};
export type OccupantLike = { id: string; sublocationId?: string };
export type GoodLike = { id: string; price?: string };
/** A live conversation happening at this building right now (from the dialogue/earshot layer), used to mark a
 *  table as "in conversation" so the menu can say "JOIN them (talking about X)". `participants` are agent ids;
 *  `topic` is the dialogue topic if known. The caller maps participants→their current spot. */
export type LiveConversation = { participants: string[]; topic?: string };

/** One sublocation, enriched with live facts. Additive over the raw `Sublocation` — never replaces it. */
export type EnrichedSpot = {
  id: string;
  label: string;
  kind: string;
  station: boolean;
  occupants: string[];       // agent ids AT this exact spot (excluding self if the caller passed selfId)
  seatCount: number;         // total seats (0 for a single-spot station/appliance)
  freeSeats: number;         // seatCount - occupants-here (clamped ≥0); for a seated spot, >0 means "you can sit"
  occupied: boolean;         // someone (other than self) is here
  empty: boolean;            // a seated spot with no one here (the "EMPTY table" the operator wants to distinguish)
  purchasable: boolean;      // a register/counter at a shop that sells goods → you can buy here
  sells: string[];           // the good ids purchasable here (when purchasable)
  conversationHere: boolean; // a live dialogue is happening at this spot
  conversationTopic?: string; // its topic, if known (for "join them — talking about X")
  conversationWith: string[]; // the other participants at this spot (so the prompt can name "Klaus & Sam")
};

export type InteriorAwarenessInput = {
  buildingId: string;
  /** the agent perceiving — its spot is excluded from "occupants" so it doesn't count itself as company. */
  selfId: string;
  /** the agent's CURRENT spot inside (occupant.sublocationId for self), or undefined if it's at spawnInside/door. */
  selfSpot?: string | null;
  sublocations: SublocationLike[];
  occupants: OccupantLike[];   // everyone inside (incl. self) — interior-local, from insideHere.occupants
  goods?: GoodLike[];          // the building's goods (shops only) → "purchasable"/"sells"
  isShop?: boolean;            // building.type === "shop" (only shops sell; a register in a civic bldg isn't a till)
  conversations?: LiveConversation[]; // live dialogues at this building (optional)
  /** true if this building is the agent's OWN workplace → bias the suggestion toward its work station. */
  atOwnWorkplace?: boolean;
  /** true if the agent has an unmet need it could satisfy by buying here (caller decides) → bias toward register. */
  wantsToBuy?: boolean;
};

// ---- enrichment: group occupants by spot + compute per-spot state -----------------------------------------

/** Enrich each sublocation with live occupancy / purchasable / conversation facts. Pure. */
export function enrichSpots(input: InteriorAwarenessInput): EnrichedSpot[] {
  const { selfId, sublocations, occupants } = input;
  // group OTHER occupants (not self) by their sublocationId.
  const bySpot = new Map<string, string[]>();
  for (const o of occupants) {
    if (!o.sublocationId || o.id === selfId) continue;
    const arr = bySpot.get(o.sublocationId) ?? [];
    arr.push(o.id);
    bySpot.set(o.sublocationId, arr);
  }
  // index conversations by the spot of each participant (a conversation "is at" a spot if a participant sits there).
  // Map spotId -> { topic?, others:Set } so a table where 2 participants sit shows both as company.
  const convoBySpot = new Map<string, { topic?: string; others: Set<string> }>();
  for (const c of input.conversations ?? []) {
    for (const pid of c.participants) {
      const spot = occupants.find((o) => o.id === pid)?.sublocationId;
      if (!spot) continue;
      const entry = convoBySpot.get(spot) ?? { topic: c.topic, others: new Set<string>() };
      if (c.topic && !entry.topic) entry.topic = c.topic;
      for (const other of c.participants) if (other !== selfId) entry.others.add(other);
      convoBySpot.set(spot, entry);
    }
  }
  const sells = input.isShop ? (input.goods ?? []).map((g) => g.id) : [];
  return sublocations.map((s) => {
    const here = bySpot.get(s.id) ?? [];
    const seatCount = s.seats?.length ?? 0;
    const freeSeats = Math.max(0, seatCount - here.length);
    const isSeated = seatCount > 0 || s.kind === "table" || s.kind === "seat";
    // a register/counter is purchasable only in a SHOP that has goods (a pub's bar-counter isn't a till).
    const purchasable = !!input.isShop && (s.kind === "register" || s.kind === "counter") && sells.length > 0;
    const convo = convoBySpot.get(s.id);
    return {
      id: s.id,
      label: s.label,
      kind: s.kind,
      station: !!s.station,
      occupants: here,
      seatCount,
      freeSeats,
      occupied: here.length > 0,
      empty: isSeated && here.length === 0,
      purchasable,
      sells: purchasable ? sells : [],
      conversationHere: !!convo,
      ...(convo?.topic ? { conversationTopic: convo.topic } : {}),
      conversationWith: convo ? Array.from(convo.others) : [],
    };
  });
}

// ---- the decision MENU + goal-aware suggestion ------------------------------------------------------------

export type InteriorMenu = {
  /** the human menu the ACT prompt shows: each spot with its occupancy/state (empty/occupied/who/purchasable). */
  menuLine: string;
  /** the single suggested spot id to go_inside given the agent's goal + what's there, or null if already placed
   *  somewhere sensible / nothing fits. */
  suggestion: string | null;
  /** a one-line rationale for the suggestion (e.g. "your work station", "join Klaus & Sam", "an empty table"),
   *  so the prompt can phrase the nudge. Empty when suggestion is null. */
  suggestionWhy: string;
  /** the enriched spots (so the caller can reuse them without re-enriching). */
  spots: EnrichedSpot[];
};

/**
 * Build the occupancy-aware interior MENU + a goal-aware suggestion. Implements the operator's exact decision
 * list: work your station (at your own workplace) · buy at the register (if you want something) · JOIN a table
 * where people are talking · or take an EMPTY table. Pure — phrasing only; the agent still CHOOSES (go_inside).
 *
 * Suggestion priority:
 *   1. at your OWN workplace → your work STATION (preserves the proven producer behaviour).
 *   2. you want to buy + there's a purchasable register/counter → that register.
 *   3. socialise: a table with people AND a live conversation → JOIN it (the richest scene).
 *   4. socialise: a table that's merely occupied (people, no detected convo) → join them.
 *   5. otherwise an EMPTY table/seat to sit (so a lone agent still takes a place, not the door).
 *   6. nothing seat-like → the first station/any spot (so it never stays at spawnInside).
 * If the agent is ALREADY at a sensible spot (selfSpot set and not the door), suggestion is null (don't nag).
 */
export function buildInteriorMenu(input: InteriorAwarenessInput): InteriorMenu {
  const spots = enrichSpots(input);
  const menuLine = spots.map(describeSpot).join("; ");

  // already placed at a real spot → no suggestion (let it act there).
  const alreadyPlaced = !!input.selfSpot;

  let suggestion: string | null = null;
  let suggestionWhy = "";
  if (!alreadyPlaced) {
    const stations = spots.filter((s) => s.station);
    const purchasable = spots.filter((s) => s.purchasable);
    const seated = spots.filter((s) => s.seatCount > 0 || s.kind === "table" || s.kind === "seat");
    const convoTables = seated.filter((s) => s.conversationHere && s.freeSeats > 0);
    const occupiedTables = seated.filter((s) => s.occupied && s.freeSeats > 0 && !s.conversationHere);
    const emptyTables = seated.filter((s) => s.empty);

    if (input.atOwnWorkplace && stations[0]) {
      suggestion = stations[0].id;
      suggestionWhy = "your work station";
    } else if (input.wantsToBuy && purchasable[0]) {
      suggestion = purchasable[0].id;
      suggestionWhy = `the ${purchasable[0].label} (you can buy ${purchasable[0].sells.join(", ")} here)`;
    } else if (convoTables[0]) {
      const t = convoTables[0];
      const who = t.conversationWith.length ? t.conversationWith.join(" & ") : t.occupants.join(" & ");
      suggestion = t.id;
      suggestionWhy = `join ${who} at the ${t.label}${t.conversationTopic ? ` (talking about ${t.conversationTopic})` : " — they're talking"}`;
    } else if (occupiedTables[0]) {
      const t = occupiedTables[0];
      suggestion = t.id;
      suggestionWhy = `sit with ${t.occupants.join(" & ")} at the ${t.label}`;
    } else if (emptyTables[0]) {
      suggestion = emptyTables[0].id;
      suggestionWhy = `an empty ${emptyTables[0].label} to sit`;
    } else if (stations[0]) {
      suggestion = stations[0].id;
      suggestionWhy = `the ${stations[0].label}`;
    } else if (spots[0]) {
      suggestion = spots[0].id;
      suggestionWhy = `the ${spots[0].label}`;
    }
  }

  return { menuLine, suggestion, suggestionWhy, spots };
}

// One spot rendered for the menu: "<id> (<label>): <state>". State distinguishes empty/occupied/who/purchasable/
// conversation so the agent can choose. Compact, NL, one clause.
function describeSpot(s: EnrichedSpot): string {
  const bits: string[] = [];
  if (s.station) bits.push("a work spot");
  if (s.purchasable) bits.push(`buy ${s.sells.join("/")} here`);
  if (s.conversationHere) {
    const who = s.conversationWith.length ? s.conversationWith.join(" & ") : s.occupants.join(" & ");
    bits.push(who ? `${who} talking here${s.conversationTopic ? ` about ${s.conversationTopic}` : ""}` : "a conversation here");
  } else if (s.occupied) {
    bits.push(`${s.occupants.join(" & ")} here`);
  } else if (s.empty) {
    bits.push("EMPTY");
  }
  return `${s.id} (${s.label}${bits.length ? ", " + bits.join(", ") : ""})`;
}

// ---- runnable self-test (ZERO tokens) -------------------------------------------------------------------
// `tsx cognition/interior-awareness.ts` checks enrichment (occupancy/empty/purchasable/conversation grouping)
// and every branch of the suggestion priority. Pure → deterministic, no sim, no model, no disk.
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`); };

  // A pub-like interior: a stage (station), a bar-counter (station+seats), two tables (3 seats each), a register.
  const subs: SublocationLike[] = [
    { id: "pub-stage", label: "the stage", kind: "stage", station: true },
    { id: "bar-counter", label: "the bar", kind: "counter", station: true, seats: [{ x: 1, y: 1 }, { x: 2, y: 1 }] },
    { id: "pub-table-1", label: "the corner table", kind: "table", seats: [{ x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 }] },
    { id: "pub-table-2", label: "the window table", kind: "table", seats: [{ x: 9, y: 6 }, { x: 10, y: 6 }, { x: 11, y: 6 }] },
    { id: "pub-register", label: "the till", kind: "register" },
  ];
  // Klaus & Sam sit at table-1 having a conversation; Maria works the stage; self (yusuf) is at the door (no spot).
  const occupants: OccupantLike[] = [
    { id: "klaus", sublocationId: "pub-table-1" },
    { id: "sam", sublocationId: "pub-table-1" },
    { id: "maria", sublocationId: "pub-stage" },
    { id: "yusuf" }, // self — at spawnInside/door (no sublocationId)
  ];
  const conversations: LiveConversation[] = [{ participants: ["klaus", "sam"], topic: "the bakery sale" }];

  // --- ENRICHMENT ---
  const spots = enrichSpots({ buildingId: "pub", selfId: "yusuf", sublocations: subs, occupants, conversations, isShop: false });
  const byId = new Map(spots.map((s) => [s.id, s]));
  const t1 = byId.get("pub-table-1")!;
  const t2 = byId.get("pub-table-2")!;
  assert(t1.occupied && !t1.empty && t1.occupants.length === 2, "table-1 is occupied by 2");
  assert(t1.freeSeats === 1, "table-1 has 1 free seat (3 - 2)");
  assert(t1.conversationHere && t1.conversationTopic === "the bakery sale", "table-1 has a live conversation w/ topic");
  assert(JSON.stringify(t1.conversationWith.sort()) === JSON.stringify(["klaus", "sam"]), "table-1 names both talkers as company");
  assert(t2.empty && !t2.occupied && t2.freeSeats === 3, "table-2 is EMPTY (the distinguishable empty table)");
  // a pub register is NOT purchasable (not a shop) — purchasable only in shops.
  assert(byId.get("pub-register")!.purchasable === false, "a register in a non-shop (pub) is NOT purchasable");

  // --- purchasable in a SHOP: the cafe register sells coffee ---
  const shopSpots = enrichSpots({
    buildingId: "cafe", selfId: "x",
    sublocations: [{ id: "cafe-register", label: "the register", kind: "register" }, { id: "cafe-counter", label: "the counter", kind: "counter", station: true }],
    occupants: [], isShop: true, goods: [{ id: "coffee", price: "$0.02" }],
  });
  assert(shopSpots.find((s) => s.id === "cafe-register")!.purchasable, "a register in a shop IS purchasable");
  assert(shopSpots.find((s) => s.id === "cafe-register")!.sells.includes("coffee"), "the register sells the shop's goods");

  // --- MENU + suggestion priority ---
  // (1) at own workplace → station.
  const m1 = buildInteriorMenu({ buildingId: "pub", selfId: "maria", sublocations: subs, occupants, conversations, atOwnWorkplace: true });
  assert(m1.suggestion === "pub-stage" && /work station/.test(m1.suggestionWhy), "own workplace → suggest the work station");

  // (3) socialise → JOIN the table where Klaus & Sam are talking (yusuf at the door, not own workplace, no buy).
  const m3 = buildInteriorMenu({ buildingId: "pub", selfId: "yusuf", sublocations: subs, occupants, conversations });
  assert(m3.suggestion === "pub-table-1", "socialise → JOIN the table with the live conversation");
  assert(/join/i.test(m3.suggestionWhy) && /klaus/i.test(m3.suggestionWhy) && /sam/i.test(m3.suggestionWhy), "the join nudge names Klaus & Sam");
  assert(/bakery sale/.test(m3.suggestionWhy), "the join nudge mentions the topic");
  // the menu text itself distinguishes the empty table from the busy one.
  assert(/pub-table-2 \(the window table, EMPTY\)/.test(m3.menuLine), `menu marks the empty table EMPTY (got: ${m3.menuLine})`);
  assert(/pub-table-1.*talking/.test(m3.menuLine), "menu marks the busy table as a conversation");

  // (2) wants to buy + purchasable register → the register (shop case).
  const m2 = buildInteriorMenu({
    buildingId: "cafe", selfId: "klaus",
    sublocations: [{ id: "cafe-register", label: "the register", kind: "register" }, { id: "cafe-counter", label: "the counter", kind: "counter", station: true }],
    occupants: [], isShop: true, goods: [{ id: "coffee", price: "$0.02" }], wantsToBuy: true,
  });
  assert(m2.suggestion === "cafe-register" && /buy/.test(m2.suggestionWhy), "wants-to-buy + shop register → suggest the register");

  // (5) lone agent, no company, no buy → an EMPTY table (not the door).
  const m5 = buildInteriorMenu({
    buildingId: "pub", selfId: "yusuf",
    sublocations: subs, occupants: [{ id: "yusuf" }], // only self inside, at the door
  });
  assert(m5.suggestion === "bar-counter" || (byId.get(m5.suggestion!)?.empty ?? false) || /empty/i.test(m5.suggestionWhy), "lone agent → a place to sit (empty), never the door");
  assert(m5.suggestion !== null, "a lone agent at the door ALWAYS gets a suggestion (never stays at spawnInside)");

  // already placed → no suggestion (don't nag someone who's already seated).
  const mPlaced = buildInteriorMenu({ buildingId: "pub", selfId: "klaus", selfSpot: "pub-table-1", sublocations: subs, occupants, conversations });
  assert(mPlaced.suggestion === null, "already at a spot → no suggestion");

  // self is excluded from its own spot's occupants (klaus at table-1 doesn't list himself).
  const selfExcl = enrichSpots({ buildingId: "pub", selfId: "klaus", sublocations: subs, occupants, conversations }).find((s) => s.id === "pub-table-1")!;
  assert(!selfExcl.occupants.includes("klaus") && selfExcl.occupants.includes("sam"), "self is excluded from its own spot's occupant list");

  console.log("interior-awareness.ts self-test: ALL ASSERTIONS PASSED (enrich occupancy/empty/purchasable/conversation · menu distinguishes empty vs busy · suggestion priority 1-6 · self-exclusion · already-placed)");
}
