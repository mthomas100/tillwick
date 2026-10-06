// The economy's CUSTODY store — who owns which item, and the on-chain tx that moved it to them.
// In-memory + dependency-free (the sim is one process; the events.jsonl ledger is the durable record,
// so a restart re-derives nothing here — custody is live-session state that mirrors the buy stream).
//
// Provenance model: every owned unit is one `Holding` carrying the `txHash` that transferred custody
// into the current owner and `from` = who it came from (a shop owner on a buy, a peer on a resale).
// A `transfer` is the ONLY way custody moves, and it is always tied to a real settlement txHash —
// the sim calls it from POST /act buyResult once the x402 payment has settled on Base Sepolia.
//
// SINGLE-WRITER discipline (mirrors ledger.ts): only the sim mutates this store. Read helpers
// (get/counts) are pure and safe to call from any request handler.

// One owned unit of a good. The optional fields are provenance/economics the inspector also renders;
// `item` + `txHash` + `from` are the load-bearing custody triple.
export type Holding = {
  item: string; // good id, e.g. "bread"
  txHash?: string; // the settlement tx that transferred custody to the current owner (provenance)
  from: string; // who custody came from: the shop owner on a buy, or a peer on a resale
  ts: string; // ISO timestamp custody moved
  price_usdc?: number; // what was paid for this unit (for the inspector's spent/earned, optional)
  shop?: string; // origin shop id if bought from a shop (inspector renders "from <shop>")
  counterparty?: string; // alias of `from` kept for the inspector's existing field name
  explorer?: string; // convenience BaseScan link, derived from txHash if absent
};

export type TransferInput = {
  to: string; // new owner (the buyer)
  from: string; // previous owner / seller (shop owner, or a peer)
  item: string; // good id moving custody
  txHash?: string; // the real settlement hash that paid for this transfer
  ts?: string; // defaults to now
  price_usdc?: number; // optional economics passthrough
  shop?: string; // optional origin shop id passthrough
};

const BASESCAN_TX = "https://sepolia.basescan.org/tx/";

// ownerId -> ordered list of the units they currently hold (newest last, matching purchase order).
const holdings = new Map<string, Holding[]>();

function bucket(ownerId: string): Holding[] {
  let b = holdings.get(ownerId);
  if (!b) {
    b = [];
    holdings.set(ownerId, b);
  }
  return b;
}

// Move ONE unit of `item` from `from` to `to`, stamped with the txHash that paid for it.
// Returns the created Holding (the unit now in `to`'s custody).
//
// Custody is conserved: if `from` actually held a matching unit, that exact unit is removed (FIFO by
// item) so the same physical good doesn't exist in two places. If `from` is a pure producer that has
// no recorded stock (a shop owner who bakes bread on demand, see SHOPS-AS-PRODUCERS below), there is
// nothing to remove and we simply mint the unit into `to` — net town inventory grows by one, which is
// the intended behaviour for goods that originate at a shop.
export function transfer(input: TransferInput): Holding {
  const { to, from, item } = input;
  if (!to || !from || !item) throw new Error("transfer requires {to, from, item}");
  const ts = input.ts ?? new Date().toISOString();

  // Take the unit out of the seller's custody if they actually held one of this item (FIFO).
  const sellerBucket = holdings.get(from);
  if (sellerBucket) {
    const idx = sellerBucket.findIndex((h) => h.item === item);
    if (idx !== -1) sellerBucket.splice(idx, 1);
  }

  const holding: Holding = {
    item,
    txHash: input.txHash,
    from,
    ts,
    price_usdc: input.price_usdc,
    shop: input.shop,
    counterparty: from, // inspector reads `it.shop || it.counterparty`; keep both pointing at the seller
    explorer: input.txHash ? BASESCAN_TX + input.txHash : undefined,
  };
  bucket(to).push(holding);
  return holding;
}

// Everything `ownerId` currently holds, in acquisition order (newest last). Returns a defensive copy
// so callers (HTTP handlers serialising to JSON) can't mutate the store. Empty array if nothing held.
export function get(ownerId: string): Holding[] {
  return (holdings.get(ownerId) ?? []).map((h) => ({ ...h }));
}

// Per-item unit counts for `ownerId`, e.g. { bread: 2, coffee: 1 }. Items with zero are omitted.
export function counts(ownerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of holdings.get(ownerId) ?? []) out[h.item] = (out[h.item] ?? 0) + 1;
  return out;
}

// Remove ONE unit of `item` from `ownerId` (a citizen "consuming" a good so they genuinely need to
// rebuy, or the seller side of a peer resale once payment settles). Returns the removed Holding, or
// null if they held none. FIFO so the oldest unit is consumed first.
export function consume(ownerId: string, item: string): Holding | null {
  const b = holdings.get(ownerId);
  if (!b) return null;
  const idx = b.findIndex((h) => h.item === item);
  if (idx === -1) return null;
  return b.splice(idx, 1)[0];
}

