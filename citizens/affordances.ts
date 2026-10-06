// PLACE AFFORDANCES: the agent's analogue of a person walking into a place and seeing what they could do
// there. When an agent stands somewhere, the AVAILABLE actions are what it
// perceives and chooses among — "order at the register [barista is serving]", "join Klaus at the window
// table", "reply to what Iris just said" — exactly like a person entering a shop. This module computes that
// menu, PURELY, from the same perception slice renderTick already holds.
//
// TWO CONTRACTS IN ONE STRUCTURE:
//   • D28 (the menu): every entry is an OPTION with a `how` (the exact tool calls) — the LLM chooses among
//     eligible entries; the commerce-choreography state machine remains the SEQUENCER for what happens after
//     a choice (its steps are these entries' `how` strings; nothing here re-derives sequencing).
//   • D32 (the tape): entries whose eligibility predicate FAILS are returned too, with the failed predicate
//     as `reason` ("seller-off-station" / "no-stock" / "no-funds" / "already-holding" / "say-answered" / …)
//     — so the affordance beat names every suppressor every tick, and a quiet day is never a mystery.
//
// PURE + zero-token: no I/O, no LLM. renderTick (lifegiver) calls affordancesFor() with values in scope,
// renders the eligible entries as the choice menu, and emits ONE `affordances` beat via the existing POST
// /event (helper: affordanceBeatPayload). Ignition's mechanical dialogue floor is unchanged — the menu is
// the agent's CONSCIOUS surface; SocialStep is its reflexes.

import { sceneFor, type OccupantView } from "./commerce-choreography.js";
import { SHOP_OWNER } from "../shops/registry.js";
import type { HeardSay } from "./ignition.js";

/** The SHARED VERB VOCABULARY (WORLD-ATLAS.md v0, flightrecorder sign-off): every menu entry maps onto 1-2
 *  of these atlas verbs, so the menu, the affordances beat, and the atlas per-spot tables speak ONE
 *  language. `consume` is our proposed v0 addition (the own→consume→rebuy loop needs it; "rest" isn't it). */
export type AtlasVerb =
  | "work" | "sell" | "order" | "buy" | "browse" | "sit" | "converse" | "study" | "busk" | "rest" | "consume";

export type Affordance =
  | { id: string; label: string; how: string; verbs: AtlasVerb[]; source: "commerce" | "social" | "place"; eligible: true }
  | { id: string; label: string; verbs: AtlasVerb[]; source: "commerce" | "social" | "place"; eligible: false; reason: string };

export type AffordanceView = {
  selfId: string;
  /** Goods I tend to want (persona.buys) + what I own. */
  buys: string[];
  owns: Record<string, number>;
  /** My USDC balance (null = unknown → funds predicate is skipped, the guard still vetoes downstream). */
  usdc: number | null;
  /** The guard's reserve floor (economy.config.json reserveUSDC; default 0.05) — funds predicate mirror. */
  reserveUsdc?: number;
  /** The shop I'm standing in, with goods. */
  currentShop?: { id: string; goods: Array<{ id: string; price?: string }> } | null;
  /** Interior occupancy (insideHere.occupants) + my spot. Empty until main's /perceive fix lands. */
  occupants: OccupantView[];
  /** SELLER-side stock of the shop's primary good, when known (clerk: own inventory count; buyer: optional
   *  — lifegiver MAY wire GET /inventory/<owner>; omitted ⇒ the stock predicate is skipped for buyers). */
  sellerStock?: number;
  /** My producer verb when I'm a clerk (bake/brew/…), for the restock how-line. */
  produceVerb?: string;
  /** Inbound says (heardRecently) + which say ids are already answered (PairSocialState.isAnswered). */
  heardRecently?: HeardSay[];
  isAnswered?: (sayId: string) => boolean;
  /** Who is beside me / approaching me on the street (nearbyEvents verb "approached" actors). */
  adjacentTo?: string[];
  approaching?: string[];
  /** Volition line from SocialStep.volitionTarget(), when present. */
  volition?: { targetId: string; topic: string; line: string } | null;
};

