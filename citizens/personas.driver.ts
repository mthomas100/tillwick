import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStream } from "../cognition/memory-stream.js";
import { buildSummary } from "../cognition/summary.js";
import { stubComplete } from "../cognition/llm.js";
import { PERSONAS, personaFor } from "./personas.js";
import { seedAgentMemories, seedId } from "./seed.js";

// ZERO-TOKEN driver for the S1-1 structured-personas + seed-loader path. Synthetic only: the LLM seam is
// stubComplete (no model, no SDK, no fleet). Run: `npx tsx citizens/personas.driver.ts`.
//
// Proves: (1) every roster persona is rich + DISTINCT (name/age/station/voice/relationships/routine/seedMemories);
// (2) the seed loader writes the seed paragraph into the stream as token-free observations and is IDEMPOTENT on
// a resume (reload → re-seed writes nothing); (3) an agent that booted with its seeds produces a DISTINCT,
// GROUNDED [Agent's Summary Description] (its real relationships/role surface; two agents' summaries differ) —
// NOT generic merchant-speak. buildSummary is run with an EMPTY-output stub so the block falls back to the
// agent's OWN retrieved seed memories (degrade-don't-die) — i.e. the grounding is real, not hand-fed.

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

const MERCHANTS = ["baker", "barista", "grocer", "courier", "smith"]; // own a shop (S1-1)
const TOWNSFOLK = ["student", "musician", "regular"]; // non-merchant cast (S1-4)
const ROSTER = [...MERCHANTS, ...TOWNSFOLK];
const dir = mkdtempSync(join(tmpdir(), "personas-driver-"));
const emptyStub = stubComplete(""); // forces buildSummary's facet fallback to the retrieved memory text