// ─── S1-3: carry-and-give (the party verbs) ─────────────────────────────────────────────────────────
// A GIFT moves REAL custody but is NOT a paid x402 settlement — no txHash, no USDC. This is the explicit
// distinction the on-chain economy needs to stay honest: a `buy` mints/transfers on a settlement hash
// (`transfer` above, txHash-stamped); a `gift` only moves a unit the giver ALREADY HOLDS, with no money.
//
// Custody is conserved and NON-minting: unlike `transfer` (which mints when a producer-shop has no stock),
// `gift` FAILS (returns null) if `from` doesn't actually hold a unit of `item` — you cannot give what you
// don't have. The moved unit keeps its provenance but records the gift hop: `from` = the giver, the txHash
// is CLEARED (this hop wasn't paid for), and `price_usdc` is dropped (a gift has no price).
export function gift(from: string, to: string, item: string, ts = new Date().toISOString()): Holding | null {
  if (!from || !to || !item) throw new Error("gift requires {from, to, item}");
  if (from === to) return null; // giving to yourself is a no-op, not a custody move
  const removed = consume(from, item); // NON-minting: only succeeds if the giver truly held a unit (FIFO)
  if (!removed) return null; // giver holds none → no gift happens (caller surfaces "you don't have X")
  const holding: Holding = {
    item,
    txHash: undefined, // a gift is NOT a paid settlement — no on-chain hash
    from, // custody came from the giver (a peer), as a gift
    ts,
    price_usdc: undefined, // a gift has no price
    counterparty: from, // inspector reads `it.shop || it.counterparty`
    explorer: undefined,
  };
  bucket(to).push(holding);
  return holding;
}

// ─── S1-2: producer verbs (a role makes its own stock) ──────────────────────────────────────────────
// A PRODUCER makes one unit of their own good (baker bakes bread, smith forges a nail). The honest "I made
// it myself" custody primitive — distinct from `transfer` (a PAID mint on a settlement txHash) and `gift`
// (a peer hand-off). A produced unit has NO txHash (nothing was bought) and `from` = the maker, so provenance
// reads "made by <maker>" and it never enters money totals (it is not a purchase/sale). Mints into the maker's
// OWN custody — the supply side of the demand loop (composes with the deferred S3-3 finite stock + producer tick).
export function produce(owner: string, good: string, ts = new Date().toISOString()): Holding {
  if (!owner || !good) throw new Error("produce requires {owner, good}");
  const holding: Holding = {
    item: good,
    txHash: undefined, // made, not bought — no on-chain hash
    from: owner, // provenance: the maker produced it
    ts,
    price_usdc: undefined, // producing has no price
    counterparty: owner,
    explorer: undefined,
  };
  bucket(owner).push(holding);
  return holding;
}

// A minimal "objects on the ground at a place" model so an agent can DROP a held unit at a place and
// PICK_UP a unit that's lying there (e.g. set a cake down on a table, pick up a balloon left in the park).
// Keyed by placeId (a building/tile id the sim supplies). Lock-free in-process state, like `holdings`.
const ground = new Map<string, Holding[]>();
function groundBucket(placeId: string): Holding[] {
  let b = ground.get(placeId);
  if (!b) { b = []; ground.set(placeId, b); }
  return b;
}

// DROP one held unit of `item` from `ownerId` onto the ground at `placeId`. Returns the dropped Holding,
// or null if the owner held none. Custody leaves the agent but the unit persists at the place (not destroyed).
export function drop(ownerId: string, placeId: string, item: string, ts = new Date().toISOString()): Holding | null {
  if (!ownerId || !placeId || !item) throw new Error("drop requires {ownerId, placeId, item}");
  const removed = consume(ownerId, item); // NON-minting: must actually hold it
  if (!removed) return null;
  const onGround: Holding = { ...removed, from: ownerId, ts }; // provenance: it was last held by the dropper
  groundBucket(placeId).push(onGround);
  return onGround;
}

// PICK_UP one unit of `item` lying at `placeId` into `ownerId`'s custody. Returns the picked Holding, or
// null if no such unit is on the ground there. FIFO (oldest-dropped first).
export function pickUp(ownerId: string, placeId: string, item: string, ts = new Date().toISOString()): Holding | null {
  if (!ownerId || !placeId || !item) throw new Error("pickUp requires {ownerId, placeId, item}");
  const b = ground.get(placeId);
  if (!b) return null;
  const idx = b.findIndex((h) => h.item === item);
  if (idx === -1) return null;
  const [picked] = b.splice(idx, 1);
  const held: Holding = { ...picked, from: picked.from || placeId, ts };
  bucket(ownerId).push(held);
  return held;
}

// What's lying on the ground at `placeId` (defensive copy). Per-item counts, like `counts` for agents.
export function groundCounts(placeId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of ground.get(placeId) ?? []) out[h.item] = (out[h.item] ?? 0) + 1;
  return out;
}

// Test-only reset so unit tests start from a clean store. Not used by the sim.
export function _reset(): void {
  holdings.clear();
  ground.clear();
}
