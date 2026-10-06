import type { Mind } from "./mind.js";
import type { Complete } from "./llm.js";

// TURN-TAKING 2-PARTY DIALOGUE (Park et al., Generative Agents, UIST '23, §4.3.2 "Conversations between
// agents") — when two agents co-locate, the architecture decides walk-by vs. converse, then generates a
// believable turn-taking conversation in which EACH utterance is conditioned on the speaker's identity
// (their cached [Agent's Summary Description]), the memories they retrieve as relevant to the OTHER agent /
// the topic, and the dialogue-so-far. The conversation ends naturally or at a turn cap, and is written back
// into BOTH agents' memory streams as observations so it feeds retrieval, reflection, and the relationship
// graph (sociologist's cognition/relationships.ts consumes the returned DialogueSummary as its primary
// "who talked to whom about what" signal).
//
// SEAM DISCIPLINE (llm.ts, INC-2026-06-18): NO SDK import. Every model call goes through the injected
// `Complete` (the real Claude-backed one is wired by the citizen runtime; tests inject stubComplete at ZERO
// token spend). We talk to each agent's cognition ONLY through the Mind public API (summary / contextFor /
// observe) — never its internals — so this module composes the W1 core without re-implementing it.
//
// DEGRADE-DON'T-DIE (the repo rule: world-tools getJson, run-state best-effort writes): every model call is
// best-effort. A thrown/empty Complete never throws out of holdDialogue — the conversation just gets shorter
// (an utterance that can't be generated ends the dialogue cleanly), and on a total failure to even start we
// return a `walk_by` summary. The caller (sim side-table) must always get a coherent DialogueSummary back.

// ---- the signal interface (agreed with sociologist — the relationship graph ingests this verbatim) -------

/** One spoken line in a dialogue, in order. */
export type Utterance = { speaker: string; text: string };

/** Gossip riding a conversation (town-alive B2 — the paper's information diffusion made mechanical).
 *  Structurally mirrors cognition/gossip.ts GossipWire (declared here, NOT imported, so dialogue.ts stays
 *  decoupled — the same pattern as relationships.ts DialogueSummaryLike). `chain` already ends with the
 *  teller. The driver seeds it via opts.gossipSeed; a CONVERSED summary carries it verbatim so (a) the
 *  partner's side ingests it with full provenance from the sim's dialogue record, and (b) the harness can
 *  trace diffusion. Attached mechanically on outcome "conversed" — the situation line primes the teller to
 *  actually say it, but the RECORD is the guarantee (diffusion must not depend on transcript parsing). */
export type DialogueGossip = { id: string; topic: string; gist: string; origin: string; chain: string[] };

/**
 * The structured record emitted ONCE at conversation close — the handoff to the relationship graph and the
 * durable side-table record (sim writes it to sim/data/dialogue-*.jsonl, replayable on restart). It is a
 * superset of what relationships.ts needs: `participants` is the edge, `outcome` gates whether to bump
 * familiarity (only "conversed"), `turns` is engagement depth, `topic` is what the edge is "about", and
 * `endedAtGameMin` drives recency. `summaryFor` carries each agent's own-POV one-liner (also the exact text
 * stored into their memory stream), and `transcript` backs the activity feed / inspector.
 */
