import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelationshipGraph, parseSentiment, tier, clipWords, type InteractionSignal } from "./relationships.js";
import { stubComplete } from "./llm.js";

// ZERO-TOKEN validation driver for cognition/relationships.ts (W2-relations). Synthetic interactions only;
// the LLM seam is stubComplete → no model call, no SDK, no fleet. Run: `npx tsx cognition/relationships.driver.ts`.
//
// Asserts: the graph FORMS from interactions; familiarity GROWS with repeated contact; trade/dialogue/co-
// presence are weighted as designed; the NL query + reflection digest read sensibly; topRelations biases by
// kind; persistence ROUND-TRIPS (write → reload → identical graph); the optional sentiment read parses; and
// edge cases (self-trade, non-party signal) are no-ops.

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "rel-driver-"));
let clock = 100; // game-minutes; advance it as the "day" goes on
const now = () => clock;

try {
  // ---- 1. graph forms from a mix of signals; familiarity grows with repeated contact -------------------
  console.log("\n[1] graph forms + familiarity accumulates");
  const ego = "baker";
  let g = new RelationshipGraph(ego, { dir, nowGameMin: now });
  ok(g.size() === 0, "starts empty");

  // baker meets barista once (a quick hello), then has a longer chat, then trades repeatedly.
  const ix: InteractionSignal[] = [
    { kind: "copresence", participants: ["baker", "barista"], atGameMin: 100 },
    { kind: "dialogue", participants: ["baker", "barista"], turns: 2, atGameMin: 110, summary: "chatted about the festival" },
    { kind: "dialogue", participants: ["barista", "baker"], turns: 6, topics: ["festival", "bread orders"], atGameMin: 130 },
  ];
  for (const s of ix) g.updateFromInteraction(s);
  ok(g.size() === 1, "one peer after meeting barista");
  const fam1 = g.relationWith("barista")!.familiarity;
  ok(fam1 > 0, `familiarity is positive (${fam1.toFixed(2)})`);

  // a fresh, single co-presence with a different peer should be much weaker than the accumulated barista tie
  g.updateFromInteraction({ kind: "copresence", participants: ["baker", "grocer"], atGameMin: 140 });
  const famGrocer = g.relationWith("grocer")!.familiarity;
  ok(famGrocer < fam1, `barista (repeated) > grocer (single co-presence): ${fam1.toFixed(2)} > ${famGrocer.toFixed(2)}`);

  // more contact with barista must STRICTLY increase familiarity (monotonic accumulator)
  const before = g.relationWith("barista")!.familiarity;
  g.updateFromInteraction({ kind: "dialogue", participants: ["baker", "barista"], turns: 3, atGameMin: 150 });
  const after = g.relationWith("barista")!.familiarity;
  ok(after > before, `familiarity grows with repeated contact: ${before.toFixed(2)} -> ${after.toFixed(2)}`);

  // dialogue depth matters: a 6-turn talk adds more than a 1-turn talk (probe on a clean graph)
  {
    const probe = new RelationshipGraph("probe", { dir: mkdtempSync(join(tmpdir(), "rel-probe-")), nowGameMin: now });
    probe.updateFromInteraction({ kind: "dialogue", participants: ["probe", "x"], turns: 1, atGameMin: 1 });
    probe.updateFromInteraction({ kind: "dialogue", participants: ["probe", "y"], turns: 6, atGameMin: 1 });
    ok(
      probe.relationWith("y")!.familiarity > probe.relationWith("x")!.familiarity,
      "a longer conversation deepens familiarity more than a quick hello",
    );
  }

  // ---- 2. economic interactions: direction + counters + usdc -------------------------------------------
  console.log("\n[2] trades carry economic direction");
  // baker SELLS bread to several customers, and BUYS flour from the grocer.
  g.updateFromInteraction({ kind: "trade", buyer: "smith", seller: "baker", item: "bread", priceUsdc: 0.01, atGameMin: 160 });
  g.updateFromInteraction({ kind: "trade", buyer: "smith", seller: "baker", item: "bread", priceUsdc: 0.01, atGameMin: 165 });
  g.updateFromInteraction({ kind: "trade", buyer: "courier", seller: "baker", item: "bread", priceUsdc: 0.01, atGameMin: 170 });
  g.updateFromInteraction({ kind: "trade", buyer: "baker", seller: "grocer", item: "flour", priceUsdc: 0.04, atGameMin: 175 });

  const smith = g.relationWith("smith")!;
  ok(smith.tradesAsSeller === 2 && smith.tradesAsBuyer === 0, "baker sold to smith 2× (ego is the seller)");
  ok(Math.abs(smith.usdcSold - 0.02) < 1e-9, `usdcSold accumulates ($${smith.usdcSold.toFixed(2)})`);
  const grocer = g.relationWith("grocer")!;
  ok(grocer.tradesAsBuyer === 1 && Math.abs(grocer.usdcBought - 0.04) < 1e-9, "baker bought flour from grocer (ego is the buyer)");

  // self-trade (courier buying its own delivery pattern) and a signal not involving ego are no-ops
  const sizeBefore = g.size();
  g.updateFromInteraction({ kind: "trade", buyer: "baker", seller: "baker", item: "self", priceUsdc: 0.03, atGameMin: 180 });
  g.updateFromInteraction({ kind: "trade", buyer: "smith", seller: "grocer", item: "milk", priceUsdc: 0.02, atGameMin: 181 });
  g.updateFromInteraction({ kind: "dialogue", participants: ["smith", "grocer"], turns: 2, atGameMin: 182 });
  ok(g.size() === sizeBefore, "self-trade + non-party signals are no-ops (no spurious edges)");

  // ---- 3. NL query + reflection digest read sensibly ---------------------------------------------------
  console.log("\n[3] NL query + reflection digest");
  const desc = g.describeRelationship("smith");
  console.log(`      describeRelationship("smith") => ${desc}`);
  ok(/smith/.test(desc) && /sold to them 2/.test(desc), "describeRelationship reflects the economic history");
  ok(/festival|bread orders/.test(g.describeRelationship("barista")), "describeRelationship surfaces a recent topic");
  ok(/don't know/.test(g.describeRelationship("stranger")), "describeRelationship handles an unknown peer");

  const digest = g.reflectionDigest(5);
  console.log("      reflectionDigest =>");
  for (const line of digest) console.log(`        • ${line}`);
  ok(digest.length > 0 && digest.length <= 5, `digest returns up to 5 salient relationships (${digest.length})`);
  ok(
    digest.every((l) => typeof l === "string" && l.length > 0),
    "digest lines are non-empty NL (feedable to reflection as observations)",
  );

  // topRelations biasing: "supplier" surfaces who I buy from; "customer" who I sell to
  const suppliers = g.topRelations(3, "supplier");
  ok(suppliers.length === 1 && suppliers[0].other === "grocer", "topRelations('supplier') = the grocer (only one I buy from)");
  const customers = g.topRelations(3, "customer").map((r) => r.other);
  ok(customers.includes("smith") && customers.includes("courier"), "topRelations('customer') = smith + courier");

  // tier() boundaries read sensibly
  ok(tier(0.5) === "barely" && tier(3) === "a little" && tier(8) === "fairly well" && tier(20) === "very well",
    "familiarity tiers map to sensible words");

  // ---- 4. persistence round-trips (write → reload → identical) -----------------------------------------
  console.log("\n[4] persistence round-trip (resumable)");
  const snapshotBefore = JSON.stringify(g.all());
  // reload from disk into a brand-new instance (simulating a sim restart)
  const g2 = new RelationshipGraph(ego, { dir, nowGameMin: now });
  const snapshotAfter = JSON.stringify(g2.all());
  ok(g2.size() === g.size(), `reloaded graph has the same peer count (${g2.size()})`);
  ok(snapshotBefore === snapshotAfter, "reloaded graph is byte-identical to the pre-restart graph");
  // and a further update on the reloaded instance persists too
  g2.updateFromInteraction({ kind: "trade", buyer: "smith", seller: "baker", item: "bread", priceUsdc: 0.01, atGameMin: 200 });
  const g3 = new RelationshipGraph(ego, { dir, nowGameMin: now });
  ok(g3.relationWith("smith")!.tradesAsSeller === 3, "an update after reload also persists (3rd bread sale survives a 2nd restart)");

  // ---- 5. optional sentiment read via the injected stub (zero tokens) ----------------------------------
  console.log("\n[5] optional LLM sentiment read (stubbed, zero tokens)");
  // unit-test the parser directly
  ok(JSON.stringify(parseSentiment("0.6 0.8")) === JSON.stringify({ sentiment: 0.6, trust: 0.8 }), "parseSentiment parses 'sentiment trust'");
  ok(parseSentiment("no numbers here") === null, "parseSentiment returns null when it can't find two numbers");
  ok(JSON.stringify(parseSentiment("2 5")) === JSON.stringify({ sentiment: 1, trust: 1 }), "parseSentiment clamps to range");

  // assess via the stub: warm + trusting
  const warm = stubComplete("0.7 0.9");
  await g3.assessSentiment("smith", warm);
  const rs = g3.relationWith("smith")!;
  ok(rs.sentiment === 0.7 && rs.trust === 0.9, "assessSentiment stores the stubbed directed read");
  ok(/warmly/.test(g3.describeRelationship("smith")) && /trust/.test(g3.describeRelationship("smith")),
    "describeRelationship now includes sentiment + trust");

  // a garbled completion must NOT clobber the prior values (degrade, don't die)
  await g3.assessSentiment("smith", stubComplete("the model is confused"));
  const rs2 = g3.relationWith("smith")!;
  ok(rs2.sentiment === 0.7 && rs2.trust === 0.9, "a garbled sentiment completion leaves prior values untouched");

  // a thrown completion is swallowed too
  const thrower = async () => {
    throw new Error("model down");
  };
  await g3.assessSentiment("smith", thrower);
  ok(g3.relationWith("smith")!.sentiment === 0.7, "a thrown sentiment completion is swallowed (graph intact)");

  // sentiment survives a restart (persisted on the edge)
  const g4 = new RelationshipGraph(ego, { dir, nowGameMin: now });
  ok(g4.relationWith("smith")!.trust === 0.9, "sentiment/trust persist across a restart");

  // ---- 5b. adapter: ingest conversationalist's DialogueSummary verbatim --------------------------------
  console.log("\n[5b] DialogueSummary adapter (conversationalist's record, verbatim)");
  {
    const adir = mkdtempSync(join(tmpdir(), "rel-adapter-"));
    const cook = new RelationshipGraph("cook", { dir: adir, nowGameMin: now });

    // a real "conversed" DialogueSummary (the shape dialogue.ts emits), ingested from cook's POV
    cook.ingestDialogueSummary({
      participants: ["cook", "farmer"],
      turns: 5,
      endedAtGameMin: 300,
      outcome: "conversed",
      topic: "the harvest festival",
      summaryFor: { cook: "I chatted with farmer about the festival", farmer: "talked with the cook" },
    });
    const cf = cook.relationWith("farmer");
    ok(!!cf && cf.dialogues === 1 && cf.familiarity > 0, "adapter maps a 'conversed' summary to a dialogue (familiarity grows)");
    ok(/festival/.test(cook.describeRelationship("farmer")), "adapter carries topic + this-ego's POV line into the digest");

    // a "walk_by" must NOT bump dialogue count — it's a faint co-presence instead
    cook.ingestDialogueSummary({
      participants: ["cook", "tailor"],
      turns: 0,
      endedAtGameMin: 305,
      outcome: "walk_by",
      topic: "",
      summaryFor: {},
    });
    const ct = cook.relationWith("tailor");
    ok(!!ct && ct.dialogues === 0 && ct.coPresences === 1, "adapter maps a 'walk_by' to co-presence, not a conversation");
    ok(cook.relationWith("tailor")!.familiarity < cook.relationWith("farmer")!.familiarity, "a walk-by is weaker than a real conversation");

    // a summary for a DIFFERENT ego is a no-op on cook's graph
    const sizeBeforeNoop = cook.size();
    cook.ingestDialogueSummary(
      { participants: ["farmer", "tailor"], turns: 4, endedAtGameMin: 310, outcome: "conversed", topic: "x" },
      "farmer", // explicitly for farmer, not cook
    );
    ok(cook.size() === sizeBeforeNoop, "a DialogueSummary addressed to another ego is a no-op on this graph");
    rmSync(adir, { recursive: true, force: true });
  }

  // ---- 6. ego-centric: barista's OWN graph is independent (its own file) -------------------------------
  console.log("\n[6] ego-centric independence");
  const bar = new RelationshipGraph("barista", { dir, nowGameMin: now });
  ok(bar.size() === 0, "barista's graph is independent of baker's (separate file, no leakage)");
  bar.updateFromInteraction({ kind: "dialogue", participants: ["barista", "baker"], turns: 4, atGameMin: 210 });
  ok(bar.relationWith("baker")!.dialogues === 1 && bar.relationWith("baker") !== undefined, "barista records its own view of baker");
  // baker's file is unchanged by barista's update
  const bakerReload = new RelationshipGraph(ego, { dir, nowGameMin: now });
  ok(bakerReload.relationWith("barista")!.dialogues === g.relationWith("barista")!.dialogues, "baker's graph untouched by barista's writes");

  // ---- 7. S0-2 ACCEPTANCE: the 0-edges bug is fixed (trade→both edges; complete topics; co-presence) -----
  // Reproduces the exact runtime failure (ARCHITECTURE-RESEARCH §A.6 / OBSERVABILITY §5 #4): 0/1,231 trades
  // reached the graph, topics truncated mid-word ("…barista said"), coPresences:0 everywhere. Each agent owns
  // its OWN graph (single writer per file), so we model buyer + seller as two independent graphs — exactly how
  // the citizen loop's trade-tap (citizen.ts:180-189) folds one `purchase` into each party's graph on its tick.
  console.log("\n[7] S0-2 acceptance — trade→both edges, complete topics, co-presence lands");
  {
    const sdir = mkdtempSync(join(tmpdir(), "rel-s0-2-"));
    const buyerG = new RelationshipGraph("isabella", { dir: sdir, nowGameMin: now }); // buyer's ego graph
    const sellerG = new RelationshipGraph("baker", { dir: sdir, nowGameMin: now }); // seller's ego graph

    // (a) ONE purchase event, folded into BOTH parties' graphs (the trade-tap broadcasts to each side).
    const trade = { kind: "trade", buyer: "isabella", seller: "baker", item: "bread", priceUsdc: 0.03, atGameMin: 400 } as const;
    buyerG.updateFromInteraction(trade);
    sellerG.updateFromInteraction(trade);

    const bSide = buyerG.relationWith("baker");
    ok(!!bSide && bSide.tradesAsBuyer === 1 && bSide.tradesAsSeller === 0, "(a) buyer's graph: an edge to the seller with tradesAsBuyer=1");
    ok(!!bSide && Math.abs(bSide.usdcBought - 0.03) < 1e-9 && bSide.usdcSold === 0, "(a) buyer edge carries non-zero usdcBought");
    const sSide = sellerG.relationWith("isabella");
    ok(!!sSide && sSide.tradesAsSeller === 1 && sSide.tradesAsBuyer === 0, "(a) seller's graph: an edge to the buyer with tradesAsSeller=1");
    ok(!!sSide && Math.abs(sSide.usdcSold - 0.03) < 1e-9 && sSide.usdcBought === 0, "(a) seller edge carries non-zero usdcSold");
    // and it PERSISTED on both sides (no lost write — reload from disk and re-check the seller side)
    const sellerReload = new RelationshipGraph("baker", { dir: sdir, nowGameMin: now });
    ok(sellerReload.relationWith("isabella")?.tradesAsSeller === 1, "(a) the seller edge survives a reload (flush-on-update persisted it)");

    // (b) a real DialogueSummary whose POV line is a FULL sentence (the shape that used to truncate to
    //     "…baker said"). The COMPLETE distilled topic must persist on BOTH participants, never severed.
    const summaryText = `I talked with baker about the bread shortage. baker said: "I've sold out three times this week."`;
    const convo = {
      participants: ["isabella", "baker"] as [string, string],
      turns: 5,
      endedAtGameMin: 410,
      outcome: "conversed" as const,
      topic: "the bread shortage",
      summaryFor: { isabella: summaryText, baker: `I talked with isabella about the bread shortage. isabella said: "Do you have any left?"` },
    };
    buyerG.ingestDialogueSummary(convo, "isabella");
    sellerG.ingestDialogueSummary(convo, "baker");

    const buyerTopics = buyerG.relationWith("baker")!.topics;
    const sellerTopics = sellerG.relationWith("isabella")!.topics;
    ok(buyerTopics.includes("the bread shortage"), `(b) buyer stores the COMPLETE topic phrase (got: ${JSON.stringify(buyerTopics)})`);
    ok(sellerTopics.includes("the bread shortage"), `(b) seller stores the COMPLETE topic phrase (got: ${JSON.stringify(sellerTopics)})`);
    // the bug signature: no stored topic is a mid-word fragment of the POV sentence ("…baker said" with no quote)
    const truncatedFragment = (t: string) => /\bsaid$/.test(t) || (t.endsWith("…") && /\bsaid\b/.test(t) && !/["']/.test(t));
    ok(!buyerTopics.some(truncatedFragment) && !sellerTopics.some(truncatedFragment), "(b) NO topic is a mid-word POV-sentence fragment (the '…said' truncation is gone)");
    ok(/bread shortage/.test(buyerG.describeRelationship("baker")), "(b) describeRelationship surfaces the complete topic, not a fragment");

    // (c) a co-presence interaction must actually bump coPresences (it was 0 everywhere in the run).
    buyerG.updateFromInteraction({ kind: "copresence", participants: ["isabella", "baker"], atGameMin: 420 });
    ok(buyerG.relationWith("baker")!.coPresences > 0, "(c) a co-presence signal lands (coPresences > 0)");
    // and the walk_by → co-presence adapter path lands one too (the dialogue-driver's faint-tie route)
    const wbG = new RelationshipGraph("isabella", { dir: mkdtempSync(join(tmpdir(), "rel-wb-")), nowGameMin: now });
    wbG.ingestDialogueSummary({ participants: ["isabella", "baker"], turns: 0, endedAtGameMin: 430, outcome: "walk_by", topic: "", summaryFor: {} }, "isabella");
    ok(wbG.relationWith("baker")!.coPresences === 1, "(c) a walk_by DialogueSummary lands a co-presence edge");

    rmSync(sdir, { recursive: true, force: true });
  }

  // ---- 7b. clipWords unit: long input clamps CLEANLY at a word boundary, never mid-word ------------------
  console.log("\n[7b] clipWords clamps cleanly (defense-in-depth)");
  ok(clipWords("short", 80) === "short", "clipWords leaves a short string untouched");
  {
    const long = "I talked with barista about Mutual interdependence between workers. barista said: hi";
    const clipped = clipWords(long, 80);
    ok(clipped.length <= 80, `clipWords respects the max (${clipped.length} <= 80)`);
    ok(clipped.endsWith("…"), "clipWords appends an ellipsis when it truncates");
    ok(!/\bsaid$/.test(clipped.replace(/…$/, "")), "clipWords does NOT sever mid-word at 'said' (the old bug)");
    ok(!/[\s.,;:!?-]…$/.test(clipped), "clipWords strips trailing punctuation before the ellipsis");
  }

  // ---- 7c. OPINION NOTE (town-alive B2): parse, set, describe, persist ----------------------------------
  console.log("\n[7c] opinion notes (like/dislike with a why)");
  {
    const { parseOpinion } = await import("./relationships.js");
    ok(parseOpinion("LIKE: she saves me the good apples")?.stance === "like", "parseOpinion reads LIKE");
    ok(parseOpinion("dislike — he short-changed me")?.stance === "dislike", "parseOpinion tolerates case + dash");
    ok(parseOpinion("NEUTRAL: barely know them")?.why === "barely know them", "parseOpinion captures the why");
    ok(parseOpinion("no stance here") === null, "parseOpinion → null on garbage (prior opinion kept)");

    const odir = mkdtempSync(join(tmpdir(), "rel-opinion-"));
    const og = new RelationshipGraph("isabella", { dir: odir, nowGameMin: () => 500 });
    og.updateFromInteraction({ kind: "dialogue", participants: ["isabella", "klaus"], turns: 4, atGameMin: 500 });
    const noted = og.noteOpinion("klaus", "like", "he always asks about the cafe");
    ok(noted?.opinion?.stance === "like", "noteOpinion sets the stance");
    ok(/you like them — he always asks/.test(og.describeRelationship("klaus")), "describeRelationship voices the opinion + why");
    ok(og.noteOpinion("stranger", "like", "?") === undefined, "no edge → no opinion (needs an interaction first)");
    const og2 = new RelationshipGraph("isabella", { dir: odir, nowGameMin: () => 501 });
    ok(og2.relationWith("klaus")?.opinion?.why === "he always asks about the cafe", "opinion persists across reload");
    // drift: a later note overwrites (the point — opinions can flip)
    og2.noteOpinion("klaus", "dislike", "he knocked over the pastry case");
    ok(og2.relationWith("klaus")?.opinion?.stance === "dislike", "a later note DRIFTS the opinion");
    rmSync(odir, { recursive: true, force: true });
  }

  clock = 999;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