/** The full evaluated menu — eligible entries first (render order), suppressed entries after (tape). */
export function affordancesFor(v: AffordanceView): Affordance[] {
  const out: Affordance[] = [];
  const shopId = v.currentShop?.id;
  const scene = shopId ? sceneFor(shopId) : null;
  const iAmClerk = !!shopId && SHOP_OWNER[shopId] === v.selfId;
  const selfSpot = v.occupants.find((o) => o.id === v.selfId)?.sublocationId ?? null;

  // ── COMMERCE: buyer side ────────────────────────────────────────────────────────────────────────────────
  if (scene && v.currentShop && !iAmClerk) {
    const sold = v.currentShop.goods;
    const want = v.buys.map((b) => sold.find((g) => g.id === b)).find((g) => g && !(v.owns[g.id] > 0));
    const held = v.buys.find((b) => sold.some((g) => g.id === b) && v.owns[b] > 0);
    const clerkAtStation = v.occupants.some((o) => o.id === scene.ownerId && o.sublocationId === scene.registerSpotId);
    const occupancyKnown = v.occupants.length > 0;

    if (want) {
      // order-at-register — the D28 example, predicates in order: seller at station · stock · funds.
      const price = Number(String(want.price ?? "").replace(/[^0-9.]/g, "")) || 0.01;
      const reserve = v.reserveUsdc ?? 0.05;
      if (occupancyKnown && !clerkAtStation) {
        out.push({ id: "order-at-register", label: `order a ${want.id} at the ${scene.registerSpotId}`, verbs: ["order", "buy"], source: "commerce", eligible: false, reason: "seller-off-station" });
      } else if (v.sellerStock !== undefined && v.sellerStock <= 0) {
        out.push({ id: "order-at-register", label: `order a ${want.id} at the ${scene.registerSpotId}`, verbs: ["order", "buy"], source: "commerce", eligible: false, reason: "no-stock" });
      } else if (v.usdc !== null && v.usdc < price + reserve) {
        out.push({ id: "order-at-register", label: `order a ${want.id} at the ${scene.registerSpotId}`, verbs: ["order", "buy"], source: "commerce", eligible: false, reason: "no-funds" });
      } else {
        const stepUp = selfSpot === scene.registerSpotId ? "" : `go_inside({spot:"${scene.registerSpotId}"}), then `;
        out.push({
          id: "order-at-register",
          label: `order a ${want.id} at the ${scene.registerSpotId}${clerkAtStation ? ` (${scene.ownerId} is serving)` : ""}`,
          how: `${stepUp}talk({toId:"${scene.ownerId}", msg:"One ${want.id}, please!"}), then evaluate_purchase({item:"${want.id}", price_usdc:${price}, ...}) and (if mayBuy) buy({item:"${want.id}"})`,
          verbs: ["order", "buy"],
          source: "commerce",
          eligible: true,
        });
      }
    } else if (held) {
      out.push({ id: "order-at-register", label: `buy more ${held}`, verbs: ["order", "buy"], source: "commerce", eligible: false, reason: "already-holding" });
    }

    if (held) {
      const seated = !!selfSpot && scene.tableIds.includes(selfSpot);
      out.push(
        seated
          ? { id: "consume-here", label: `enjoy your ${held} at your table`, how: `consume({item:"${held}"})`, verbs: ["consume"], source: "commerce", eligible: true }
          : scene.tableIds.length
            ? { id: "consume-here", label: `sit down and enjoy your ${held}`, how: `go_inside({spot:"${scene.tableIds[0]}"}), then consume({item:"${held}"})`, verbs: ["sit", "consume"], source: "commerce", eligible: true }
            : { id: "consume-here", label: `enjoy your ${held}`, how: `consume({item:"${held}"})`, verbs: ["consume"], source: "commerce", eligible: true },
      );
    }
    out.push({ id: "browse-shelves", label: `browse what ${v.currentShop.id} sells`, how: `enterShop({id:"${shopId}"})`, verbs: ["browse"], source: "place", eligible: true });
  }

  // ── COMMERCE: clerk side ────────────────────────────────────────────────────────────────────────────────
  if (scene && iAmClerk) {
    if (selfSpot !== scene.registerSpotId) {
      out.push({ id: "man-your-station", label: `take your station at the ${scene.registerSpotId}`, how: `go_inside({spot:"${scene.registerSpotId}"})`, verbs: ["work"], source: "commerce", eligible: true });
    }
    const customer = v.occupants.find((o) => o.id !== v.selfId && o.sublocationId === scene.registerSpotId);
    if (customer) {
      out.push({ id: "serve-customer", label: `serve ${customer.id} at your counter`, how: `talk({toId:"${customer.id}", msg:"…"})${(v.sellerStock ?? 1) <= 0 && v.produceVerb ? ` and ${v.produceVerb}() so you have stock` : ""}`, verbs: ["sell"], source: "commerce", eligible: true });
    }
    if (v.produceVerb) {
      if ((v.sellerStock ?? 0) <= 0) {
        out.push({ id: "restock", label: `make stock${scene.prepSpotId ? ` at the ${scene.prepSpotId}` : ""}`, how: `${v.produceVerb}()`, verbs: ["work"], source: "commerce", eligible: true });
      } else {
        out.push({ id: "restock", label: "make more stock", verbs: ["work"], source: "commerce", eligible: false, reason: "shelf-stocked" });
      }
    }
  }

  // ── SOCIAL ─────────────────────────────────────────────────────────────────────────────────────────────
  const adjacent = new Set(v.adjacentTo ?? []);
  const heard = v.heardRecently ?? [];
  const last = [...heard].reverse().find((h) => h?.from && h.from !== v.selfId);
  if (last?.from) {
    const sayId = last.id ?? `${last.from}|${last.text ?? ""}`;
    if (v.isAnswered?.(sayId)) {
      out.push({ id: "reply-to-say", label: `reply to ${last.from}`, verbs: ["converse"], source: "social", eligible: false, reason: "say-answered" });
    } else if (!adjacent.has(last.from)) {
      out.push({ id: "reply-to-say", label: `reply to ${last.from} ("${clip(last.text, 60)}")`, verbs: ["converse"], source: "social", eligible: false, reason: "speaker-left" });
    } else {
      out.push({ id: "reply-to-say", label: `reply to ${last.from} — they just said "${clip(last.text, 80)}"`, how: `talk({toId:"${last.from}", msg:"…"})`, verbs: ["converse"], source: "social", eligible: true });
    }
  }
  for (const who of v.approaching ?? []) {
    out.push({ id: `greet-approaching:${who}`, label: `greet ${who}, who's coming your way`, how: `talk({toId:"${who}", msg:"…"}) once they're beside you`, verbs: ["converse"], source: "social", eligible: true });
  }
  // join an occupied table (the "sit with them" option — distinct from sitting alone)
  if (scene) {
    for (const t of scene.tableIds) {
      const sitters = v.occupants.filter((o) => o.id !== v.selfId && o.sublocationId === t).map((o) => o.id);
      if (sitters.length && selfSpot !== t) {
        out.push({ id: `join-table:${t}`, label: `join ${sitters.join(" & ")} at the ${t}`, how: `go_inside({spot:"${t}"})`, verbs: ["sit", "converse"], source: "social", eligible: true });
      }
    }
  }
  if (v.volition) {
    out.push({ id: "go-tell", label: `go tell ${v.volition.targetId} about ${v.volition.topic}`, how: v.volition.line, verbs: ["converse"], source: "social", eligible: true });
  }

  // eligible first (stable within group) — the natural render order; suppressed trail for the tape.
  return [...out.filter((a) => a.eligible), ...out.filter((a) => !a.eligible)];
}