export type DialogueSummary = {
  id: string; // stable conversation id: `dlg:${a}:${b}:${startedAtGameMin}` (participants sorted)
  /** WALL-CLOCK close time (ISO). flightrecorder's run key: the game clock has been RESET across runs, so
   *  gameMin ranges from different runs overlap and can't scope dialogue.jsonl lines — wall ts can. Stamped
   *  at close for BOTH outcomes. (Old-format lines lack it; readers must tolerate absence.) */
  ts?: string;
  participants: [string, string]; // [agentA, agentB], sorted so the pair key is stable
  turns: number; // number of utterances actually spoken (0 for a pure walk-by)
  startedAtGameMin: number;
  endedAtGameMin: number;
  outcome: "conversed" | "walk_by"; // walk_by = co-located but chose not to (or couldn't) engage
  topic: string; // one short NL phrase, model-distilled ("the cafe sale", "bread prices")
  summaryFor: Record<string, string>; // per-participant one-liner from THAT agent's POV (also stored as memory)
  transcript: Utterance[]; // ordered utterances (for the feed / inspector)
  // Information-diffusion signal (docs/design/architecture.md §4, paper Fig 9): true if a diffusable belief — a sale,
  // shortage, party/event, or other tradeable rumor — came up. Distilled FREE in the same topic call (no
  // extra model round-trip). Lets the experiment harness measure belief spread agent→agent through dialogue.
  // Optional + best-effort: undefined when not engaged / on a model hiccup. The relationship graph ignores
  // it; the harness reads it. Only present (and only ever true) on outcome "conversed".
  mentionedBelief?: boolean;
  // Gossip PASSED in this conversation (only when the driver seeded one AND the pair actually conversed).
  // The partner-side ingest reads this off the sim's dialogue record; the teller emits the `gossip-passed`
  // beat. Absent on walk_by / unseeded conversations. ADDITIVE — consumers that don't know it ignore it.
  gossip?: DialogueGossip;
};

// ---- options --------------------------------------------------------------------------------------------

export type DialogueOpts = {
  /** The sim game clock (game-minutes) — stamps the conversation window + the memories written back, the
   *  same clock the agents' Minds use. Passed explicitly (the established seam pattern: retrieve / buildSummary
   *  / reflect all take nowGameMin) rather than reaching into Mind's private clock. Defaults to () => 0 so a
   *  pure-unit dialogue still runs. The citizen/sim caller injects the real run-state clock. */
  nowGameMin?: () => number;
  /** Why they're co-located / what's salient right now — seeds the walk-by-vs-converse call and retrieval.
   *  e.g. "You are both standing outside Hobbs Cafe on Main Street." Optional; "" is fine. */
  situation?: string;
  /** Hard ceiling on utterances so a dialogue always terminates (the paper caps conversation length).
   *  Default 8 (≈4 exchanges) — enough to be believable, cheap enough for a live sim. */
  maxTurns?: number;
  /** Working-set size for each speaker's per-utterance memory retrieval (Mind.contextFor k). Default 6 —
   *  a conversation needs the few most-relevant memories about the other agent/topic, not the whole stream. */
  retrieveK?: number;
  /** Force the engagement decision (skip the walk-by-vs-converse model call). Handy for tests / scenarios
   *  that want a guaranteed conversation. Omit to let the model decide. */
  forceEngage?: boolean;
  /** Which agents' memory streams to fold the closed dialogue back into. CROSS-PROCESS SAFETY (W2b live
   *  driver): in the live fleet each agent runs in its OWN process and owns its OWN sim/data/memory/<id>.jsonl;
   *  a second process appending to a partner's file would RACE its writer. So the citizen-side driver
   *  constructs the partner's Mind READ-ONLY (to condition utterances) and passes "initiator" here, writing
   *  ONLY `a`'s (the initiator's) stream — the partner learns of the conversation via the sim's dialogue
   *  record on its next tick (the existing gossip/feed channel). "both" (default) is the in-process / test
   *  behavior (the paper folds it into both). "none" writes neither (e.g. a pure dry-run). `a` is always the
   *  initiator, so "initiator" === write a only. */
  persistMemoryFor?: "both" | "initiator" | "none";
  /** Gossip the initiator intends to pass in this conversation (town-alive B2). The driver builds it from
   *  its GossipStore (chain ends with the initiator) and ALSO folds the tell-intent into `situation` so the
   *  model actually says it; when the pair converses, the summary carries it verbatim (see
   *  DialogueSummary.gossip). Ignored on walk_by. */
  gossipSeed?: DialogueGossip;
};

