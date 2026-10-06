import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Complete } from "../cognition/llm.js";
import { extractUsage, type UsageSample } from "./runtime.js";

// The REAL Claude-backed `Complete` for cognition (the runtime half of the seam; cognition/ stays SDK-free
// + testable). It uses whatever auth the citizen process checked at startup (citizens/auth.ts). Single-shot, NO tools — used for cognition's internal reasoning (importance scoring,
// reflection synthesis, planning, summary), distinct from the citizen's tool-using action query.
//
// Degrade-don't-die: any error / empty stream → "" (callers treat empty as "no output" and fall back to a
// safe default). It NEVER throws into a tick. Verified at runtime only during the gated cognition run
// (it's the one cognition path that actually spends tokens).
export function makeClaudeComplete(defaultModel = "claude-haiku-4-5-20251001", onUsage?: (u: UsageSample) => void): Complete {
  return async (prompt, opts) => {
    try {
      let text = "";
      let resultMsg: unknown = null;
      const stream = query({
        prompt,
        options: {
          model: opts?.model ?? defaultModel,
          systemPrompt: opts?.system,
          maxTurns: 1,
          allowedTools: [],
          disallowedTools: ["Bash", "Edit", "Write", "Read", "WebSearch", "WebFetch"],
          settingSources: [], // hermetic — no repo CLAUDE.md / settings / skills
          maxBudgetUsd: 2.0, // per-call runaway guard (the fleet budget ceiling is the real bound)
        },
      }) as AsyncIterable<{
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
        result?: string;
      }>;
      for await (const msg of stream) {
        if (msg?.type === "assistant" && msg.message?.content) {
          for (const b of msg.message.content) if (b?.type === "text" && typeof b.text === "string") text += b.text;
        } else if (msg?.type === "result") {
          resultMsg = msg;
          if (typeof msg.result === "string" && !text) text = msg.result; // fallback to the final result text
        }
      }
      // W2b metering: surface this call's API-equiv cost so the citizen reports ALL cognition burn (reflection,
      // summary, importance, dialogue) to the fleet budget ceiling — not just the ACT turn. Never affects the text.
      if (onUsage && resultMsg) { const u = extractUsage(resultMsg); if (u) onUsage(u); }
      return text.trim();
    } catch {
      return ""; // degrade-don't-die: cognition treats "" as no-output
    }
  };
}
