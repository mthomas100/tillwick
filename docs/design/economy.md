# Tillwick — the x402 economy layer

How Tillwick's citizens hold money, run shops, and pay each other: per-citizen wallets, shops as x402
sellers, the `buy` primitive, the purchase guard, custody tied to settlement hashes, and the treasury
stipend that funds it all. Everything is **testnet only** (USDC on Base Sepolia) and **localhost only**.
For the town, cognition and safety governor around it, see [architecture.md](architecture.md).

> **History note.** This layer was designed first, for a 5-citizen town on Sonnet 4.6 with a plain
> canvas renderer. The economy described here is what shipped and is still load-bearing; the town
> around it has since moved to Haiku citizens, a Phaser + Tiled renderer and a larger roster.

---

## 1. Process shape

Three kinds of process on `localhost`, following a16z **AI Town**'s discipline (the sim authority never
calls an LLM; LLM work happens off the hot loop; conversations live in side tables):

```
  RENDERER (browser, read-only) ◀── WS world snapshots ── SIM-SERVER :4042  (the authority; never calls an LLM)
                                                            ▲   GET /perceive · POST /act · POST /event
                                                            │   appends every economic/social event to
                                                            │   sim/data/events.jsonl (the ledger)
                                                            │
  CITIZEN processes (one per citizen) ────────────────────────┘
   • Claude Agent SDK query() per tick (ANTHROPIC_API_KEY by default)
   • in-process MCP "world" tools: look · move · talk · enterShop · evaluate_purchase · buy · consume …
   • its OWN viem wallet; the purchase GUARD runs before every pay()
        │  x402 GET (free shelf read + paid buy)
        ▼
  SHOPS = x402 sellers (express)  :4031 bakery · :4032 cafe · :4033 grocer · :4034 depot · :4035 smithy
   • GET /shop            → catalog + stock (FREE)
   • GET /shop/buy/:good  → PAID at the good's price; payTo = the OWNING citizen's wallet
        │  verify/settle (EIP-3009, gasless)
        ▼
  x402 facilitator (https://x402.org/facilitator, keyless) ──▶ Base Sepolia USDC settlement
```

**Why separate processes, not one orchestrator:** the Agent SDK already spawns a Claude Code
subprocess per `query()`, and each citizen wants its own wallet/signer, its own persona and an isolated
crash domain. The sim is the single writer of world state.

---

## 2. Wallets

- `npm run gen-citizens` generates throwaway Base Sepolia keys with viem's `generatePrivateKey()` into
  `citizens.local.json` (`{id, address, privateKey}` per citizen, **gitignored**). Tools never print the
  key; `inspect` shows the address only.
- **Do not re-run `gen-citizens` on a funded town**: it replaces the wallets, and the USDC in the old
  ones is stranded. A sim restart is always safe (it reloads data and never regenerates wallets).
- Balances are read **live** with one `balanceOf` call on the USDC contract (never cached):
  `npm run balances`.

## 3. Funding: the treasury and the stipend window

One funded **treasury** wallet (the "central bank", `TREASURY_PRIVATE_KEY`) disperses USDC to every
citizen **gaslessly, over x402 itself**:

- `npm run stipend` starts the **stipend window** on `:4040`: one paid route per citizen,
  `GET /stipend/<id>`, whose `payTo` is that citizen's wallet. It is just the x402 seller pattern with the
  citizen as the payee.
- `npm run fund-agents` (`--dry-run` to preview) has the treasury pay each route, so USDC moves
  treasury → citizen at the `STIPEND` amount (default `$0.02`).
- Because x402's `exact` scheme settles via EIP-3009 `transferWithAuthorization` and the facilitator
  sponsors gas, **the whole economy needs zero ETH**: only the treasury's USDC. The treasury itself is
  topped up from Circle's public testnet faucet (https://faucet.circle.com, Base Sepolia).

## 4. Shops are x402 sellers

`shops/shop-server.ts` is a catalog-driven x402 seller; `npm run shops` starts all five
(`shops/registry.ts` maps shop → port → owner → goods). Goods and prices come from `sim/world.json`
(bread $0.01, bun $0.02, coffee $0.02, apple $0.01, milk $0.02, delivery $0.03, …).

- `GET /shop` is **free**: it returns goods, prices and stock so a citizen can window-shop *before*
  deciding (looking must not cost money).
- `GET /shop/buy/:goodId` is **paywalled** by `paymentMiddleware` at that good's price; the handler
  runs only after payment and decrements stock.
- `payTo` = **the owning citizen's wallet** (bakery → baker, cafe → barista, …). Buying bread moves USDC
  into the baker's wallet, which the baker can re-spend: money **circulates** ("trade in a circle until
  someone runs out").
- **The shop holds no private key.** The facilitator verifies and settles.

## 5. The `buy` primitive (`buy.ts`)

`payForItem(citizenId, shopUrl, goodId)` is the standard x402 client flow from the citizen's own key:

```ts
const account  = privateKeyToAccount(citizen.privateKey);
const client   = new x402Client().register("eip155:*", new ExactEvmScheme(account));
const fetchPay = wrapFetchWithPayment(fetch, client);
const res      = await fetchPay(`${shopUrl}/shop/buy/${goodId}`);   // 402 → sign EIP-3009 → retry → 200
const receipt  = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!); // carries the txHash
```

