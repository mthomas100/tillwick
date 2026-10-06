// SOCIAL STEP (town-alive B1/B2) — the ONE call citizen.ts makes after its ACT turn. Encapsulates the whole
// social pass that used to live inline in citizen.ts's try{} block (blocks 1-4), upgraded end-to-end:
//
//   1. IGNITION (citizens/ignition.ts): reply-mode (an inbound say from someone still beside me → I host a
//      real turn-taking dialogue NOW, engage forced — closing the #18 loop mechanically) + windowed host
//      election on co-location (kills the lower-id-only starvation that ate 2 of today's 3 sightings) +
//      per-pair cooldown/day-cap.
//   2. CONDITIONED DIALOGUE: the drive passes the RELATIONSHIP line (describeRelationship — paper §4.3.2's
//      "summarized memory about the partner") and a GOSSIP seed (GossipStore.pickToShare) into the situation;
//      a conversed summary carries the gossip wire (provenance chain) to the partner via the sim record.
//   3. OPINIONS (B2): after every real conversation BOTH sides re-assess their stated opinion of the other
//      (RelationshipGraph.assessOpinion — drift allowed, tiny metered call, degrade-keeps-prior).
//   4. GOSSIP BOOKKEEPING + THE BEAT: the teller marks the item shared and POSTs the `gossip-passed` event
//      {to, itemId, topic, gist, origin, chain} — the tape-visible diffusion record (paper's information
//      diffusion made mechanical; flightrecorder's schema). The hearer ingests the wire (chain preserved),
//      and a conversed summary with mentionedBelief but NO seeded wire becomes a tracked heard-belief
//      attributed to the partner — organically-arising rumors enter the diffusion graph too.
//   5. The existing partner-side dialogue ingest, trade tap, co-presence tap, and relationship→reflection
//      fold, unchanged in spirit from citizen.ts (A3/S0-2), now living here.
//
// SEAMS: every model call goes through the injected Complete (metered by the caller); the sim POSTs
// (dialogue record, /event) are injectable so the self-test runs with ZERO tokens and no sim. Degrade-don't-
// die: any hiccup shrinks the step, never throws into the tick.
//
// OWNERSHIP: this file + ignition.ts + gossip.ts are socialweaver's; citizen.ts (lifegiver's) constructs one
// SocialStep beside its RelationshipGraph and calls run() once per tick — see the hook-spec in the audit.

import { Mind } from "../cognition/mind.js";
import { RelationshipGraph, type DialogueSummaryLike } from "../cognition/relationships.js";
import { GossipStore, type GossipWire } from "../cognition/gossip.js";
import type { Complete } from "../cognition/llm.js";
import type { DialogueSummary, DialogueGossip } from "../cognition/dialogue.js";
import { maybeDriveDialogue } from "./dialogue-driver.js";
import { decideIgnition, PairSocialState, type HeardSay } from "./ignition.js";

const SIM = process.env.SIM_URL ?? "http://localhost:4042";

export type SocialStepOpts = {
  agentId: string;
  mind: Mind;
  graph: RelationshipGraph;
  nowGameMin: () => number;
  /** GossipStore dir override (tests). */
  gossipDir?: string;
  /** Memory dir override for the dialogue driver's partner-stream isolation (tests). */
  memoryDir?: string;
  /** Partner persona resolver (tests inject a minimal one). */
  personaFor?: (id: string) => string;
  /** POST a world event (default: POST {SIM}/event). Injectable for tests. */
  emitEvent?: (kind: string, payload: Record<string, unknown>) => Promise<void>;
  /** Record a closed dialogue (default: the driver's POST {SIM}/dialogue). Injectable for tests. */
  postRecord?: (summary: DialogueSummary) => Promise<void>;
  /** Ignition tunables (defaults: cooldown 30 game-min · 3/pair/day · 60 game-min election windows). */
  cooldownGameMin?: number;
  maxPerPairPerDay?: number;
  hostWindowGameMin?: number;
  /** Cap on dialogue length for live snappiness (passed to the driver). Default 4. */
  maxTurns?: number;
};