// A natural-close sentinel the speaker can emit to end the conversation believably (a goodbye). Matched
// case-insensitively as a substring so "Okay, [END]" or "[end]" both close. Kept out of the stored text.
const CLOSE_TOKEN = "[END]";
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_RETRIEVE_K = 6;

// ---- public API -----------------------------------------------------------------------------------------

/**
 * Decide whether two co-located agents converse or walk by, and if they converse, run a turn-taking dialogue
 * and write it back into both memory streams. Returns the DialogueSummary either way (outcome === "walk_by"
 * with 0 turns when they don't engage).
 *
 * `a` speaks first (the initiator). Each agent is identified by `mind.stream.agentId`. Best-effort end to
 * end: any model hiccup shortens or skips the conversation rather than throwing.
 */
export async function holdDialogue(
  a: Mind,
  b: Mind,
  complete: Complete,
  opts: DialogueOpts = {},
): Promise<DialogueSummary> {
  const aId = a.stream.agentId;
  const bId = b.stream.agentId;
  const nowGameMin = opts.nowGameMin ?? (() => 0);
  const startedAtGameMin = nowGameMin();
  const situation = (opts.situation ?? "").trim();
  const maxTurns = Math.max(0, opts.maxTurns ?? DEFAULT_MAX_TURNS);
  const k = opts.retrieveK ?? DEFAULT_RETRIEVE_K;

  // participants sorted → stable pair key / conversation id regardless of who initiated.
  const participants = [aId, bId].sort() as [string, string];
  const id = `dlg:${participants[0]}:${participants[1]}:${startedAtGameMin}`;

  const base: Omit<DialogueSummary, "turns" | "endedAtGameMin" | "outcome" | "topic" | "summaryFor" | "transcript"> = {
    id,
    ts: new Date().toISOString(), // wall-clock run key (see the field doc)
    participants,
    startedAtGameMin,
  };

  // --- 1. walk-by vs. converse (the architecture's decision; paper §4.3.2) ---
  let engage = opts.forceEngage === true;
  if (!engage && opts.forceEngage !== false) {
    engage = await decideEngage(a, b, complete, situation, k);
  }
  if (!engage) {
    return {
      ...base,
      turns: 0,
      endedAtGameMin: startedAtGameMin,
      outcome: "walk_by",
      topic: "",
      summaryFor: { [aId]: "", [bId]: "" },
      transcript: [],
    };
  }

  // --- 2. turn-taking generation ---
  const transcript: Utterance[] = [];
  // Speakers alternate starting with `a`. Each turn the current speaker conditions on: their own summary,
  // memories they retrieve as relevant to the OTHER agent + the situation, and the dialogue-so-far.
  const minds: Record<string, Mind> = { [aId]: a, [bId]: b };
  const order = [aId, bId];
  for (let t = 0; t < maxTurns; t++) {
    const speakerId = order[t % 2];
    const listenerId = speakerId === aId ? bId : aId;
    const line = await nextUtterance(minds[speakerId], listenerId, complete, situation, transcript, k);
    if (line === null) break; // model failed to produce a line → end the conversation cleanly
    const closing = isClose(line);
    const spoken = stripClose(line);
    if (spoken) transcript.push({ speaker: speakerId, text: spoken });
    if (closing) break; // natural goodbye → end
  }

  const endedAtGameMin = nowGameMin();

  // A conversation that produced no actual lines (e.g. the model immediately closed / kept failing) is a
  // walk-by in effect — don't manufacture an empty "conversation" for the relationship graph.
  if (transcript.length === 0) {
    return {
      ...base,
      turns: 0,
      endedAtGameMin,
      outcome: "walk_by",
      topic: "",
      summaryFor: { [aId]: "", [bId]: "" },
      transcript: [],
    };
  }

  // --- 3. distill topic (+ the diffusion belief-flag, same call) + per-agent POV summaries, then write
  //         back into BOTH memory streams ---
  const { topic, mentionedBelief } = await distillTopic(complete, aId, bId, transcript);
  const summaryFor: Record<string, string> = {
    [aId]: povLine(aId, bId, topic, transcript),
    [bId]: povLine(bId, aId, topic, transcript),
  };

  // Store the conversation as an observation in each agent's stream (the paper folds the dialogue back into
  // memory so it feeds retrieval / reflection / relationships). Best-effort: Mind.observe degrades internally
  // (importance scoring falls back), and we never let a storage hiccup throw out of the dialogue.
  // CROSS-PROCESS SAFETY (persistMemoryFor): the live driver passes "initiator" so we write ONLY `a` and never
  // append to the partner's real stream file (which its own process owns) — see DialogueOpts.persistMemoryFor.
  const persist = opts.persistMemoryFor ?? "both";
  if (persist === "both" || persist === "initiator") await safeObserve(a, summaryFor[aId]);
  if (persist === "both") await safeObserve(b, summaryFor[bId]);

  return {
    ...base,
    turns: transcript.length,
    endedAtGameMin,
    outcome: "conversed",
    topic,
    summaryFor,
    transcript,
    mentionedBelief,
    // gossip rides ONLY a real conversation (a walk-by passed nothing). Verbatim from the seed — the
    // provenance chain is the driver's/store's business; dialogue.ts is just the carrier.
    ...(opts.gossipSeed ? { gossip: opts.gossipSeed } : {}),
  };
}