Every stage is also emitted to the sim as a **tape beat**, loudly, so a failed buy is never silent:
`buy-attempt → buy-402 → buy-settled {txHash} | buy-failed {reason}`, where the reason is one of
`seller-absent`, `no-funds`, `timeout`, `402-rejected`, `http-<status>`, `no-settlement-receipt` or
`error`. Running `tsx buy.ts` directly runs a self-test of that plumbing with zero tokens and zero
settlements.

## 6. The purchase guard (`citizens/guard.ts`)

**Judgment lives in the LLM; the constraint lives in code and can veto.** The model calls
`evaluate_purchase{item, price_usdc, reason, worth}` before buying; `canBuy()` reads the live balance
and the ledger and returns `mayBuy`. The same check is wired a second time as the SDK's `canUseTool`
hook on the `buy` tool, so the cap holds even if the model skips `evaluate_purchase`.

```ts
const checks = {
  affordable: balance - price >= caps.reserveUSDC,          // reserve floor: can't zero the wallet
  underCap:   price <= caps.maxPurchaseUSDC,                // per-purchase ceiling
  underDaily: sumToday(id) + price <= caps.dailyCapUSDC,    // daily ceiling
  notDup:     !has(`${id}|${item}|${turn}`),                // idempotency: one buy of an item per turn
};
```

Caps live in `economy.config.json` and are re-read on every call, so edits hot-reload without restarting
citizens. In the shipped config the **reserve floor** ($0.02–$0.05) and the $0.05 per-purchase cap are
the binding constraints; the daily cap is set high (1000) on purpose, because the design's safety
property is the reserve floor (no wallet can be drained), not a gross daily cap. Two kill switches:
`"enabled": false` (no buys at all) and `"dryRun": true` (the LLM still decides; nothing settles). In one
early long run, ~811 of 2,200 `worth=true` decisions were blocked by the reserve floor: spending was
gate-limited, not desire-limited ([observability.md](observability.md) §5).

## 7. Custody and the ledger

- **The ledger** (`sim/data/events.jsonl`) is append-only JSONL with a single writer, the sim. One row
  per economic or social action: `{ts, actor, kind, payload, related_id}`, where `related_id` is the
  on-chain settlement hash for paid events. Dedup on `related_id + kind + actor` doubles as the
  idempotency primitive (`economy/ledger.ts`).
- **Custody** (`economy/inventory.ts`) records who owns each unit of a good and the settlement tx that
  moved it to them. A paid transfer happens **only** when the sim receives a `buyResult` carrying a real
  settlement txHash. Gifts, production, consumption and pick-up/drop also move custody, but only a buy
  is a paid settlement.
- **Restart-safe:** on boot the sim replays the ledger into the custody store (purchases, consumes,
  gifts, production, pick-ups and drops, *net*). An earlier purchases-only replay re-minted every good
  ever bought (the baker booted holding 209 coffees), and that phantom stock made citizens decide not
  to buy anything, killing demand until it was fixed.

## 8. One citizen buying a loaf

```
1. TICK     the citizen's loop wakes: look → GET /perceive?agent=courier
2. ENTER    goTo(bakery) → the sim paths it there over ticks → enterShop(bakery)
            → GET http://localhost:4031/shop → 200 {goods, prices, stock}             [free]
3. DECIDE   the model calls evaluate_purchase{item, price_usdc, reason, worth}       ← tokens spent here
4. GUARD    canBuy(): reserve floor, per-purchase cap, daily cap, idempotency → may VETO
5. PAY      buy → payForItem(): 402 → sign EIP-3009 → retry → 200, txHash in PAYMENT-RESPONSE
6. RECORD   POST /act buyResult{item, txHash} → the sim appends `purchase` and moves custody
7. CONVERSE (optional) if next to a neighbour, talk about it
```

The payment happens in the **citizen** process and the result is reported back to the sim as an input
(AI Town's "AI work off the engine"). The free `GET /shop` is the price check before the buy.

## 9. Auth

Citizens authenticate the Agent SDK with **`ANTHROPIC_API_KEY`** by default, as Anthropic's
[Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) describes; every process
checks this at start (`citizens/auth.ts`) and exits with instructions if no key is set. Using your own
logged-in Claude subscription instead (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or the CLI
login with `TILLWICK_USE_CLAUDE_LOGIN=1`) is an explicit opt-in for **personal local experiments only**;
it is how the project was developed, so the recorded costs are API-list-price equivalents. Either way all
citizens draw on one account's limits, which is why the safety governor in
[architecture.md](architecture.md) §1 exists; see the
[incident post-mortem](incident-2026-06-18-token-drain.md) for what happens without it.

## 10. Fixed chain constants

- Network CAIP-2 **`eip155:84532`** (Base Sepolia).
- USDC **`0x036CbD53842c5426634e7929541eC2318f3dCF7e`** (Circle's public Base Sepolia contract), 6
  decimals.
- Facilitator **`https://x402.org/facilitator`** (keyless).
- x402 packages pinned to **`@x402/*@2.15.0`** (v2).

## Sources

- Park et al., *Generative Agents* (https://ar5iv.labs.arxiv.org/html/2304.03442): the town-as-tree
  trick that turns a tile map into text an LLM can read.
- a16z AI Town architecture (https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md): the
  never-call-an-LLM-in-the-tick-loop discipline and conversation side tables.
- x402 (https://www.x402.org) and Circle's testnet faucet (https://faucet.circle.com).
- Agent SDK authentication (https://code.claude.com/docs/en/agent-sdk/quickstart).