/** What run() needs from THIS tick: the PRE-ACT perception + the roster + the metered Complete.
 *  `tickId` (the citizen's tick counter) rides every beat so the tape can join beats to the tick's trace
 *  line (flightrecorder's shared-tickId vocabulary, D32). */
export type SocialTickInput = {
  perceived: Record<string, unknown>;
  enabledIds: string[];
  complete: Complete;
  tickId?: number;
};

export type SocialStepResult = {
  /** Partner I drove a dialogue with this tick (if any) + how it went. */
  drove?: { partner: string; mode: "reply" | "co-location"; outcome: "conversed" | "walk_by"; topic?: string };
  /** Dialogue ids ingested from the sim record this tick (partner side). */
  ingested: string[];
  /** gossip-passed beats emitted this tick. */
  gossipPassed: number;
  /** One-line log messages for the citizen's console. */
  log: string[];
};

export class SocialStep {
  readonly pairs = new PairSocialState();
  readonly gossip: GossipStore;
  private readonly processedDialogues = new Set<string>();
  private readonly processedTrades = new Set<string>();
  private readonly o: SocialStepOpts;

  constructor(opts: SocialStepOpts) {
    this.o = opts;
    this.gossip = new GossipStore(opts.agentId, {
      nowGameMin: opts.nowGameMin,
      ...(opts.gossipDir ? { dir: opts.gossipDir } : {}),
    });
  }

  /** The per-tick social pass. Never throws (every stage is guarded); returns what happened for logging. */
  async run(input: SocialTickInput): Promise<SocialStepResult> {
    const res: SocialStepResult = { ingested: [], gossipPassed: 0, log: [] };
    try {
      await this.driveIfIgnited(input, res);
    } catch (e) {
      res.log.push(`social drive (non-fatal): ${(e as Error).message}`);
    }
    try {
      await this.ingestRecorded(input, res);
    } catch (e) {
      res.log.push(`social ingest (non-fatal): ${(e as Error).message}`);
    }
    try {
      this.tapTradesAndCoPresence(input, res);
    } catch (e) {
      res.log.push(`social taps (non-fatal): ${(e as Error).message}`);
    }
    try {
      await this.foldReflection(res);
    } catch {
      /* reflection fold is garnish — never block */
    }
    return res;
  }

  /**
   * VOLITION (Pillar III "walks up to them"): who do I WANT to go tell something? The freshest gossip item
   * I haven't told anyone, paired with my most familiar relation who isn't already in its provenance.
   * Returns a prompt-ready line for the ACT prompt's volition branch (lifegiver hook-spec) or null. Pure.
   */
  volitionTarget(): { targetId: string; topic: string; line: string } | null {
    const item = this.gossip.freshestUnshared();
    if (!item) return null;
    const candidate = this.o.graph
      .topRelations(5, "familiar")
      .find((r) => r.other !== item.origin && !item.chain.includes(r.other) && !item.sharedWith.includes(r.other));
    if (!candidate) return null;
    return {
      targetId: candidate.other,
      topic: item.topic,
      line: `You want to tell ${candidate.other} about ${item.topic} (${item.gist}). If you're free, go find them and talk.`,
    };
  }

  // ---- stage 1: ignition → conditioned dialogue ---------------------------------------------------------

