import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The economy ledger — append-only JSONL, zero deps. (appendJsonl/readJsonl +
// insertEvent dedup).
//
// WRITE path: only the sim-server calls appendEvent (the sim is the single writer of events.jsonl;
// citizens POST /event to the sim instead of writing here). READ helpers (readAll/recentDigest/
// sumToday/has) are safe to call from ANY process — append-only JSONL is lock-free to read.

const HERE = dirname(fileURLToPath(import.meta.url)); // economy/
const ROOT = dirname(HERE); // repo root
const DATA_DIR = join(ROOT, "sim", "data");
export const EVENTS_FILE = join(DATA_DIR, "events.jsonl");

// The canonical event-kind union (the sim imports this). "consume" added for the inventory need-cycle
// (a citizen uses up a held good → the need recurs → it re-buys); emitted sim-side on POST /act consume.
// S1-3 (carry-and-give): "give" = a NON-monetary gift of a held unit (custody moves, NO txHash/USDC —
// distinct from "purchase"/"sale" which settle on-chain); "pick_up"/"drop" move a unit between an agent and
// the ground at a place; "use" generalizes "consume" (use up a held good). Keeping gift-vs-sale as SEPARATE
// kinds is what keeps the on-chain economy honest (a gift never appears in money totals — see sumToday).
// S1-2 (producer verbs): "produce" = a role made one unit of its own stock (bake/brew/forge/restock/deliver) —
// also NON-monetary (made, not bought; no txHash), so it stays out of money totals too.
export type EventKind = "move" | "say" | "decision" | "purchase" | "sale" | "skip" | "consume" | "fund" | "give" | "pick_up" | "drop" | "use" | "produce";
export type LedgerEvent = {
  ts?: string;
  kind: EventKind;
  actor: string;
  related_id?: string; // tx hash for purchase/sale; "" otherwise
  payload: Record<string, unknown>;
};

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function readAll(): LedgerEvent[] {
  if (!existsSync(EVENTS_FILE)) return [];
  const raw = readFileSync(EVENTS_FILE, "utf8");
  if (!raw.trim()) return [];
  const out: LedgerEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as LedgerEvent);
    } catch {
      /* skip a malformed/partial line */
    }
  }
  return out;
}

// Append one event. Deduped on related_id+kind+actor (the idempotency primitive from db.mjs:insertEvent).
// Only the sim calls this.
export function appendEvent(evt: LedgerEvent): { inserted?: boolean; duplicate?: boolean } {
  if (!evt.kind) throw new Error("event.kind required");
  if (!evt.ts) evt.ts = new Date().toISOString();
  if (evt.related_id) {
    const existing = readAll();
    if (existing.some((e) => e.kind === evt.kind && e.related_id === evt.related_id && e.actor === evt.actor)) {
      return { duplicate: true };
    }
  }
  ensureDir();
  appendFileSync(EVENTS_FILE, JSON.stringify(evt) + "\n", "utf8");
  return { inserted: true };
}

// Idempotency check for the GUARD: has this citizen already acted on this key this turn?
export function has(idempotencyKey: string): boolean {
  return readAll().some((e) => e.payload?.["idempotency_key"] === idempotencyKey);
}

// Total USDC this citizen has spent on purchases TODAY (for the daily cap).
export function sumToday(actor: string): number {
  const day = new Date().toISOString().slice(0, 10);
  return readAll()
    .filter((e) => e.kind === "purchase" && e.actor === actor && (e.ts ?? "").startsWith(day))
    .reduce((s, e) => s + Number(e.payload?.["price_usdc"] ?? 0), 0);
}

// A short memory digest for the tick prompt: the last `n` events that involve this citizen —
// things it did, bought, or that a neighbor SAID to it (payload.to === actor) or traded with it
// (payload.counterparty === actor). This is how an inbound `say` reaches the listener on its next tick.
export function recentDigest(actor: string, n = 12): string {
  const mine = readAll().filter(
    (e) =>
      e.actor === actor ||
      e.payload?.["to"] === actor ||
      e.payload?.["counterparty"] === actor,
  );
  if (mine.length === 0) return "(nothing yet)";
  return mine
    .slice(-n)
    .map((e) => {
      const who = e.actor === actor ? "you" : e.actor;
      return `- ${who} ${e.kind}: ${JSON.stringify(e.payload).slice(0, 120)}`;
    })
    .join("\n");
}
