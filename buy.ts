import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { loadCitizens } from "./lib.js";
import { GOOD_TO_SHOP } from "./shops/registry.js";

// The x402 buy primitive (proven in Phase 0 + the treasury fan-out): 402 → sign EIP-3009 → retry → 200,
// settlement receipt in the PAYMENT-RESPONSE header. Gasless (the facilitator sponsors gas).
export type Receipt = { status: number; txHash: string; receipt: unknown };

const SIM = process.env.SIM_URL ?? "http://localhost:4042";

// ---- D32 ECONOMY-CHAIN BEATS (flightrecorder schema): every stage of a buy is a tape beat, failures loud.
// Kinds: buy-attempt → buy-402 {amount?} → buy-settled {txHash} | buy-failed {reason}. Emitted from HERE
// (the one place every fleet buy passes through) as plain fire-and-forget POST /event — the tape auto-
// locates + tid-stamps them. wrapFetchWithPayment hides the wire-level 402 round-trip, so the 402 stage is
// reconstructed from its footprint: a PAYMENT-RESPONSE header on the final response proves a challenge was
// served and paid (DECIDED: attempt/402/settled/failed granularity, not wire-level). Injectable for tests.
export type BeatEmit = (kind: string, payload: Record<string, unknown>) => void;
function defaultEmit(actor: string): BeatEmit {
  return (kind, payload) => {
    // fire-and-forget: a beat must never slow or fail a settlement.
    fetch(`${SIM}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor, kind, payload }),
    }).catch(() => {});
  };
}

/** Classify a thrown buy error into the schema's loud reasons. Exported for the self-test. */
export function classifyBuyFailure(e: unknown): "seller-absent" | "no-funds" | "timeout" | "error" {
  const msg = String((e as Error)?.message ?? e ?? "").toLowerCase();
  if (/econnrefused|fetch failed|enotfound|socket|network/.test(msg)) return "seller-absent";
  if (/insufficient|exceeds balance|transfer amount|not enough/.test(msg)) return "no-funds";
  if (/abort|timeout|timed out/.test(msg)) return "timeout";
  return "error";
}

async function pay(privateKey: `0x${string}`, url: string): Promise<Receipt> {
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
  const fetchPay = wrapFetchWithPayment(fetch, client);
  const res = await fetchPay(url);
  const hdr = res.headers.get("PAYMENT-RESPONSE");
  let receipt: unknown = null;
  let txHash = "";
  if (hdr) {
    receipt = decodePaymentResponseHeader(hdr);
    const r = receipt as Record<string, unknown>;
    txHash = String(r?.["txHash"] ?? r?.["transaction"] ?? r?.["transactionHash"] ?? "");
  }
  return { status: res.status, txHash, receipt };
}

/** Phase 3: a citizen buys a good from a shop, paying from its OWN funded wallet (citizens.local.json).
 *  `opts` (additive, optional — existing callers unchanged): tick/price thread into the D32 beats;
 *  `emitBeat` injects a sink for zero-token tests. */
export async function payForItem(
  citizenId: string,
  shopUrlStr: string,
  goodId: string,
  opts?: { tick?: number; priceUsdc?: number; emitBeat?: BeatEmit },
): Promise<Receipt> {
  const c = loadCitizens().find((x) => x.id === citizenId);
  if (!c) throw new Error(`unknown citizen ${citizenId}`);
  const emit = opts?.emitBeat ?? defaultEmit(citizenId);
  const shop = GOOD_TO_SHOP[goodId] ?? shopUrlStr;
  const tickBit = opts?.tick !== undefined ? { tick: opts.tick } : {};
  emit("buy-attempt", { item: goodId, shop, ...tickBit });
  try {
    const r = await pay(c.privateKey, `${shopUrlStr}/shop/buy/${goodId}`);
    if (r.receipt != null || r.txHash) {
      // a PAYMENT-RESPONSE header ⇒ the 402 challenge was served and paid.
      emit("buy-402", { item: goodId, shop, ...(opts?.priceUsdc !== undefined ? { amount: opts.priceUsdc } : {}), ...tickBit });
    }
    if (r.status < 300 && r.txHash) {
      emit("buy-settled", { item: goodId, shop, txHash: r.txHash, ...tickBit });
    } else if (r.status === 402) {
      emit("buy-failed", { item: goodId, shop, reason: "402-rejected", status: r.status, ...tickBit });
    } else if (r.status >= 300) {
      emit("buy-failed", { item: goodId, shop, reason: `http-${r.status}`, status: r.status, ...tickBit });
    } else {
      // 2xx but no settlement receipt — an unpaywalled route or a facilitator quirk; loud, not silent.
      emit("buy-failed", { item: goodId, shop, reason: "no-settlement-receipt", status: r.status, ...tickBit });
    }
    return r;
  } catch (e) {
    emit("buy-failed", { item: goodId, shop, reason: classifyBuyFailure(e), detail: String((e as Error)?.message ?? "").slice(0, 160), ...tickBit });
    throw e;
  }
}

// Phase 0 (citizen0.ts): buy using BUYER_PRIVATE_KEY + SHOP_URL from env.
export async function payForItemEnv(goodId: string): Promise<Receipt> {
  const base = process.env.SHOP_URL ?? "http://localhost:4031";
  return pay(process.env.BUYER_PRIVATE_KEY as `0x${string}`, `${base}/shop/buy/${goodId}`);
}

// ---- runnable self-test (ZERO tokens, ZERO settlements) --------------------------------------------------
// `tsx buy.ts` exercises ONLY the beat plumbing + failure classification — no chain writes: a buy against a
// dead port must emit buy-attempt then buy-failed{seller-absent} and rethrow; the classifier maps the loud
// reasons. (The settle path needs a live shop + funded wallet — that's the lead's gated run, where
// buy-402/buy-settled land on the tape alongside the existing `purchase` event.)
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const assert = (cond: unknown, msg: string) => {
      if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
    };
    const beats: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    let threw = false;
    try {
      await payForItem("baker", "http://localhost:59999", "bread", { tick: 3, emitBeat: (kind, payload) => void beats.push({ kind, payload }) });
    } catch {
      threw = true;
    }
    assert(threw, "a dead seller port still throws to the caller (behavior unchanged)");
    assert(beats.length === 2 && beats[0].kind === "buy-attempt" && beats[1].kind === "buy-failed", `chain: attempt → failed (got ${beats.map((b) => b.kind).join("→")})`);
    assert(beats[0].payload.item === "bread" && beats[0].payload.shop === "bakery" && beats[0].payload.tick === 3, "attempt beat: item + shop resolved + tick threaded");
    assert(beats[1].payload.reason === "seller-absent", `dead port classifies as seller-absent (got ${beats[1].payload.reason})`);

    assert(classifyBuyFailure(new Error("fetch failed: ECONNREFUSED")) === "seller-absent", "classify: ECONNREFUSED");
    assert(classifyBuyFailure(new Error("transfer amount exceeds balance")) === "no-funds", "classify: no-funds");
    assert(classifyBuyFailure(new Error("The operation was aborted due to timeout")) === "timeout", "classify: timeout");
    assert(classifyBuyFailure(new Error("something odd")) === "error", "classify: fallback");

    console.log("buy.ts self-test: ALL ASSERTIONS PASSED (buy-attempt→buy-failed chain on dead port · seller-absent/no-funds/timeout classification · rethrow preserved)");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