// ---- internals ------------------------------------------------------------------------------------------

// Ask the initiator whether it's worth stopping to talk to the other agent right now (vs. a walk-by). The
// decision is conditioned on the initiator's summary + memories relevant to the other agent. Degrade: any
// failure / unparseable reply → DON'T engage (the conservative, cheaper choice — a missed hello is harmless;
// a spurious conversation spends tokens and pollutes the relationship graph).
async function decideEngage(
  a: Mind,
  b: Mind,
  complete: Complete,
  situation: string,
  k: number,
): Promise<boolean> {
  const aId = a.stream.agentId;
  const bId = b.stream.agentId;
  let summary = aId;
  let context = "";
  try {
    summary = await a.summary();
    context = await a.contextFor(retrievalSeed(bId, situation), k);
  } catch {
    /* degrade: decide on the header alone */
  }
  const prompt =
    `${summary}\n\n` +
    `You have just come face to face with ${bId}.` +
    (situation ? ` ${situation}` : "") +
    `\nWhat you remember that's relevant to ${bId} right now:\n${context || "(nothing in particular)"}\n\n` +
    `Would you stop to talk with ${bId}, or just pass by? Answer with a single word: TALK or PASS.`;
  let raw = "";
  try {
    raw = await complete(prompt, {
      system: "Decide if the agent stops to converse. Reply with exactly one word: TALK or PASS.",
      maxTokens: 4,
    });
  } catch {
    return false; // degrade-don't-die: a model hiccup → walk by
  }
  return /\btalk\b/i.test(raw || "");
}

// Generate the current speaker's next line, conditioned on their summary + memories relevant to the listener
// and the dialogue-so-far. Returns the raw line (may carry the CLOSE_TOKEN), or null if the model produced
// nothing / threw (the caller ends the conversation on null). The speaker is told they MAY end with the
// close token when the exchange has run its course — that's how a dialogue terminates naturally.
async function nextUtterance(
  speaker: Mind,
  listenerId: string,
  complete: Complete,
  situation: string,
  transcript: Utterance[],
  k: number,
): Promise<string | null> {
  const speakerId = speaker.stream.agentId;
  let summary = speakerId;
  let context = "";
  try {
    summary = await speaker.summary();
    context = await speaker.contextFor(retrievalSeed(listenerId, situation, transcript), k);
  } catch {
    /* degrade: speak from the header alone */
  }
  const soFar = renderTranscript(transcript) || "(the conversation hasn't started yet)";
  const prompt =
    `${summary}\n\n` +
    `You (${speakerId}) are having a conversation with ${listenerId}.` +
    (situation ? ` ${situation}` : "") +
    `\nWhat you remember that's relevant to ${listenerId} / this conversation:\n${context || "(nothing in particular)"}\n\n` +
    `Conversation so far:\n${soFar}\n\n` +
    `Say your next line to ${listenerId} — ONE short, natural sentence in your own voice. ` +
    `If the conversation has reached a natural end, say a brief goodbye and append ${CLOSE_TOKEN}. ` +
    `Reply with only what you say (no name prefix).`;
  let raw = "";
  try {
    raw = await complete(prompt, {
      system: `You are ${speakerId}, speaking naturally in a brief conversation. Output only your spoken line.`,
      maxTokens: 80,
    });
  } catch {
    return null; // degrade-don't-die: a failed line ends the conversation
  }
  const line = (raw || "").trim();
  return line ? line : null;
}