  private async driveIfIgnited(input: SocialTickInput, res: SocialStepResult): Promise<void> {
    const p = input.perceived;
    const gameMin = this.o.nowGameMin();
    const adjacentTo = strArray((p as { adjacentTo?: unknown }).adjacentTo);
    const inside = (p as { insideHere?: { occupants?: Array<{ id?: string }> } }).insideHere;
    const sameRoomIds = (inside?.occupants ?? []).map((o) => String(o?.id ?? "")).filter(Boolean);
    const heardRecently = ((p as { heardRecently?: unknown }).heardRecently ?? []) as HeardSay[];

    const decision = decideIgnition({
      selfId: this.o.agentId,
      gameMin,
      adjacentTo,
      sameRoomIds,
      heardRecently: Array.isArray(heardRecently) ? heardRecently : [],
      enabledIds: input.enabledIds,
      state: this.pairs,
      ...(this.o.cooldownGameMin !== undefined ? { cooldownGameMin: this.o.cooldownGameMin } : {}),
      ...(this.o.maxPerPairPerDay !== undefined ? { maxPerPairPerDay: this.o.maxPerPairPerDay } : {}),
      ...(this.o.hostWindowGameMin !== undefined ? { hostWindowGameMin: this.o.hostWindowGameMin } : {}),
    });

    // D32 — the ignition beat, EVERY evaluation, fired or not: the tape names the suppressor per candidate
    // (cooldown/capped/disabled/not-host…), so "why didn't X and Y talk this tick" is always answerable.
    // Fire-and-forget; never blocks the step.
    void this.emit("ignition", {
      ...(input.tickId !== undefined ? { tick: input.tickId } : {}),
      gameMin,
      decision: decision.attempt ? "fired" : "suppressed",
      ...(decision.attempt ? { mode: decision.mode, partner: decision.partner } : { reason: decision.reason }),
      candidates: decision.candidates,
    });

    if (!decision.attempt) return;

    const partner = decision.partner;
    // Where are we? (colors the situation — shop label beats generic street)
    const shop = (p as { currentShop?: { id?: string; label?: string } }).currentShop;
    const insideB = (p as { insideHere?: { buildingId?: string } }).insideHere?.buildingId;
    const place = shop?.label ?? shop?.id ?? insideB;
    const placeLine = place ? `You are both at ${place}.` : `You are both out on the street.`;
    const replyLine =
      decision.mode === "reply" && decision.sayText
        ? `${partner} just said to you: "${String(decision.sayText).slice(0, 180)}" — respond to that.`
        : "";
    const relationshipLine = this.o.graph.describeRelationship(partner);
    const seed = this.gossip.pickToShare(partner);

    res.log.push(
      decision.mode === "reply"
        ? `replying to ${partner} (they spoke to me)`
        : `co-located with ${partner} — my window to host`,
    );

    const dlg = await maybeDriveDialogue({
      selfMind: this.o.mind,
      adjacentTo: [...new Set([...adjacentTo, ...sameRoomIds])],
      partnerOverride: partner,
      complete: input.complete,
      nowGameMin: this.o.nowGameMin,
      maxTurns: this.o.maxTurns ?? 4,
      situation: [placeLine, replyLine].filter(Boolean).join(" "),
      relationshipLine,
      ...(seed ? { gossipSeed: { wire: seed.wire, seedLine: seed.seedLine } } : {}),
      // Reply-mode: they addressed me — answering is the human default, skip the TALK/PASS gate.
      ...(decision.mode === "reply" ? { forceEngage: true } : {}),
      ...(this.o.memoryDir ? { memoryDir: this.o.memoryDir } : {}),
      ...(this.o.personaFor ? { personaFor: this.o.personaFor } : {}),
      ...(this.o.postRecord ? { postRecord: this.o.postRecord } : {}),
    });

    if (decision.sayId) this.pairs.markAnswered(decision.sayId);
    if (!dlg.summary) return;
    const s = dlg.summary;
    this.processedDialogues.add(s.id);
    this.o.graph.ingestDialogueSummary(s as DialogueSummaryLike, this.o.agentId);
    this.pairs.noteConversed(partner, s.endedAtGameMin, { walkBy: s.outcome === "walk_by" });
    res.drove = { partner, mode: decision.mode, outcome: s.outcome, ...(s.topic ? { topic: s.topic } : {}) };

    if (s.outcome !== "conversed") return;
    res.log.push(`talked with ${partner} about "${s.topic}"${decision.mode === "reply" ? " (reply)" : ""}`);

    // Gossip actually passed → bookkeeping + the tape beat (the teller emits; the hearer only ingests).
    if (seed) {
      this.gossip.markShared(seed.item.id, partner);
      res.gossipPassed++;
      await this.emit("gossip-passed", {
        ...(input.tickId !== undefined ? { tick: input.tickId } : {}),
        to: partner,
        itemId: seed.wire.id,
        topic: seed.wire.topic,
        gist: seed.wire.gist,
        origin: seed.wire.origin,
        chain: seed.wire.chain,
      });
    } else if (s.mentionedBelief && s.topic) {
      // An organically-arising rumor (no seed, but the exchange carried a spreadable belief): track it,
      // attributed to the partner, so I can pass it on later with provenance.
      const lastFromPartner = [...s.transcript].reverse().find((u) => u.speaker === partner)?.text ?? s.topic;
      this.gossip.addHeardBelief(s.topic, lastFromPartner, partner);
    }

    // OPINION DRIFT (B2, my side — the partner's side runs in ingestRecorded on their process).
    await this.o.graph.assessOpinion(partner, input.complete, s.summaryFor[this.o.agentId]);
  }

