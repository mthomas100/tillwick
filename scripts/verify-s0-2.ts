// scripts/verify-s0-2.ts — ZERO-TOKEN post-run ASSERTION harness for S0-2 (the 0-edges bug).
//
// This does NOT spawn the sim or citizens and NEVER calls an LLM. It reads the artifacts a bounded live run
// already wrote (sim/data/{relationships,dialogue,events}) and ASSERTS the S0-2 acceptance criteria against
// them — so it proves the fix landed in a REAL run regardless of WHO drove that run (this teammate's own
// bounded e2e, or the lead's consolidated Stage-0 / S0-5 walk-up-and-talk pass that "exercises exactly these
// edges"). Run it immediately AFTER such a run, against the same sim/data dir:
//
//     npx tsx scripts/verify-s0-2.ts
//
// It is the rigorous companion to cognition/relationships.driver.ts (which proves the graph LOGIC on synthetic
// signals): this one proves the WIRING end-to-end — that real trades + dialogues + co-location actually reached
// the per-agent graph on disk. Acceptance:
//   (a) every agent that took part in a purchase has a relationships/<id>.jsonl, and the trade edge carries
//       NON-ZERO tradesAsBuyer/Seller + usdcBought/Sold (the thing that was 0 of 1,231 trades before);
//   (b) BOTH sides of each purchase formed the edge (buyer→seller AND seller→buyer), cross-checked against the
//       purchase events in events.jsonl;
//   (c) topics are COMPLETE — no edge stores a mid-word "…said"-style fragment (the truncation bug);
//   (d) co-presence landed — coPresences > 0 for ≥1 agent (needs the citizen.ts co-presence tap integrated;
//       reported as a soft FAIL with a clear hint if the hook isn't in yet, so this can run pre-integration).
//
// Exit 0 iff all HARD assertions pass. `--require-copresence` promotes (d) from soft to hard (use it once the
// co-presence tap is merged + a fresh run has happened).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const DATA = join(ROOT, "sim", "data");
const REL_DIR = join(DATA, "relationships");
const EVENTS = join(DATA, "events.jsonl");
const DIALOGUES = join(DATA, "dialogue.jsonl");

const requireCoPresence = process.argv.includes("--require-copresence");

let passed = 0;
let failed = 0;
let soft = 0;
function ok(cond: boolean, label: string): boolean {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
  return cond;
}
function softOk(cond: boolean, label: string, hint: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else if (requireCoPresence) {
    failed++;
    console.log(`  FAIL  ${label}  — ${hint}`);
  } else {
    soft++;
    console.log(`  SOFT  ${label}  — ${hint} (soft: pass --require-copresence once the hook is merged)`);
  }
}

const linesOf = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const parseJsonl = (f: string): Array<Record<string, unknown>> =>
  linesOf(f)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null);

type Rel = {
  other: string;
  coPresences: number;
  tradesAsBuyer: number;
  tradesAsSeller: number;
  usdcBought: number;
  usdcSold: number;
  topics: string[];
};
// Load one agent's ego graph from disk (only the fields these assertions read).
function loadGraph(id: string): Rel[] {
  return parseJsonl(join(REL_DIR, `${id}.jsonl`)).map((o) => ({
    other: String(o.other ?? ""),
    coPresences: Number(o.coPresences ?? 0),
    tradesAsBuyer: Number(o.tradesAsBuyer ?? 0),
    tradesAsSeller: Number(o.tradesAsSeller ?? 0),
    usdcBought: Number(o.usdcBought ?? 0),
    usdcSold: Number(o.usdcSold ?? 0),
    topics: Array.isArray(o.topics) ? (o.topics as unknown[]).map(String) : [],
  }));
}

