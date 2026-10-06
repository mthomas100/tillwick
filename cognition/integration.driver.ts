import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mind } from "./mind.js";
import { RelationshipGraph } from "./relationships.js";
import { holdDialogue, type DialogueSummary } from "./dialogue.js";
import { type Complete, type CompleteOpts } from "./llm.js";
// The LITERAL citizen-side orchestrator (conversationalist) — SDK-free + fully injectable, so the gate can
// exercise the REAL driver code (single-initiator guard, read-only-partner isolation, persist-initiator-only,
// record), not just a shim. (Lead's mandate: exercise the real seam.)
import { maybeDriveDialogue } from "../citizens/dialogue-driver.js";

// WAVE-2b PROOF-OF-CORRECTNESS — the end-to-end SOCIAL-LOOP integration test (zero-token). This is the GATE
// before Wave 2c's gated live run: it proves the integrated loop the lead is about to wire into the hot files
// actually holds together, using the REAL seams (not mocks):
//
//   two agents go adjacent
//     → REAL holdDialogue(a, b, complete, opts) runs the turn-taking dialogue (cognition/dialogue.ts)
//     → a REAL DialogueSummary is produced (conversed | walk_by)
//     → the citizen-loop glue calls graph[ego].ingestDialogueSummary(summary, ego) for BOTH participants
//       (cognition/relationships.ts) — the SAME call the dialogue-driver / sim close-handler will make
//     → familiarity RISES, and rises MORE on repeat contact
//     → reflectionDigest() reads sensibly (relationships → salient memory lines)
//     → a purchase/trade event → updateFromInteraction({kind:"trade",...}) bumps the supplier/customer edge
//     → a walk_by (turns:0) yields ONLY a faint co-presence, NOT a dialogue edge
//
// It ALSO checks the cognitive cross-wiring the loop depends on: holdDialogue writes the conversation back
// into BOTH agents' memory streams (Mind.observe), so the dialogue actually feeds retrieval/reflection.
//
// COST DISCIPLINE (INC-2026-06-18): the model is the INJECTED `Complete` — a deterministic `routedStub`
// (below) that returns the right thing per prompt KIND (engage decision / utterance / topic+belief / poignancy)
// at ZERO token spend. NO SDK import, NO fleet, NO citizens. Run: `npx tsx cognition/integration.driver.ts`.
//
// FAITHFUL SEAM: the glue step `ingestDialogueSummary(summary, ego)` per participant is exactly the call site
// agreed with conversationalist for citizens/dialogue-driver.ts (and the sim /dialogue close handler). This
// harness mirrors that sequence 1:1, so a green run here means the real wiring is correct. (If the driver
// lands as an importable pure function, swap `runDialogueGlue` for it — the sequence is identical.)

// ---- a deterministic, prompt-routed stub Complete (zero tokens) -----------------------------------------

// holdDialogue + Mind make several KINDS of model call; we route by distinctive markers in the prompt/system
// so each returns something realistic, driving the REAL dialogue end-to-end. A per-conversation utterance
// counter makes the speaker emit a natural close ([END]) after a couple of exchanges so the dialogue
// terminates deterministically with turns >= 1.
function makeRoutedStub(opts: { topic: string; belief: boolean; importance?: number; closeAfter?: number }): {
  complete: Complete;
  resetTurns: () => void;
} {
  let utterances = 0;
  const closeAfter = opts.closeAfter ?? 2; // emit [END] starting on this utterance index
  const imp = opts.importance ?? 5;
  const complete: Complete = async (prompt: string, o?: CompleteOpts) => {
    const sys = o?.system ?? "";
    // 1) engage decision — system says "TALK or PASS"
    if (/TALK or PASS/i.test(sys)) return "TALK";
    // 2) poignancy/importance — system says "poignancy ... single integer"
    if (/poignancy/i.test(sys)) return String(imp);
    // 3) topic + belief distillation — system mentions the two-line BELIEF reply
    if (/BELIEF:\s*yes/i.test(sys) || /belief/i.test(prompt)) {
      return `${opts.topic}\nBELIEF: ${opts.belief ? "yes" : "no"}`;
    }
    // 4) otherwise: an utterance. Speak a believable line; after `closeAfter`, append the close token so the
    //    conversation ends naturally (the real holdDialogue strips [END] and stops).
    utterances++;
    const base = `About ${opts.topic} — good to see you.`;
    return utterances >= closeAfter ? `${base} Anyway, take care! [END]` : base;
  };
  return { complete, resetTurns: () => (utterances = 0) };
}

// ---- the COGNITION-SEAM glue we're proving (the core of citizens/dialogue-driver.ts's maybeDriveDialogue) -