// Distill a one-phrase topic AND the diffusion belief-flag from the transcript in ONE model call (no extra
// round-trip — the flag rides along with the topic the dialogue already needs). Reply shape:
//   <topic noun phrase>
//   BELIEF: yes|no
// Degrade: on failure / unparseable → topic "a brief chat", mentionedBelief false (the conservative default —
// don't claim a belief spread that we couldn't confirm). Cheap (maxTokens tiny).
async function distillTopic(
  complete: Complete,
  aId: string,
  bId: string,
  transcript: Utterance[],
): Promise<{ topic: string; mentionedBelief: boolean }> {
  const body = renderTranscript(transcript);
  const prompt =
    `A short conversation between ${aId} and ${bId}:\n\n${body}\n\n` +
    `Reply with EXACTLY two lines:\n` +
    `1) ONE short noun phrase naming what it was about (≤6 words, no sentence, no trailing punctuation).\n` +
    `2) "BELIEF: yes" if a spreadable piece of news was discussed — a sale/discount, a shortage/stockout, ` +
    `a party or event, or a rumor about prices/goods — otherwise "BELIEF: no".`;
  let raw = "";
  try {
    raw = await complete(prompt, {
      system:
        "Line 1: a single short noun phrase (the conversation topic). Line 2: exactly 'BELIEF: yes' or 'BELIEF: no'.",
      maxTokens: 24,
    });
  } catch {
    return { topic: "a brief chat", mentionedBelief: false };
  }
  return parseTopic(raw);
}

// Parse distillTopic's two-line reply into { topic, mentionedBelief }. Tolerant: the topic is the first
// non-"BELIEF:" line; the flag is true only on an explicit affirmative ("BELIEF: yes"/"yes"/"true"). Missing
// or garbled → the safe defaults ("a brief chat", false).
export function parseTopic(raw: string): { topic: string; mentionedBelief: boolean } {
  const lines = (raw || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let topicLine = "";
  let beliefLine = "";
  for (const l of lines) {
    if (/^belief\s*:/i.test(l)) beliefLine = l;
    else if (!topicLine) topicLine = l;
  }
  // Strip an enumerator ("1)" / "1." / "-") and any trailing sentence punctuation off the topic phrase.
  const topic =
    topicLine
      .replace(/^\s*\d+[).]\s*/, "")
      .replace(/^[-*]\s*/, "")
      .replace(/[.?!]+$/, "")
      .slice(0, 80)
      .trim() || "a brief chat";
  const mentionedBelief = /\b(yes|true)\b/i.test(beliefLine);
  return { topic, mentionedBelief };
}

// The exact observation text stored in `self`'s memory stream (and surfaced as summaryFor[self]) — written
// from self's point of view, mentioning the other agent, the topic, and what the other last said, so it
// reads like a remembered interaction and feeds retrieval/reflection believably.
function povLine(selfId: string, otherId: string, topic: string, transcript: Utterance[]): string {
  const lastFromOther = [...transcript].reverse().find((u) => u.speaker === otherId);
  const tail = lastFromOther ? ` ${otherId} said: "${truncate(lastFromOther.text, 140)}"` : "";
  return `I talked with ${otherId} about ${topic}.${tail}`.trim();
}

