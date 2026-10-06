# Tillwick: notes for coding agents

A pixel-art town where each citizen is its own headless Claude Agent SDK session. Read README.md first;
the deeper design is in docs/design/ (architecture, economy, observability, the 2026-06-18 incident).

## Rules that keep the town safe (each one was learned the hard way)

- **The sim never calls an LLM.** `sim/` is the world authority and the single writer of
  `sim/data/events.jsonl`, `dialogue.jsonl` and the flight tape. Model calls live only in `citizens/`
  (through the injected `Complete` seam in `cognition/llm.ts`, so tests use `stubComplete`).
- **Every live run is bounded.** A duration is mandatory, the per-run $ ceiling (`FLEET_CEILING_USD`,
  default 5) stops it, and no connected browser means pause. Never start an unbounded fleet; after a
  run `pgrep -fl 'citizens/citizen.ts|spawn-fleet'` must be empty. See the incident post-mortem.
- **Auth defaults to `ANTHROPIC_API_KEY`** (citizens/auth.ts). A logged-in Claude subscription is an
  explicit opt-in (`TILLWICK_USE_CLAUDE_LOGIN=1` or `CLAUDE_CODE_OAUTH_TOKEN`) for personal local
  experiments only. Default citizen model: Haiku 4.5.
- **Never regenerate funded wallets.** `npm run gen-citizens` refuses to overwrite `citizens.local.json`;
  don't pass `--force` unless you mean to orphan every funded wallet. Keys live only in gitignored
  files (`.env`, `citizens.local.json`); never print or commit one.
- **x402 v2**, pinned `@x402/*@2.15.0`, network `eip155:84532` (Base Sepolia), facilitator
  `https://x402.org/facilitator`. Testnet only.
- **`tsx` does not hot-reload.** Restart `npm run sim` after editing `sim/*`, and curl the changed
  field before trusting a run.
- LimeZu art is proprietary: it stays in the gitignored `renderer/phaser/assets/limezu/`.

## Before you commit

`npx tsc --noEmit`, plus the zero-token drivers that touch your change (`sim/*.driver.ts`,
`cognition/*.driver.ts`, `citizens/*.driver.ts`, `scripts/verify-*.ts`). For UI work, check it in
`npm run replay-server`: it needs no model and no wallets.