// Run a dialogue between two IN-PROCESS Minds and fold its summary into BOTH participants' relationship graphs
// — the EXACT cognition-seam sequence the citizen-loop runs. This is the CORE of conversationalist's
// `maybeDriveDialogue` (citizens/dialogue-driver.ts); section [2c] drives that REAL driver directly. What the
// driver adds AROUND this core — the single-initiator guard (lower-id), the read-only partner Mind from a
// temp-copy (cross-process isolation), and the POST {op:record} — are citizen/sim-runtime concerns, ORTHOGONAL
// to the cognition loop these sections prove. Returns the summary so the caller can assert on it.
async function runDialogueGlue(
  a: Mind,
  b: Mind,
  complete: Complete,
  graphs: Record<string, RelationshipGraph>,
  opts: Parameters<typeof holdDialogue>[3] = {},
): Promise<DialogueSummary> {
  const summary = await holdDialogue(a, b, complete, opts);
  for (const ego of summary.participants) graphs[ego]?.ingestDialogueSummary(summary, ego);
  return summary;
}

// ---- harness ---------------------------------------------------------------------------------------------

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

const root = mkdtempSync(join(tmpdir(), "integration-"));
const memDir = join(root, "memory");
const relDir = join(root, "relationships");
let clock = 480; // game-minutes (08:00)
const now = () => clock;

// A real Mind + real graph for `id`, with memory + relationship scratch under `baseDir` (its own temp dir →
// no sim/data pollution, and isolatable per-scenario so a "did the partner's file change?" assertion is clean).
function makeAgentIn(id: string, persona: string, complete: Complete, baseDir: string) {
  const mind = new Mind({ agentId: id, persona, complete, nowGameMin: now, dir: join(baseDir, "memory") });
  const graph = new RelationshipGraph(id, { dir: join(baseDir, "relationships"), nowGameMin: now });
  return { mind, graph };
}

// The main-scenario agents share one memory/relationship dir pair (memDir/relDir under the temp root).
function makeAgent(id: string, persona: string, complete: Complete) {
  const mind = new Mind({ agentId: id, persona, complete, nowGameMin: now, dir: memDir });
  const graph = new RelationshipGraph(id, { dir: relDir, nowGameMin: now });
  return { mind, graph };
}