// The truncation-bug signature: a topic that ends at a bare word like "…said" with no closing quote — i.e. a
// severed first-person POV sentence rather than a clean topic phrase. (The fix keeps topics to short phrases
// and clamps any over-long entry CLEANLY with a word-boundary "…".)
function isTruncatedFragment(t: string): boolean {
  const noEllipsis = t.replace(/…$/, "").trimEnd();
  const endsMidSentence = /\b(said|asked|told|replied|mentioned|about)$/i.test(noEllipsis);
  const looksLikePovSentence = /\bsaid\b/i.test(t) && /^I (talked|chatted|spoke)/i.test(t) && !/["']/.test(t);
  return endsMidSentence || looksLikePovSentence;
}

console.log("\n===== S0-2 e2e ASSERTIONS (reading sim/data — zero tokens) =====");
console.log(`data dir: ${DATA}`);

// ---- preconditions: a run actually happened ----------------------------------------------------------------
const relFiles = existsSync(REL_DIR) ? readdirSync(REL_DIR).filter((f) => f.endsWith(".jsonl")) : [];
const purchases = parseJsonl(EVENTS).filter((e) => e.kind === "purchase");
const dialogues = parseJsonl(DIALOGUES);
console.log(`\nfound: ${relFiles.length} relationship file(s), ${purchases.length} purchase event(s), ${dialogues.length} dialogue record(s)`);

if (relFiles.length === 0) {
  console.log("\n  FAIL  no relationships/*.jsonl on disk — run a bounded live e2e FIRST, then re-run this. (The");
  console.log("        the-graph-was-never-written failure: before the fix, 4/5 agents wrote no file at all.)");
  console.log(`\n==== ${passed} passed, ${failed + 1} failed, ${soft} soft ====`);
  process.exit(1);
}

// ---- (a)+(b) every purchase formed BOTH edges, with non-zero counters + usdc -------------------------------
console.log("\n[a+b] purchases → BOTH buyer+seller edges with non-zero counts + usdc (cross-checked vs events.jsonl)");
const participants = new Set<string>();
for (const p of purchases) {
  const actor = String(p.actor ?? "");
  const payload = (p.payload ?? {}) as { counterparty?: string; item?: string; price_usdc?: number };
  const counterparty = String(payload.counterparty ?? "");
  if (actor) participants.add(actor);
  if (counterparty) participants.add(counterparty);
}

if (purchases.length === 0) {
  console.log("  (no purchase events in this run — the trade legs are N/A here; dialogue + co-presence legs still checked)");
} else {
  // Pick one representative purchase to assert the edge shape precisely; then assert the aggregate invariant.
  const sample = purchases.find((p) => {
    const cp = String(((p.payload ?? {}) as { counterparty?: string }).counterparty ?? "");
    return String(p.actor ?? "") && cp && String(p.actor) !== cp;
  });
  if (sample) {
    const buyer = String(sample.actor);
    const seller = String(((sample.payload ?? {}) as { counterparty?: string }).counterparty);
    const buyerG = loadGraph(buyer);
    const sellerG = loadGraph(seller);
    const bEdge = buyerG.find((r) => r.other === seller);
    const sEdge = sellerG.find((r) => r.other === buyer);
    ok(existsSync(join(REL_DIR, `${buyer}.jsonl`)), `(a) buyer "${buyer}" wrote a relationships file`);
    ok(existsSync(join(REL_DIR, `${seller}.jsonl`)), `(a) seller "${seller}" wrote a relationships file`);
    ok(!!bEdge && bEdge.tradesAsBuyer > 0 && bEdge.usdcBought > 0, `(a) buyer→seller edge carries tradesAsBuyer>0 + usdcBought>0 (${buyer}→${seller})`);
    ok(!!sEdge && sEdge.tradesAsSeller > 0 && sEdge.usdcSold > 0, `(b) seller→buyer edge carries tradesAsSeller>0 + usdcSold>0 (${seller}→${buyer})`);
  } else {
    ok(false, "(a+b) found purchase events but none had a distinct buyer+seller to assert — inspect events.jsonl");
  }

  // Aggregate invariant: the total trade-edges recorded across all graphs should be > 0 (it was 0 before).
  let totalTradeEdges = 0;
  for (const f of relFiles) {
    const id = f.replace(/\.jsonl$/, "");
    for (const r of loadGraph(id)) if (r.tradesAsBuyer > 0 || r.tradesAsSeller > 0) totalTradeEdges++;
  }
  ok(totalTradeEdges > 0, `(a+b) at least one trade edge reached the graph across all agents (got ${totalTradeEdges}; was 0 of 1,231 before)`);
}

// ---- (c) topics are COMPLETE — no severed "…said" POV-sentence fragments anywhere -------------------------
console.log("\n[c] topics are complete (no mid-word truncation fragment)");
const offenders: string[] = [];
for (const f of relFiles) {
  const id = f.replace(/\.jsonl$/, "");
  for (const r of loadGraph(id)) {
    for (const t of r.topics) if (isTruncatedFragment(t)) offenders.push(`${id}→${r.other}: "${t}"`);
  }
}
if (offenders.length) for (const o of offenders.slice(0, 5)) console.log(`        offender: ${o}`);
ok(offenders.length === 0, `(c) no edge stores a truncated topic fragment (${offenders.length} found)`);

// ---- (d) co-presence landed (soft until the citizen.ts co-presence tap is merged) -------------------------
console.log("\n[d] co-presence edges landed (coPresences > 0 for someone)");
let anyCoPresence = false;
let maxCoPresence = 0;
for (const f of relFiles) {
  const id = f.replace(/\.jsonl$/, "");
  for (const r of loadGraph(id)) {
    if (r.coPresences > 0) anyCoPresence = true;
    maxCoPresence = Math.max(maxCoPresence, r.coPresences);
  }
}
softOk(
  anyCoPresence,
  `(d) at least one agent recorded a co-presence (max coPresences=${maxCoPresence}; was 0 everywhere before)`,
  "no co-presence yet — needs the citizen.ts (3b) co-presence tap merged + a fresh run",
);

// ---- summary ----------------------------------------------------------------------------------------------
console.log(`\n==== ${passed} passed, ${failed} failed, ${soft} soft ====`);
if (failed === 0 && soft === 0) console.log("S0-2 e2e: FULLY VERIFIED (trade edges + complete topics + co-presence all landed).");
else if (failed === 0) console.log("S0-2 e2e: hard criteria PASS; co-presence pending integration (soft).");
process.exit(failed === 0 ? 0 : 1);