// Build the retrieval query a speaker uses to pull memories relevant to the OTHER agent + the current topic.
// Seeds with the other agent's id and the situation; once the conversation is underway, the latest line the
// other agent said sharpens relevance toward what's actually being discussed.
function retrievalSeed(otherId: string, situation: string, transcript: Utterance[] = []): string {
  const lastFromOther = [...transcript].reverse().find((u) => u.speaker === otherId);
  return [otherId, situation, lastFromOther?.text ?? ""].filter(Boolean).join(" ").trim() || otherId;
}

// Render the running transcript as "<speaker>: <text>" lines for the prompt.
function renderTranscript(transcript: Utterance[]): string {
  return transcript.map((u) => `${u.speaker}: ${u.text}`).join("\n");
}

// Does this line carry the natural-close sentinel? (case-insensitive substring)
function isClose(line: string): boolean {
  return line.toLowerCase().includes(CLOSE_TOKEN.toLowerCase());
}

// Strip the close sentinel (and any trailing whitespace it leaves) from a spoken line.
function stripClose(line: string): string {
  const re = new RegExp(CLOSE_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return line.replace(re, "").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Best-effort write of one observation into an agent's stream. Mind.observe is itself best-effort
// (importance scoring degrades), but guard the await so a storage/scoring throw can't escape the dialogue.
async function safeObserve(mind: Mind, text: string): Promise<void> {
  const body = (text || "").trim();
  if (!body) return;
  try {
    await mind.observe(body);
  } catch {
    /* never let folding the dialogue back into memory crash the conversation */
  }
}

// ---- runnable stub self-test (ZERO tokens) --------------------------------------------------------------
// `tsx cognition/dialogue.ts` runs two synthetic Minds with seeded memories through a turn-taking dialogue
// using stubComplete (no SDK, no model, no network beyond the local embeddings retrieval MAY load — which
// degrades to relevance=0 if unavailable, so the test still passes). Asserts: turns alternate a→b→a…, both
// streams receive the dialogue memory, the DialogueSummary is coherent, the close token terminates, and the
// walk-by path returns a 0-turn "walk_by". Mirrors the contract's zero-token validation.
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Mind } = await import("./mind.js");
    const { stubComplete } = await import("./llm.js");

    const assert = (cond: boolean, msg: string) => {
      if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
    };

    const dir = mkdtempSync(join(tmpdir(), "dialogue-selftest-"));
    let gameMin = 600;
    const now = () => gameMin;

    // Two minds. stubComplete is shared but BRANCHES on the prompt so each seam is deterministic and free.
    // We hand-script a 4-line exchange that closes on the 4th line, so we can assert alternation + close.
    let utterTurn = 0;
    const lines = [
      "Hi Klaus, did you hear the bakery is having a sale today?", // isabella (turn 0)
      "Oh really? I should grab some bread then, thanks Isabella.", // klaus    (turn 1)
      "Yes, half price until noon — you should hurry!", // isabella (turn 2)
      `Will do — see you around! ${CLOSE_TOKEN}`, // klaus    (turn 3, closes)
    ];
    const complete = stubComplete((prompt) => {
      if (/TALK or PASS/.test(prompt)) return "TALK"; // engage decision → converse
      // topic distillation: two-line reply (topic + the diffusion belief-flag). A sale IS a spreadable belief.
      if (/ONE short noun phrase/.test(prompt)) return "the bakery sale\nBELIEF: yes";
      if (/Say your next line/.test(prompt)) {
        const out = lines[Math.min(utterTurn, lines.length - 1)];
        utterTurn++;
        return out;
      }
      if (/rate the likely poignancy/.test(prompt)) return "4"; // importance scoring (observe)
      // agent-summary facet calls (buildSummary) — echo something harmless
      return "A friendly Main Street regular.";
    });

    const isabella = new Mind({ agentId: "isabella", persona: "Isabella, runs Hobbs Cafe.", complete, nowGameMin: now, dir });
    const klaus = new Mind({ agentId: "klaus", persona: "Klaus, a sociology student.", complete, nowGameMin: now, dir });
    await isabella.observe("Isabella knows Klaus is a regular who likes fresh bread.", { importance: 5 });
    await klaus.observe("Klaus often buys bread in the mornings.", { importance: 5 });

    const isaBefore = isabella.size();
    const klausBefore = klaus.size();

    const summary = await holdDialogue(isabella, klaus, complete, {
      nowGameMin: now,
      situation: "You are both standing outside Hobbs Cafe on Main Street.",
      maxTurns: 8,
    });

    // --- assertions: a real conversation happened, turns alternate, it closed on the goodbye ---
    assert(summary.outcome === "conversed", "engaged → outcome conversed");
    assert(summary.turns === 4, `four lines spoken (got ${summary.turns})`);
    assert(summary.transcript[0].speaker === "isabella", "isabella (initiator) speaks first");
    assert(summary.transcript[1].speaker === "klaus", "klaus speaks second (alternation)");
    assert(summary.transcript[2].speaker === "isabella", "isabella speaks third (alternation)");
    assert(summary.transcript[3].speaker === "klaus", "klaus speaks fourth (alternation)");
    assert(
      summary.transcript.every((u, i) => u.speaker === (i % 2 === 0 ? "isabella" : "klaus")),
      "strict a→b→a→b turn-taking",
    );
    assert(!summary.transcript[3].text.includes(CLOSE_TOKEN), "close sentinel is stripped from stored text");
    assert(summary.transcript[3].text.includes("see you around"), "the closing line's words are kept");
    assert(summary.topic === "the bakery sale", "topic distilled from the transcript");
    // --- information-diffusion flag: a sale is a spreadable belief → mentionedBelief true (same call as topic) ---
    assert(summary.mentionedBelief === true, "mentionedBelief true when a sale/belief is discussed");

    // --- stable id + sorted participants (independent of who initiated) ---
    assert(summary.participants[0] === "isabella" && summary.participants[1] === "klaus", "participants sorted");
    assert(summary.id === `dlg:isabella:klaus:600`, `stable conversation id (got ${summary.id})`);
    assert(summary.startedAtGameMin === 600 && summary.endedAtGameMin === 600, "game-minute window stamped");

    // --- per-agent POV summaries name the OTHER agent + the topic ---
    assert(/klaus/i.test(summary.summaryFor["isabella"]) && /bakery sale/i.test(summary.summaryFor["isabella"]), "isabella's POV mentions klaus + topic");
    assert(/isabella/i.test(summary.summaryFor["klaus"]) && /bakery sale/i.test(summary.summaryFor["klaus"]), "klaus's POV mentions isabella + topic");

    // --- the dialogue is folded back into BOTH memory streams (feeds retrieval/reflection/relationships) ---
    assert(isabella.size() === isaBefore + 1, "isabella's stream gained the dialogue memory");
    assert(klaus.size() === klausBefore + 1, "klaus's stream gained the dialogue memory");
    const isaMem = isabella.stream.recent(1)[0];
    assert(/klaus/i.test(isaMem.text), "isabella's newest memory is about klaus");

    // --- persistMemoryFor:"initiator" (W2b CROSS-PROCESS SAFETY): writes ONLY the initiator's stream ---
    // The live driver constructs the partner READ-ONLY and must NOT append to the partner's real .jsonl.
    // (Advance the game clock so the POV observation isn't an exact-recent duplicate of an earlier run's.)
    gameMin = 700;
    utterTurn = 0;
    const isaOnlyBefore = isabella.size();
    const klausOnlyBefore = klaus.size();
    const initOnly = await holdDialogue(isabella, klaus, complete, { nowGameMin: now, maxTurns: 8, persistMemoryFor: "initiator" });
    assert(initOnly.outcome === "conversed", "initiator-only run still converses");
    assert(isabella.size() === isaOnlyBefore + 1, "persistMemoryFor:initiator writes the initiator's stream");
    assert(klaus.size() === klausOnlyBefore, "persistMemoryFor:initiator does NOT write the partner's stream (no cross-process append)");
    // --- persistMemoryFor:"none" writes neither ---
    gameMin = 800;
    utterTurn = 0;
    const isaNoneBefore = isabella.size();
    const klausNoneBefore = klaus.size();
    const noneRun = await holdDialogue(isabella, klaus, complete, { nowGameMin: now, maxTurns: 8, persistMemoryFor: "none" });
    assert(noneRun.outcome === "conversed", "none run still converses + returns a full summary");
    assert(isabella.size() === isaNoneBefore && klaus.size() === klausNoneBefore, "persistMemoryFor:none writes neither stream");
    gameMin = 600; // restore for any later assertions that assume the original clock

    // --- initiator-order independence: swap who initiates, same pair key + id ---
    utterTurn = 0;
    const summary2 = await holdDialogue(klaus, isabella, complete, { nowGameMin: now, situation: "Outside the cafe.", maxTurns: 8 });
    assert(summary2.id === `dlg:isabella:klaus:600`, "pair id is initiator-order-independent");
    assert(summary2.transcript[0].speaker === "klaus", "when klaus initiates, klaus speaks first");

    // --- walk-by path: a PASS decision yields a 0-turn walk_by with no memories written ---
    const passComplete = stubComplete((prompt) => (/TALK or PASS/.test(prompt) ? "PASS" : "A friendly regular."));
    const isaBefore2 = isabella.size();
    const walk = await holdDialogue(isabella, klaus, passComplete, { nowGameMin: now, situation: "Passing on the street." });
    assert(walk.outcome === "walk_by", "PASS → walk_by");
    assert(walk.turns === 0 && walk.transcript.length === 0, "walk_by has no turns");
    assert(isabella.size() === isaBefore2, "walk_by writes no memory");
    assert(walk.mentionedBelief === undefined, "walk_by carries no belief flag (only present on conversed)");

    // --- forceEngage bypasses the decision; an immediate close yields a walk_by (no real lines) ---
    utterTurn = 0;
    const immediateClose = stubComplete((prompt) => {
      if (/Say your next line/.test(prompt)) return CLOSE_TOKEN; // closes before saying anything
      if (/ONE short noun phrase/.test(prompt)) return "nothing";
      return "x";
    });
    const empty = await holdDialogue(isabella, klaus, immediateClose, { nowGameMin: now, forceEngage: true, maxTurns: 8 });
    assert(empty.outcome === "walk_by" && empty.turns === 0, "engaged but no lines spoken → treated as walk_by");

    // --- parseTopic unit-check: the diffusion flag is true ONLY on an explicit affirmative; defaults are safe ---
    assert(parseTopic("the festival\nBELIEF: yes").mentionedBelief === true, "BELIEF: yes → true");
    assert(parseTopic("bread prices\nBELIEF: no").mentionedBelief === false, "BELIEF: no → false");
    assert(parseTopic("just a greeting").mentionedBelief === false, "no BELIEF line → false (safe default)");
    assert(parseTopic("").topic === "a brief chat", "empty reply → fallback topic");
    assert(parseTopic("1) the cafe sale\nBELIEF: yes").topic === "the cafe sale", "strips a numeric enumerator from the topic");
    assert(parseTopic("the party.\nBELIEF: yes").topic === "the party", "strips trailing sentence punctuation");

    console.log("dialogue.ts self-test: ALL ASSERTIONS PASSED");
    console.log("---\nsample DialogueSummary:\n" + JSON.stringify(summary, null, 2));
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