async function main() {
  // A shared routed stub: topic "the bakery sale", belief = true (so we can prove mentionedBelief propagates).
  const stub = makeRoutedStub({ topic: "the bakery sale", belief: true, importance: 5 });

  const isabella = makeAgent("isabella", "Isabella Rodriguez, runs Hobbs Cafe.", stub.complete);
  const klaus = makeAgent("klaus", "Klaus Mueller, a student who likes coffee.", stub.complete);
  const graphs: Record<string, RelationshipGraph> = { isabella: isabella.graph, klaus: klaus.graph };

  // ---- 1. adjacency → REAL holdDialogue → DialogueSummary (conversed) ----------------------------------
  console.log("\n[1] two agents adjacent → holdDialogue runs a real conversation");
  stub.resetTurns();
  clock = 485;
  const s1 = await runDialogueGlue(isabella.mind, klaus.mind, stub.complete, graphs, {
    nowGameMin: now,
    situation: "You are both standing outside Hobbs Cafe.",
    forceEngage: true, // deterministic: guarantee they converse
  });
  ok(s1.outcome === "conversed", `outcome is "conversed" (got "${s1.outcome}")`);
  ok(s1.turns >= 1, `at least one utterance was spoken (turns=${s1.turns})`);
  ok(s1.participants[0] === "isabella" && s1.participants[1] === "klaus", "participants sorted + correct");
  ok(s1.topic === "the bakery sale", `topic distilled from the stub ("${s1.topic}")`);
  ok(s1.mentionedBelief === true, "mentionedBelief propagated (diffusion signal present on conversed)");
  ok(
    !!s1.summaryFor["isabella"] && !!s1.summaryFor["klaus"],
    "per-agent POV summaries produced for both participants",
  );

  // ---- 2. the dialogue fed BOTH memory streams (cognition cross-wiring) --------------------------------
  console.log("\n[2] holdDialogue wrote the conversation back into both memory streams");
  ok(isabella.mind.size() >= 1, `isabella's memory stream grew (size=${isabella.mind.size()})`);
  ok(klaus.mind.size() >= 1, `klaus's memory stream grew (size=${klaus.mind.size()})`);
  const isaRecent = isabella.mind.stream.recent(3).map((m) => m.text).join(" | ");
  ok(/klaus/i.test(isaRecent) && /bakery sale/i.test(isaRecent), "isabella's new memory names klaus + the topic");

  // ---- 2b. THE LIVE-FLEET PATH: persistMemoryFor:"initiator" (cross-process safety) --------------------
  // In the live fleet each agent runs in its OWN process owning its OWN memory file; the citizen-side driver
  // (citizens/dialogue-driver.ts, conversationalist) constructs the PARTNER's Mind READ-ONLY and passes
  // persistMemoryFor:"initiator" so holdDialogue writes ONLY the initiator's stream — never appends to the
  // partner's real file (which a second process would race). This is the path Wave 2c actually runs, so the
  // GATE must prove the social loop stays intact under it: the partner's MEMORY isn't written, but BOTH
  // relationship graphs still update (the partner learns the tie via ingestDialogueSummary, not its stream).
  console.log('\n[2b] live-fleet persistMemoryFor:"initiator" — initiator-only memory write, but social loop intact');
  {
    const liveDir = mkdtempSync(join(root, "live-"));
    const initId = "ramon"; // ramon initiates (a); tom is the read-only partner (b)
    const partId = "tom";
    const init = makeAgentIn(initId, "Ramon, runs the deli.", stub.complete, liveDir);
    const part = makeAgentIn(partId, "Tom, a neighbor.", stub.complete, liveDir);
    const liveGraphs: Record<string, RelationshipGraph> = { [initId]: init.graph, [partId]: part.graph };
    const initBefore = init.mind.size();
    const partBefore = part.mind.size();
    stub.resetTurns();
    clock = 495;
    // mirror the live driver EXACTLY: initiator's Mind is `a`, partner read-only, persistMemoryFor "initiator".
    const sLive = await holdDialogue(init.mind, part.mind, stub.complete, {
      nowGameMin: now,
      forceEngage: true,
      persistMemoryFor: "initiator",
    });
    for (const ego of sLive.participants) liveGraphs[ego]?.ingestDialogueSummary(sLive, ego);

    ok(sLive.outcome === "conversed" && sLive.turns >= 1, "live conversation engaged");
    ok(init.mind.size() === initBefore + 1, "INITIATOR's memory stream WAS written (its own process owns it)");
    ok(part.mind.size() === partBefore, "PARTNER's memory stream was NOT written (no cross-process append race)");
    // the crucial integration property: the social loop survives the read-only-partner mode —
    // BOTH graphs still formed the edge, because relationship ingest is independent of memory persistence.
    ok(
      !!init.graph.relationWith(partId) && init.graph.relationWith(partId)!.dialogues === 1,
      "initiator's relationship edge formed",
    );
    ok(
      !!part.graph.relationWith(initId) && part.graph.relationWith(initId)!.dialogues === 1,
      "PARTNER's relationship edge ALSO formed (learns the tie via ingest, not via its memory stream)",
    );
    // a reload of the partner's REAL memory file proves nothing was appended cross-process. (Same dir
    // makeAgentIn used: <liveDir>/memory.)
    const partReload = new Mind({ agentId: partId, persona: "x", complete: stub.complete, nowGameMin: now, dir: join(liveDir, "memory") });
    ok(partReload.size() === partBefore, "partner's on-disk memory file is untouched after a live-mode dialogue");
  }

  // ---- 2c. THE LITERAL ORCHESTRATOR: drive conversationalist's maybeDriveDialogue end-to-end -----------
  // The strongest fidelity: instead of a shim, drive the REAL citizen-side driver. It applies the single-
  // initiator guard (selfId < partner), constructs the partner Mind READ-ONLY by copying its persisted stream
  // to a temp dir (so even read-time embed/touch never hits the partner's real file), runs holdDialogue with
  // persistMemoryFor:"initiator", and records via an injectable postRecord. It RETURNS the summary; the sim
  // close-handler (and here, the gate) does the relationship ingest. Proves the real wiring, zero-token.
  console.log("\n[2c] drive the REAL maybeDriveDialogue (single-initiator guard, read-only partner, record→ingest)");
  {
    const drvDir = mkdtempSync(join(root, "drv-"));
    const memHome = join(drvDir, "memory"); // the shared per-agent memory home the driver reads partner streams from
    const relHome = join(drvDir, "relationships");
    // "alma" and "boris": alma < boris, so ONLY alma initiates (the guard). Give boris a PERSISTED stream so
    // the driver's isolatePartnerStream has a real file to copy (and we can prove it isn't appended to).
    const alma = new Mind({ agentId: "alma", persona: "Alma, the florist.", complete: stub.complete, nowGameMin: now, dir: memHome });
    const boris = new Mind({ agentId: "boris", persona: "Boris, the smith.", complete: stub.complete, nowGameMin: now, dir: memHome });
    await boris.observe("Boris opened the smithy early today.", { importance: 3 });
    const borisFileBefore = boris.size();
    const annaBefore = alma.size();
    const annaGraph = new RelationshipGraph("alma", { dir: relHome, nowGameMin: now });
    const borisGraph = new RelationshipGraph("boris", { dir: relHome, nowGameMin: now });
    const graphsByIdLocal: Record<string, RelationshipGraph> = { alma: annaGraph, boris: borisGraph };

    // the injectable record sink (in prod this POSTs {SIM}/dialogue {op:record}); here we capture it.
    const recorded: DialogueSummary[] = [];
    stub.resetTurns();
    clock = 540;

    // (i) the NON-initiator side: boris is adjacent to alma, but boris > alma, so boris must NOT initiate.
    const borisTry = await maybeDriveDialogue({
      selfMind: boris,
      adjacentTo: ["alma"],
      complete: stub.complete,
      nowGameMin: now,
      memoryDir: memHome,
      personaFor: (id) => `${id}, a townsperson.`,
      postRecord: async (s) => void recorded.push(s),
      forceEngage: true,
    });
    ok(borisTry.initiated === false && borisTry.reason === "not-initiator", "single-initiator guard: boris (higher id) does NOT initiate");
    ok(recorded.length === 0, "no record produced by the non-initiator");

    // (ii) the INITIATOR side: alma initiates with boris, runs the real driver end-to-end.
    const annaDrive = await maybeDriveDialogue({
      selfMind: alma,
      adjacentTo: ["boris"],
      complete: stub.complete,
      nowGameMin: now,
      situation: "Both are outside the flower stall.",
      memoryDir: memHome,
      personaFor: (id) => `${id}, a townsperson.`,
      postRecord: async (s) => void recorded.push(s),
      forceEngage: true,
    });
    ok(annaDrive.initiated === true && annaDrive.partner === "boris", "alma (lower id) initiates with boris");
    ok(!!annaDrive.summary && annaDrive.summary.outcome === "conversed", "the driver returned a conversed summary");
    ok(recorded.length === 1 && recorded[0].id === annaDrive.summary!.id, "the driver recorded the summary via the injected postRecord");
    ok(alma.size() === annaBefore + 1, "the driver persisted ONLY the initiator's (alma's) memory");
    // boris's REAL persisted stream must be untouched (the driver copied it read-only into a temp dir).
    const borisReload = new Mind({ agentId: "boris", persona: "x", complete: stub.complete, nowGameMin: now, dir: memHome });
    ok(borisReload.size() === borisFileBefore, "boris's REAL memory file untouched (read-only partner isolation works)");

    // (iii) the sim close-handler step — ingest the recorded summary into BOTH graphs (the call I own).
    for (const ego of annaDrive.summary!.participants) graphsByIdLocal[ego]?.ingestDialogueSummary(annaDrive.summary!, ego);
    ok(
      !!annaGraph.relationWith("boris") && !!borisGraph.relationWith("alma"),
      "after the driver + ingest, BOTH relationship edges exist (full real-wiring loop closed)",
    );
  }

  // ---- 3. both relationship graphs formed an edge; familiarity rose ------------------------------------
  console.log("\n[3] both graphs ingested the summary → an edge formed, familiarity > 0");
  const ik1 = isabella.graph.relationWith("klaus");
  const ki1 = klaus.graph.relationWith("isabella");
  ok(!!ik1 && ik1.dialogues === 1 && ik1.familiarity > 0, `isabella↔klaus edge formed (fam=${ik1?.familiarity.toFixed(2)})`);
  ok(!!ki1 && ki1.dialogues === 1 && ki1.familiarity > 0, "klaus↔isabella edge formed (symmetric ingest, both egos)");
  ok(/bakery sale/i.test(isabella.graph.describeRelationship("klaus")), "describeRelationship carries the dialogue topic");

  // ---- 4. repeat contact → familiarity rises MORE -------------------------------------------------------
  console.log("\n[4] repeat conversation → familiarity strictly increases");
  const famBefore = isabella.graph.relationWith("klaus")!.familiarity;
  stub.resetTurns();
  clock = 510;
  const s2 = await runDialogueGlue(isabella.mind, klaus.mind, stub.complete, graphs, {
    nowGameMin: now,
    forceEngage: true,
  });
  ok(s2.outcome === "conversed", "second conversation also engaged");
  const famAfter = isabella.graph.relationWith("klaus")!.familiarity;
  ok(famAfter > famBefore, `familiarity rose with repeat contact: ${famBefore.toFixed(2)} → ${famAfter.toFixed(2)}`);
  ok(isabella.graph.relationWith("klaus")!.dialogues === 2, "dialogue count incremented to 2");

  // ---- 5. reflectionDigest reads sensibly ---------------------------------------------------------------
  console.log("\n[5] reflectionDigest surfaces the relationship as a salient memory line");
  const digest = isabella.graph.reflectionDigest(5);
  for (const line of digest) console.log(`      • ${line}`);
  ok(digest.length >= 1, `digest non-empty (${digest.length} line(s))`);
  ok(digest.some((l) => /klaus/i.test(l)), "digest mentions the known peer (klaus)");
  ok(
    digest.every((l) => typeof l === "string" && l.length > 0),
    "digest lines are non-empty NL (foldable into the memory stream for reflection)",
  );

  // ---- 6. a trade event bumps the supplier/customer edge ----------------------------------------------
  console.log("\n[6] a purchase event → updateFromInteraction(trade) → economic edge");
  // klaus BUYS coffee from isabella (mirrors a ledger `purchase`: actor=klaus, counterparty=isabella). The
  // loop broadcasts the trade to BOTH parties' graphs.
  clock = 520;
  const trade = {
    kind: "trade" as const,
    buyer: "klaus",
    seller: "isabella",
    item: "coffee",
    priceUsdc: 0.02,
    atGameMin: now(),
  };
  klaus.graph.updateFromInteraction(trade);
  isabella.graph.updateFromInteraction(trade);
  const kSup = klaus.graph.relationWith("isabella")!;
  ok(kSup.tradesAsBuyer === 1 && Math.abs(kSup.usdcBought - 0.02) < 1e-9, "klaus's edge: bought from isabella (supplier)");
  const iCust = isabella.graph.relationWith("klaus")!;
  ok(iCust.tradesAsSeller === 1 && Math.abs(iCust.usdcSold - 0.02) < 1e-9, "isabella's edge: sold to klaus (customer)");
  ok(
    klaus.graph.topRelations(3, "supplier").some((r) => r.other === "isabella"),
    'topRelations("supplier") surfaces isabella for klaus ("who would I buy from")',
  );
  ok(
    isabella.graph.topRelations(3, "customer").some((r) => r.other === "klaus"),
    'topRelations("customer") surfaces klaus for isabella',
  );

  // ---- 7. walk_by → ONLY a faint co-presence, NOT a dialogue edge --------------------------------------
  console.log("\n[7] a walk_by yields a faint co-presence, not a conversation");
  // a THIRD agent passes by isabella but they don't engage (forceEngage:false → deterministic walk_by).
  const maria = makeAgent("maria", "Maria Lopez, a student.", stub.complete);
  graphs["maria"] = maria.graph;
  clock = 530;
  const s3 = await runDialogueGlue(isabella.mind, maria.mind, stub.complete, graphs, {
    nowGameMin: now,
    forceEngage: false, // deterministic walk_by
  });
  ok(s3.outcome === "walk_by" && s3.turns === 0, `outcome walk_by, 0 turns (got "${s3.outcome}"/${s3.turns})`);
  const im = isabella.graph.relationWith("maria");
  ok(!!im && im.dialogues === 0 && im.coPresences === 1, "isabella↔maria: a co-presence, NOT a dialogue");
  ok(
    im!.familiarity < isabella.graph.relationWith("klaus")!.familiarity,
    "a walk-by familiarity is far weaker than a real (repeated) conversation",
  );
  ok(maria.mind.size() === 0, "a walk_by wrote NO memory (no conversation to remember)");

  // ---- 8. persistence: the whole social state resumes from disk ----------------------------------------
  console.log("\n[8] the integrated social state is durable + resumable");
  const isaSnapshot = JSON.stringify(isabella.graph.all());
  const isaReload = new RelationshipGraph("isabella", { dir: relDir, nowGameMin: now });
  ok(JSON.stringify(isaReload.all()) === isaSnapshot, "isabella's relationship graph round-trips byte-identically from disk");
  const isaMindReload = new Mind({ agentId: "isabella", persona: "x", complete: stub.complete, nowGameMin: now, dir: memDir });
  ok(isaMindReload.size() === isabella.mind.size(), "isabella's memory stream resumes from disk (same size)");
}

main()
  .catch((e) => {
    console.error("UNEXPECTED THROW (the loop must degrade, not throw):", e);
    failed++;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    console.log(`\n==== ${passed} passed, ${failed} failed ====`);
    process.exit(failed === 0 ? 0 : 1);
  });