  // ---- stage 2: partner-side ingest of recorded dialogues ------------------------------------------------

  private async ingestRecorded(input: SocialTickInput, res: SocialStepResult): Promise<void> {
    const recent = ((input.perceived as { recentDialogues?: unknown }).recentDialogues ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(recent)) return;
    for (const d of recent) {
      const id = String(d.id ?? "");
      if (!id || this.processedDialogues.has(id)) continue;
      this.processedDialogues.add(id);
      this.o.graph.ingestDialogueSummary(d as unknown as DialogueSummaryLike, this.o.agentId);
      res.ingested.push(id);

      const parts = strArray(d.participants);
      const other = parts.find((x) => x && x !== this.o.agentId);
      const endedAt = Number(d.endedAtGameMin ?? this.o.nowGameMin()) || this.o.nowGameMin();
      if (other) this.pairs.noteConversed(other, endedAt, { walkBy: d.outcome === "walk_by" });

      // My POV line → memory (explicit importance ⇒ token-free), as before.
      const pov = (d.summaryFor as Record<string, string> | undefined)?.[this.o.agentId];
      if (pov) await this.o.mind.observe(pov, { importance: 4 });

      // Gossip the partner passed ME: ingest with provenance (the chain's last teller isn't me).
      const wire = d.gossip as DialogueGossip | undefined;
      if (wire && wire.id && parts.includes(this.o.agentId) && wire.chain?.[wire.chain.length - 1] !== this.o.agentId) {
        this.gossip.ingest(wire as GossipWire);
        await this.o.mind.observe(
          `${wire.chain[wire.chain.length - 1] ?? other ?? "someone"} told me: ${wire.gist}`,
          { importance: 6 }, // a passed rumor competes in retrieval (the diffusion mechanic)
        );
      }

      // OPINION DRIFT (their side of B2): a conversation I was part of updates MY note on them too.
      if (other && d.outcome === "conversed") await this.o.graph.assessOpinion(other, input.complete, pov);
    }
  }

  // ---- stage 3: trade + co-presence taps (unchanged in spirit from citizen.ts A3/S0-2) -------------------

  private tapTradesAndCoPresence(input: SocialTickInput, res: SocialStepResult): void {
    const p = input.perceived;
    const trades = ((p as { recentTrades?: unknown }).recentTrades ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(trades)) {
      for (const t of trades) {
        const id = String(t.id ?? "");
        if (!id || this.processedTrades.has(id)) continue;
        this.processedTrades.add(id);
        const buyer = String(t.buyer ?? ""), seller = String(t.seller ?? "");
        if (buyer && seller && buyer !== seller) {
          this.o.graph.updateFromInteraction({
            kind: "trade", buyer, seller,
            item: String(t.item ?? "good"),
            priceUsdc: Number(t.priceUsdc ?? 0) || 0,
            atGameMin: this.o.nowGameMin(),
          });
        }
      }
    }
    const adjacentTo = strArray((p as { adjacentTo?: unknown }).adjacentTo);
    for (const peer of adjacentTo) {
      if (peer === this.o.agentId || peer === res.drove?.partner) continue;
      this.o.graph.updateFromInteraction({ kind: "copresence", participants: [this.o.agentId, peer], atGameMin: this.o.nowGameMin() });
    }
  }

  // ---- stage 4: relationships → reflection --------------------------------------------------------------