/** Render the eligible entries as the prompt's choice menu ("" when none) — ONE line per option. */
export function renderAffordanceMenu(affs: Affordance[]): string {
  const eligible = affs.filter((a): a is Extract<Affordance, { eligible: true }> => a.eligible);
  if (!eligible.length) return "";
  return (
    `Here, right now, you could:\n` +
    eligible.map((a, i) => `  ${i + 1}. ${a.label} — ${a.how}`).join("\n")
  );
}

/** The D32 beat payload: eligible entries + suppressed entries WITH their reasons, both carrying their
 *  atlas verbs so the tape joins menu↔atlas without a lookup table. Emit as kind:"affordances". */
export function affordanceBeatPayload(affs: Affordance[]): {
  eligible: Array<{ id: string; verbs: AtlasVerb[] }>;
  suppressed: Array<{ id: string; verbs: AtlasVerb[]; reason: string }>;
} {
  return {
    eligible: affs.filter((a) => a.eligible).map((a) => ({ id: a.id, verbs: a.verbs })),
    suppressed: affs.filter((a): a is Extract<Affordance, { eligible: false }> => !a.eligible).map((a) => ({ id: a.id, verbs: a.verbs, reason: a.reason })),
  };
}

function clip(s: unknown, n: number): string {
  const t = String(s ?? "").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

// ---- runnable self-test (ZERO tokens) --------------------------------------------------------------------
// `tsx citizens/affordances.ts` proves the D28 menu + D32 suppression pairing across the cafe matrix:
// order-at-register flips between eligible and each named suppressor (seller-off-station / no-stock /
// no-funds / already-holding), join-table names the sitters, reply-to-say tracks adjacency + answered state,
// the clerk gets station/serve/restock, and the beat payload carries every suppressed reason.
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
  };
  const by = (affs: Affordance[], id: string) => affs.find((a) => a.id === id);

  const base: AffordanceView = {
    selfId: "student",
    buys: ["coffee"],
    owns: {},
    usdc: 1.0,
    currentShop: { id: "cafe", goods: [{ id: "coffee", price: "$0.02" }] },
    occupants: [{ id: "student" }, { id: "barista", sublocationId: "cafe-counter" }],
  };

  // eligible order with the clerk serving; the how spells the full sequence.
  let a = by(affordancesFor(base), "order-at-register");
  assert(a?.eligible === true && /barista is serving/.test(a.label), "order eligible when the seller is at station");
  assert(a?.eligible && /go_inside.*talk.*evaluate_purchase.*buy/.test(a.how), "the how carries the full choreography sequence");

  // seller off station → suppressed with the operator's exact predicate name.
  a = by(affordancesFor({ ...base, occupants: [{ id: "student" }, { id: "barista", sublocationId: "cafe-table-1" }] }), "order-at-register");
  assert(a?.eligible === false && a.reason === "seller-off-station", "seller-off-station named");

  // no stock (when seller stock is known) → suppressed.
  a = by(affordancesFor({ ...base, sellerStock: 0 }), "order-at-register");
  assert(a?.eligible === false && a.reason === "no-stock", "no-stock named");

  // no funds (price + reserve > balance) → suppressed.
  a = by(affordancesFor({ ...base, usdc: 0.05 }), "order-at-register");
  assert(a?.eligible === false && a.reason === "no-funds", "no-funds named (reserve floor mirrored)");
  // unknown balance → predicate skipped (guard still vetoes downstream).
  a = by(affordancesFor({ ...base, usdc: null }), "order-at-register");
  assert(a?.eligible === true, "unknown balance does not false-suppress (guard is authoritative)");

  // already holding → order suppressed, consume eligible.
  const holding = affordancesFor({ ...base, owns: { coffee: 1 } });
  assert(by(holding, "order-at-register")?.eligible === false && (by(holding, "order-at-register") as any).reason === "already-holding", "already-holding named");
  assert(by(holding, "consume-here")?.eligible === true, "consume affordance appears when holding");

  // join an occupied table — names the sitters.
  const joinView = affordancesFor({ ...base, occupants: [...base.occupants, { id: "klaus", sublocationId: "cafe-table-1" }] });
  const join = by(joinView, "join-table:cafe-table-1");
  assert(join?.eligible === true && /join klaus/.test(join.label), "join-table names who's sitting there");

  // reply-to-say: eligible when adjacent+unanswered; suppressed as speaker-left / say-answered.
  const say = { id: "s1", from: "courier", text: "Got a minute?" };
  let social = affordancesFor({ ...base, heardRecently: [say], adjacentTo: ["courier"] });
  assert(by(social, "reply-to-say")?.eligible === true, "reply eligible when the speaker is beside me");
  social = affordancesFor({ ...base, heardRecently: [say], adjacentTo: [] });
  assert((by(social, "reply-to-say") as any)?.reason === "speaker-left", "speaker-left named");
  social = affordancesFor({ ...base, heardRecently: [say], adjacentTo: ["courier"], isAnswered: (id) => id === "s1" });
  assert((by(social, "reply-to-say") as any)?.reason === "say-answered", "say-answered named");

  // street approach + volition entries.
  social = affordancesFor({ ...base, currentShop: null, occupants: [], approaching: ["musician"], volition: { targetId: "grocer", topic: "the pub quiz", line: "You want to tell grocer about the pub quiz — go find them." } });
  assert(by(social, "greet-approaching:musician")?.eligible === true, "greet-the-approacher affordance");
  assert(by(social, "go-tell")?.eligible === true, "volition affordance");

  // clerk menu: station → serve → restock, with shelf-stocked suppression.
  const clerkBase: AffordanceView = { selfId: "barista", buys: [], owns: {}, usdc: 2, currentShop: { id: "cafe", goods: [{ id: "coffee" }] }, occupants: [{ id: "barista" }], produceVerb: "brew", sellerStock: 0 };
  let clerk = affordancesFor(clerkBase);
  assert(by(clerk, "man-your-station")?.eligible === true, "clerk off-station → man-your-station");
  clerk = affordancesFor({ ...clerkBase, occupants: [{ id: "barista", sublocationId: "cafe-counter" }, { id: "student", sublocationId: "cafe-counter" }] });
  assert(by(clerk, "serve-customer")?.eligible === true && by(clerk, "restock")?.eligible === true, "clerk at station: serve + restock (empty shelf)");
  clerk = affordancesFor({ ...clerkBase, sellerStock: 5, occupants: [{ id: "barista", sublocationId: "cafe-counter" }] });
  assert((by(clerk, "restock") as any)?.reason === "shelf-stocked", "stocked shelf suppresses restock WITH reason");

  // menu renders eligible-only; beat payload carries every suppressor.
  const menuAffs = affordancesFor({ ...base, usdc: 0.05, heardRecently: [say], adjacentTo: [] });
  const menu = renderAffordanceMenu(menuAffs);
  assert(!/order a coffee/.test(menu), "suppressed entries stay OFF the menu");
  const beat = affordanceBeatPayload(menuAffs);
  assert(beat.suppressed.some((s) => s.id === "order-at-register" && s.reason === "no-funds"), "beat: no-funds suppression named");
  assert(beat.suppressed.some((s) => s.id === "reply-to-say" && s.reason === "speaker-left"), "beat: speaker-left suppression named");
  const fullMenu = renderAffordanceMenu(affordancesFor(base));
  assert(/you could:/i.test(fullMenu) && /1\./.test(fullMenu), "menu renders as a numbered choice list");

  // atlas-verb vocabulary (WORLD-ATLAS v0 sign-off): entries carry their verbs; the beat carries them too.
  assert(by(affordancesFor(base), "order-at-register")?.verbs.join(",") === "order,buy", "order-at-register maps to atlas verbs order+buy");
  assert(by(holding, "consume-here")?.verbs.includes("consume"), "consume-here carries the proposed consume verb");
  assert(by(joinView, "join-table:cafe-table-1")?.verbs.join(",") === "sit,converse", "join-table maps to sit+converse");
  assert(beat.suppressed.every((s) => Array.isArray(s.verbs) && s.verbs.length > 0), "beat payload carries atlas verbs on suppressed entries");

  console.log("affordances.ts self-test: ALL ASSERTIONS PASSED (D28 menu: order/consume/join/reply/greet/volition/clerk · D32 suppressors: seller-off-station/no-stock/no-funds/already-holding/speaker-left/say-answered/shelf-stocked · beat payload · render)");
}