try {
  // ---- 1. every persona is rich + structurally complete --------------------------------------------------
  console.log(`\n[1] personas are rich + complete (${MERCHANTS.length} merchants + ${TOWNSFOLK.length} townsfolk)`);
  ok(Object.keys(PERSONAS).length === ROSTER.length, `${ROSTER.length} personas defined (${MERCHANTS.length} merchants + ${TOWNSFOLK.length} non-merchants)`);
  for (const id of ROSTER) {
    const p = personaFor(id);
    // shopId is a merchant-only field (non-merchants own no shop → ""); everything else is required for all.
    const complete =
      !!p.name && p.age > 0 && !!p.role && !!p.station && p.traits.length > 0 && !!p.voice &&
      p.relationships.length > 0 && !!p.routine && p.tools.length > 0 && p.seedMemories.length > 0 &&
      typeof p.shopId === "string" && Array.isArray(p.buys) && !!p.system;
    ok(complete, `${id}: all structured fields present (name/age/station/voice/relationships/routine/tools/seedMemories/buys/shopId/system)`);
  }
  // backward-compat: the load-bearing fields the existing consumers read are still strings/arrays
  for (const id of ROSTER) {
    const p = personaFor(id);
    ok(typeof p.system === "string" && p.system.length > 40, `${id}: derived system header is a non-trivial string (world-tools/citizen/dialogue-driver consume it)`);
  }

  // ---- 2. personas are DISTINCT (voice + station + name), not reskins of one sentence -------------------
  console.log("\n[2] personas are distinct (no generic collapse)");
  const names = ROSTER.map((id) => personaFor(id).name);
  ok(new Set(names).size === ROSTER.length, `all ${ROSTER.length} names distinct (${names.join(", ")})`);
  const voices = ROSTER.map((id) => personaFor(id).voice);
  ok(new Set(voices).size === ROSTER.length, `all ${ROSTER.length} voices distinct`);
  const systems = ROSTER.map((id) => personaFor(id).system);
  ok(new Set(systems).size === ROSTER.length, `all ${ROSTER.length} derived system headers distinct`);

  // cross-relationships: the cast actually KNOWS each other (baker↔barista trade, smith mends for baker, …)
  const baker = personaFor("baker");
  ok(baker.relationships.some((r) => r.to === "barista" && /coffee|bread|trade|friend/i.test(r.tie)), "baker knows the barista (the bread↔coffee tie)");
  const smith = personaFor("smith");
  ok(smith.relationships.some((r) => r.to === "baker" && /mend|hinge|tin|let her down/i.test(r.tie)), "smith mends for the baker (a concrete, POV relationship)");
  // relationships reference REAL roster ids (no dangling acquaintance)
  for (const id of ROSTER) {
    const refs = personaFor(id).relationships.map((r) => r.to);
    ok(refs.every((to) => ROSTER.includes(to)), `${id}: all relationships point at real roster ids`);
  }

  // ---- 3. seed loader writes the paragraph token-free + is IDEMPOTENT on resume -------------------------
  console.log("\n[3] seed loader: token-free write + idempotent resume");
  const s1 = new MemoryStream("baker", { dir, nowGameMin: () => 0 });
  const r1 = seedAgentMemories(s1, baker, { atGameMin: 0 });
  ok(r1.seeded === baker.seedMemories.length && r1.skipped === 0, `first boot seeds all ${baker.seedMemories.length} memories (seeded=${r1.seeded}, skipped=${r1.skipped})`);
  ok(s1.size() === baker.seedMemories.length, "stream holds exactly the seed memories after first boot");
  // every seed is an observation with the explicit importance (no model call would have produced these)
  const all1 = s1.all();
  ok(all1.every((m) => m.kind === "observation"), "all seeds are observations");
  ok(all1.every((m) => m.importance === 6), "all seeds carry the explicit (token-free) importance");
  ok(!!s1.get(seedId("baker", 0)), "seeds use deterministic ids (seed:baker:0 present)");

  // RESUME: a brand-new stream over the SAME dir loads the prior file; re-seeding must write NOTHING.
  const s2 = new MemoryStream("baker", { dir, nowGameMin: () => 100 });
  ok(s2.size() === baker.seedMemories.length, "resumed stream loaded the prior seeds from disk");
  const r2 = seedAgentMemories(s2, baker, { atGameMin: 100 });
  ok(r2.seeded === 0 && r2.skipped === baker.seedMemories.length, `resume re-seeds NOTHING (seeded=${r2.seeded}, skipped=${r2.skipped}) — idempotent`);
  ok(s2.size() === baker.seedMemories.length, "stream size unchanged after a resume (no duplicates)");

  // ---- 4. buildSummary on a seeded stream reads DISTINCT + GROUNDED (not generic) -----------------------
  console.log("\n[4] grounded, distinct [Agent's Summary Description] from the seeds");
  const summaries: Record<string, string> = {};
  for (const id of ROSTER) {
    const p = personaFor(id);
    const stream = new MemoryStream(id, { dir: mkdtempSync(join(tmpdir(), `pd-${id}-`)), nowGameMin: () => 0 });
    seedAgentMemories(stream, p, { atGameMin: 0 });
    // emptyStub ⇒ each facet falls back to THIS agent's retrieved seed memories (degrade-don't-die) → real grounding
    const summary = await buildSummary(stream, emptyStub, { name: p.name, age: p.age, traits: p.traits.join(", "), nowGameMin: 30 });
    summaries[id] = summary.text;
    ok(summary.text.includes(p.name), `${id}: summary header carries the real name (${p.name})`);
    ok(new RegExp(`age: ${p.age}`).test(summary.text), `${id}: summary header carries the real age`);
  }
  console.log("\n      sample — baker's grounded summary:\n" + summaries.baker.split("\n").map((l) => "        " + l).join("\n"));

  // GROUNDED: each agent's summary surfaces ITS OWN relationships/role (the seeds), not a generic line.
  ok(/barista|Iris|coffee|bread/i.test(summaries.baker), "baker's summary is grounded in its real ties (barista/coffee/bread surface)");
  ok(/Cafe|gossip|coffee|Iris/i.test(summaries.barista), "barista's summary is grounded (the Cafe / its role surface)");
  ok(/smith|forge|Bran|mend/i.test(summaries.smith), "smith's summary is grounded (the forge / mending surface)");

  // DISTINCT: no two agents produce the same summary block (the generic-merchant-speak failure would collapse them)
  const blocks = ROSTER.map((id) => summaries[id]);
  ok(new Set(blocks).size === ROSTER.length, `all ${ROSTER.length} summaries are distinct blocks (no generic collapse)`);
  // and the baker's block does NOT read as the barista's (a targeted anti-collapse check)
  ok(summaries.baker !== summaries.barista && !/Iris the barista, the town barista/i.test(summaries.baker), "the baker does not read as the barista");
  // the non-merchant townsfolk read as grounded people too (the student's studies, the musician's pub, Sam's stories)
  ok(/college|dorm|coffee|Maria|sociology/i.test(summaries.student), "student's summary is grounded (the college/dorm/coffee surface)");
  ok(/Rose & Crown|pub|music|play|song/i.test(summaries.musician), "musician's summary is grounded (the pub/music surface)");
  ok(/pub|town|stories|Bran|old/i.test(summaries.regular), "regular's summary is grounded (the pub/old-town/stories surface)");

  // ---- 4b. S1-4: the non-merchant cast is well-formed (own no shop, no producer verb, cross-linked) ------
  console.log("\n[4b] S1-4 non-merchant townsfolk (student / musician / regular)");
  ok(TOWNSFOLK.length >= 3, `≥3 non-merchant townsfolk added (${TOWNSFOLK.length}: ${TOWNSFOLK.join(", ")})`);
  const PRODUCER_VERBS = new Set(["bake", "brew", "restock", "deliver", "forge"]);
  for (const id of TOWNSFOLK) {
    const p = personaFor(id);
    ok(p.shopId === "", `${id}: owns no shop (shopId === "")`);
    ok(!p.tools.some((t) => PRODUCER_VERBS.has(t)), `${id}: has NO producer verb (it doesn't make stock)`);
    ok(p.tools.includes("move_to") && p.tools.includes("talk_to") && p.tools.includes("sense"), `${id}: still perceives/moves/talks (core social verbs present)`);
    ok(p.buys.length > 0, `${id}: still has needs (buys ${p.buys.join("/")}) — participates as a consumer`);
  }
  // each townsperson is cross-linked to ≥1 MERCHANT and ≥1 other TOWNSPERSON (not an isolated clique)
  for (const id of TOWNSFOLK) {
    const refs = personaFor(id).relationships.map((r) => r.to);
    ok(refs.some((to) => MERCHANTS.includes(to)), `${id}: knows at least one merchant (ties into the existing cast)`);
    ok(refs.some((to) => TOWNSFOLK.includes(to) && to !== id), `${id}: knows at least one other townsperson (the cast cross-links)`);
  }
  // the concrete relationship triangle reads right (Klaus↔Maria friendship, Sam↔smith fifty years)
  ok(personaFor("student").relationships.some((r) => r.to === "musician" && /friend/i.test(r.tie)), "Klaus ↔ Maria are friends (a concrete townsfolk tie)");
  ok(personaFor("regular").relationships.some((r) => r.to === "smith" && /fifty years|go back/i.test(r.tie)), "Sam ↔ Bran the smith go back decades (townsperson ↔ merchant)");

  // ---- 5. seed text round-trips through persist (resumable grounding) ------------------------------------
  console.log("\n[5] seeded grounding survives a restart (durable)");
  const reload = new MemoryStream("baker", { dir, nowGameMin: () => 200 });
  const texts = reload.all().map((m) => m.text);
  ok(texts.some((t) => /inherited the Bakery/i.test(t)), "a specific seed fact ('inherited the Bakery') survived the restart");
  ok(reload.all().every((m) => m.importance === 6), "reloaded seeds keep their importance");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