  private async foldReflection(res: SocialStepResult): Promise<void> {
    if (!res.drove && res.ingested.length === 0) return;
    const digest = this.o.graph.reflectionDigest(1);
    if (digest[0]) await this.o.mind.observe(digest[0], { importance: 3 });
  }

  private async emit(kind: string, payload: Record<string, unknown>): Promise<void> {
    try {
      if (this.o.emitEvent) return void (await this.o.emitEvent(kind, payload));
      await fetch(`${SIM}/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: this.o.agentId, kind, payload }),
      });
    } catch {
      /* the beat is best-effort; the gossip itself already moved */
    }
  }
}

function strArray(x: unknown): string[] {
  return Array.isArray(x) ? x.map((v) => String(v)).filter(Boolean) : [];
}

// ---- runnable stub self-test (ZERO tokens) ---------------------------------------------------------------
// `tsx citizens/social-step.ts` proves the town-alive acceptance bullets END-TO-END at the social-step level
// with stubComplete + injected recorders (no sim, no model):
//   • ignition → a REAL conversation on a synthetic co-location, on the host's first tick;
//   • heardRecently → a reply-mode conversation (election bypassed, once per say);
//   • gossip provenance A→B→C across TWO conversations + partner-side ingest, with gossip-passed beats
//     carrying chains [ada] then [ada,ben];
//   • opinions updated on both sides (drift via stubComplete's LIKE/DISLIKE line);
//   • the walk_by path stamps cooldown without polluting the graph.
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { stubComplete } = await import("../cognition/llm.js");
    const { electedHost } = await import("./ignition.js");

    const assert = (cond: unknown, msg: string) => {
      if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
    };

    const memoryDir = mkdtempSync(join(tmpdir(), "socialstep-mem-"));
    const gossipDir = mkdtempSync(join(tmpdir(), "socialstep-gossip-"));
    const relDir = mkdtempSync(join(tmpdir(), "socialstep-rel-"));
    let gameMin = 0;
    const now = () => gameMin;
    const persona = (id: string) => `${id}, a resident of the town.`;

    // A deterministic, ZERO-token stub covering every seam a social step touches.
    let lineNo = 0;
    const lines = ["Have you heard the news?", "No — tell me! [END]"];
    const complete = stubComplete((prompt: string) => {
      if (/TALK or PASS/.test(prompt)) return "TALK";
      if (/ONE short noun phrase/.test(prompt)) return "the smith's prices\nBELIEF: yes";
      if (/Say your next line/.test(prompt)) return lines[Math.min(lineNo++, lines.length - 1)];
      if (/LIKE|DISLIKE|NEUTRAL/.test(prompt)) return "LIKE: they always share the town news";
      if (/rate the likely poignancy/.test(prompt)) return "4";
      return "A friendly regular.";
    });

    const recorded: DialogueSummary[] = [];
    const beats: Array<{ actor: string; kind: string; payload: Record<string, unknown> }> = [];
    const mk = (id: string) => {
      const mind = new Mind({ agentId: id, persona: persona(id), complete, nowGameMin: now, dir: memoryDir });
      const graph = new RelationshipGraph(id, { dir: relDir, nowGameMin: now });
      const step = new SocialStep({
        agentId: id, mind, graph, nowGameMin: now,
        gossipDir, memoryDir, personaFor: persona,
        postRecord: async (s) => void recorded.push(s),
        emitEvent: async (kind, payload) => void beats.push({ actor: id, kind, payload }),
      });
      return { mind, graph, step };
    };

    const ada = mk("ada"), ben = mk("ben"), cara = mk("cara");
    // ada originates the rumor.
    ada.step.gossip.addLocal("smith price rise", "the smith raised nail prices this morning");

    // --- TICK 1 (ada's): ada+ben co-located; pick a window where ADA hosts → conversation + gossip pass ---
    let w = 0;
    while (electedHost("ada", "ben", w) !== "ada") w++;
    gameMin = w * 60;
    const t1 = await ada.step.run({
      perceived: { adjacentTo: ["ben"], currentShop: { id: "grocer", label: "Willows Market" } },
      enabledIds: ["ada", "ben", "cara"],
      complete,
      tickId: 1,
    });
    assert(t1.drove?.partner === "ben" && t1.drove.outcome === "conversed", "ada hosts and converses with ben on her first co-located tick");
    assert(recorded.length === 1 && recorded[0].gossip?.chain.join(",") === "ada", `dialogue record carries gossip chain [ada] (got ${JSON.stringify(recorded[0]?.gossip)})`);
    assert(typeof recorded[0].ts === "string" && recorded[0].ts.includes("T"), "flightrecorder ask: the dialogue record carries a wall-clock ts");
    assert(t1.gossipPassed === 1, "one gossip-passed beat");
    // D32: the ignition beat fires WITH the evaluation, before the gossip beat, carrying the tick + ledger.
    const ign1 = beats.find((b) => b.kind === "ignition");
    assert(!!ign1 && ign1.payload.decision === "fired" && ign1.payload.partner === "ben" && ign1.payload.tick === 1, "D32: fired ignition beat with tickId");
    assert(Array.isArray(ign1!.payload.candidates) && (ign1!.payload.candidates as Array<{ id: string; status: string }>)[0].status === "chosen", "D32: the beat carries the candidate ledger");
    const gp1 = beats.find((b) => b.kind === "gossip-passed");
    assert(!!gp1 && (gp1.payload.chain as string[]).join(",") === "ada" && gp1.payload.to === "ben", "beat: ada→ben, chain [ada]");
    assert(ada.graph.relationWith("ben")?.opinion?.stance === "like", "ada's opinion note on ben updated after the talk");

    // --- TICK 2 (ben's): ben ingests the recorded dialogue (sim ring → perceived.recentDialogues) ---
    gameMin += 5;
    const t2 = await ben.step.run({
      perceived: { adjacentTo: ["ada"], recentDialogues: [recorded[0] as unknown as Record<string, unknown>] },
      enabledIds: ["ada", "ben", "cara"],
      complete,
    });
    assert(t2.ingested.length === 1, "ben ingests the recorded dialogue once");
    assert(ben.step.gossip.get(recorded[0].gossip!.id)?.chain.join(",") === "ada", "ben now holds the rumor with chain [ada]");
    assert(ben.graph.relationWith("ada")?.dialogues === 1, "ben's graph gained the dialogue edge");
    assert(ben.graph.relationWith("ada")?.opinion?.stance === "like", "ben's opinion note on ada updated on ingest");
    // ben is now in cooldown with ada → no immediate re-drive (rate-limit sanity)…
    const beatsBefore = beats.length;
    const t2b = await ben.step.run({ perceived: { adjacentTo: ["ada"] }, enabledIds: ["ada", "ben", "cara"], complete, tickId: 7 });
    assert(!t2b.drove, "cooldown: ben does not immediately restart with ada");
    // …and D32 says the SILENT tick still explains itself on the tape.
    const silent = beats.slice(beatsBefore).find((b) => b.kind === "ignition" && b.actor === "ben");
    assert(!!silent && silent.payload.decision === "suppressed" && silent.payload.reason === "cooldown-or-capped", "D32: a silent tick emits a suppressed ignition beat");
    assert((silent!.payload.candidates as Array<{ id: string; status: string }>).some((c) => c.id === "ada" && c.status === "cooldown"), "D32: the silent beat names ada's cooldown");

    // --- TICK 3 (ben's): ben meets cara in a window where BEN hosts → the rumor travels on ---
    let w2 = Math.floor(gameMin / 60) + 1;
    while (electedHost("ben", "cara", w2) !== "ben") w2++;
    gameMin = w2 * 60;
    lineNo = 0;
    const t3 = await ben.step.run({
      perceived: { adjacentTo: ["cara"] },
      enabledIds: ["ada", "ben", "cara"],
      complete,
    });
    assert(t3.drove?.partner === "cara" && t3.drove.outcome === "conversed", "ben hosts cara in his window");
    assert(recorded.length === 2 && recorded[1].gossip?.chain.join(",") === "ada,ben", `record 2 carries chain [ada,ben] (got ${JSON.stringify(recorded[1]?.gossip)})`);
    const passBeats = beats.filter((b) => b.kind === "gossip-passed");
    assert(passBeats.length === 2 && (passBeats[1].payload.chain as string[]).join(",") === "ada,ben" && passBeats[1].payload.to === "cara", "beat 2: ben→cara, chain [ada,ben]");

    // --- TICK 4 (cara's): cara ingests → PROVENANCE A→B→C is in her store ---
    gameMin += 5;
    await cara.step.run({
      perceived: { recentDialogues: [recorded[1] as unknown as Record<string, unknown>] },
      enabledIds: ["ada", "ben", "cara"],
      complete,
    });
    const caraItem = cara.step.gossip.get(recorded[1].gossip!.id);
    assert(caraItem?.chain.join(",") === "ada,ben", `ACCEPTANCE — provenance A→B→C: cara's chain is [ada,ben] (got ${JSON.stringify(caraItem?.chain)})`);
    assert(caraItem?.origin === "ada", "origin survives two hops");

    // --- REPLY MODE: dana hears a say from an adjacent speaker → reply conversation, election bypassed ---
    const dana = mk("dana");
    // pick a window where dana would NOT host the dana/erin pair (proving reply ignores the election)
    let w3 = 0;
    while (electedHost("dana", "erin", w3) === "dana") w3++;
    gameMin = w3 * 60;
    lineNo = 0;
    const say = { id: "say-9", from: "erin", to: "dana", text: "Dana! Are you coming to the pub tonight?" };
    const t5 = await dana.step.run({
      perceived: { adjacentTo: ["erin"], heardRecently: [say] },
      enabledIds: ["dana", "erin"],
      complete,
    });
    assert(t5.drove?.partner === "erin" && t5.drove.mode === "reply" && t5.drove.outcome === "conversed", "ACCEPTANCE — heardRecently produces a real reply conversation");
    const t5b = await dana.step.run({
      perceived: { adjacentTo: ["erin"], heardRecently: [say] },
      enabledIds: ["dana", "erin"],
      complete,
    });
    assert(!t5b.drove, "the same say is not answered twice (answered + cooldown)");

    // --- volition: ben (holding an unshared-with-someone rumor? cara got it; ada is origin) ---
    // give ben a FRESH item nobody has heard → volitionTarget names his most familiar peer (ada or cara).
    ben.step.gossip.addLocal("pub quiz night", "the pub is running a quiz night on friday");
    const v = ben.step.volitionTarget();
    assert(!!v && (v.targetId === "ada" || v.targetId === "cara") && /pub quiz/.test(v.topic), `volition names a familiar target for fresh news (got ${JSON.stringify(v)})`);

    // --- walk_by: a PASS decision stamps cooldown but adds no dialogue edge ---
    const fred = mk("fred");
    const passComplete = stubComplete((prompt: string) =>
      /TALK or PASS/.test(prompt) ? "PASS" : /LIKE|DISLIKE|NEUTRAL/.test(prompt) ? "NEUTRAL: barely know them" : "ok",
    );
    let w4 = 0;
    while (electedHost("fred", "gina", w4) !== "fred") w4++;
    gameMin = w4 * 60;
    const t6 = await fred.step.run({ perceived: { adjacentTo: ["gina"] }, enabledIds: ["fred", "gina"], complete: passComplete });
    assert(t6.drove?.outcome === "walk_by", "PASS → walk_by recorded");
    assert((fred.graph.relationWith("gina")?.dialogues ?? 0) === 0 && (fred.graph.relationWith("gina")?.coPresences ?? 0) >= 1, "walk_by yields a co-presence, not a dialogue edge");
    const t6b = await fred.step.run({ perceived: { adjacentTo: ["gina"] }, enabledIds: ["fred", "gina"], complete: passComplete });
    assert(!t6b.drove, "walk_by cooldown: no immediate retry with the same neighbor");

    console.log("social-step.ts self-test: ALL ASSERTIONS PASSED (ignite-on-first-host-tick · reply-mode · A→B→C provenance across recorded dialogues · gossip-passed beats · opinion drift both sides · volition · walk_by cooldown)");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
