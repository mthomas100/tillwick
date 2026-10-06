// Agent inspector overlay. Self-contained (own WS + own canvas click listener), like tx-overlay.js.
// Click a citizen on the map -> a floating card with identity, live USDC balance, spent/earned, an ACTIVITY
// (thought→tool→result) stream, and an inventory list where each good links to the BaseScan tx the citizen paid.
// C-panel: MANY cards coexist (a `panels` Map of id->card) — each its own DOM node + poll + token + tabs; each is
// DRAGGABLE by its header and PERSISTENT (only its own ✕ closes it). DOM hooks are namespaced .inspector-* /
// classes (not ids — ids would collide across cards) so they never clash with the map, the feed (#feed), or #tx-*.
//
// Data sources (built by the lead):
//   GET /agent/:id            -> { id,address,color,x,y,usdc,spent,earned, inventory:[{item,price_usdc,shop,counterparty,txHash,explorer,ts}] }
//   WS  {type:"world", world} -> world.tile (px/tile) + world.buildings[] (shops carry type:"shop", goods:[{id,price}])
//   WS  {type:"tick",  agents}-> [{id,x,y,color,moving,adjacentTo}] live positions for click hit-testing
//   WS  {type:"event", kind:"purchase", actor, payload, txHash, explorer} -> append a row live for the open agent
(function () {
  "use strict";

  // ---------- pure helpers (also unit-tested headless at the bottom) ----------

  // Convert a canvas-relative click into a tile coordinate. The canvas is CSS-scaled
  // (style max-width/max-height), so divide by the on-screen size to recover device pixels.
  function clickToTile(rect, clientX, clientY, canvasW, canvasH, tile) {
    const sx = canvasW / rect.width;
    const sy = canvasH / rect.height;
    const px = (clientX - rect.left) * sx;
    const py = (clientY - rect.top) * sy;
    return { px, py, tx: px / tile, ty: py / tile };
  }

  // Pick the agent whose center is within `radius` tiles of the click; nearest wins. Null if none.
  // posOf(a) optionally returns {x,y} in tile units (e.g. main.js's interpolated walk position);
  // defaults to the agent's integer tick tile. Nearest agent within `radius` tiles wins.
  function hitTest(agents, px, py, tile, radius, posOf) {
    const r = (radius == null ? 0.5 : radius) * tile;
    let best = null;
    let bestD2 = r * r;
    for (const a of agents) {
      const p = (posOf && posOf(a)) || a;
      const cx = p.x * tile + tile / 2;
      const cy = p.y * tile + tile / 2;
      const dx = cx - px;
      const dy = cy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) { bestD2 = d2; best = a; }
    }
    return best;
  }

  // ALL agents within `radius` tiles of the click, nearest-first (A3-5). When a click lands on a cluster of
  // fanned/co-located citizens, hitTest() silently returns just the nearest; this returns the whole set so the
  // caller can offer a roster picker. Same posOf/radius contract as hitTest.
  function hitTestAll(agents, px, py, tile, radius, posOf) {
    const r = (radius == null ? 0.5 : radius) * tile;
    const r2 = r * r;
    const hits = [];
    for (const a of agents) {
      const p = (posOf && posOf(a)) || a;
      const cx = p.x * tile + tile / 2;
      const cy = p.y * tile + tile / 2;
      const dx = cx - px, dy = cy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) hits.push({ a, d2 });
    }
    hits.sort((m, n) => m.d2 - n.d2);
    return hits.map((h) => h.a);
  }

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  // A lightweight emoji per good, matched loosely on the item name (fallback 🛒).
  const ITEM_ICONS = { bread: "🍞", bun: "🥐", coffee: "☕", apple: "🍎", milk: "🥛", nail: "🔩", delivery: "📦" };
  function itemIcon(name) {
    const k = String(name == null ? "" : name).toLowerCase();
    if (ITEM_ICONS[k]) return ITEM_ICONS[k];
    for (const key in ITEM_ICONS) if (k.indexOf(key) !== -1) return ITEM_ICONS[key]; // e.g. "fresh bread" -> 🍞
    return "🛒";
  }

  const fmtUsd = (v) => {
    const n = Number(v);
    if (v == null || !isFinite(n)) return "—"; // unknown (e.g. a replay, or the chain read failed) is not $0
    return "$" + n.toFixed(n < 1 ? 4 : 2);
  };

  // Catalog goods prices arrive pre-formatted as "$0.01" strings (world.json) — pass those through;
  // only format bare numbers. (Inventory price_usdc / balances are numbers -> use fmtUsd for those.)
  const fmtPrice = (v) => {
    if (typeof v === "string" && v.trim().charAt(0) === "$") return v.trim();
    const n = Number(v);
    return isFinite(n) ? fmtUsd(n) : esc(v);
  };

  // Goods list as inline HTML: "🍞 bread $0.01 · 🥐 bun $0.02".
  function goodsHTML(goods) {
    if (!Array.isArray(goods) || !goods.length) return '<span class="inspector-dim">—</span>';
    return goods
      .map((g) => `<span class="inspector-icon">${itemIcon(g.id)}</span> ${esc(g.id)} <span class="inspector-amt">${esc(fmtPrice(g.price))}</span>`)
      .join(" · ");
  }

  // Shop catalogs keyed by building id, from world.buildings (shops carry goods:[{id,price}]).
  function shopCatalogs(world) {
    const out = {};
    if (!world || !Array.isArray(world.buildings)) return out;
    for (const b of world.buildings) {
      if ((b.type === "shop" || Array.isArray(b.goods)) && Array.isArray(b.goods) && b.goods.length) {
        out[b.id] = { label: b.label || b.id, color: b.color, goods: b.goods, owner: b.owner };
      }
    }
    return out;
  }

  // Which shop rect (if any) the click tile falls inside. Only shops are clickable (homes aren't).
  function buildingHitTest(buildings, tx, ty) {
    if (!Array.isArray(buildings)) return null;
    for (const b of buildings) {
      if (b.type !== "shop" && !(Array.isArray(b.goods) && b.goods.length)) continue;
      if (tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h) return b;
    }
    return null;
  }

  // B2: ANY building footprint the click tile falls inside (not just shops) — so a home/civic with a modelled
  // interior is enterable too. Returns the first match (footprints don't overlap).
  function buildingAt(buildings, tx, ty) {
    if (!Array.isArray(buildings)) return null;
    for (const b of buildings) {
      if (tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h) return b;
    }
    return null;
  }

  // One inventory row's inner HTML: "🍞 bread $0.01 from bakery · tx ↗" with a BaseScan link.
  function inventoryRowHTML(it) {
    const icon = `<span class="inspector-icon">${itemIcon(it.item)}</span>`;
    const item = esc(it.item || "item");
    const price = it.price_usdc != null ? `<span class="inspector-amt">${esc(fmtUsd(it.price_usdc))}</span>` : "";
    // Provenance: prefer the shop label (readable, present on buys); for peer resales there's no shop,
    // so fall back to `from` — the custody store's stable provenance field — then `counterparty`.
    const from = it.shop || it.from || it.counterparty;
    const fromHtml = from ? ` <span class="inspector-dim">from</span> ${esc(from)}` : "";
    const href = it.explorer || (it.txHash ? "https://sepolia.basescan.org/tx/" + it.txHash : "");
    const tx = href ? ` <a class="inspector-tx" href="${esc(href)}" target="_blank" rel="noopener">tx ↗</a>` : "";
    return `${icon} <span class="inspector-good">${item}</span> ${price}${fromHtml} ·${tx}`;
  }

  // ---------- B5: Activity/Logs tab — the in-GUI tmux of a citizen's thought→tool→result stream ----------
  // Source: GET /agent/:id/activity?recent=N → { id, count, items:[{ ts, kind, source, text, gameMin?,
  // gameClock?, tool?, ... }] } newest-first, where `text` is already render-ready (instrumentor composes it).
  // We classify by `kind` into a CSS class + a leading glyph; result rows further split ok/err by a ✓/✗ in text.
  const ACT_KIND = {
    thought: { cls: "think", ico: "💭" },
    tool:    { cls: "tool",  ico: "🔧" },
    result:  { cls: "result", ico: "✓" }, // glyph refined per-row (✓/✗) below
    say:     { cls: "say",   ico: "🗣" },
    status:  { cls: "status", ico: "🛠" },
    purchase:{ cls: "pay",   ico: "💸" },
    sale:    { cls: "pay",   ico: "🪙" },
    move:    { cls: "move",  ico: "→" },
    produce: { cls: "make",  ico: "🛠" },
    consume: { cls: "make",  ico: "🍽" },
  };
  // A short, human time for an activity row: prefer the in-world clock (day/hh:mm) when present, else wall-clock.
  function activityTime(it) {
    if (it && it.gameClock && typeof it.gameClock.hh === "number") {
      const hh = String(it.gameClock.hh).padStart(2, "0"), mm = String(it.gameClock.mm ?? 0).padStart(2, "0");
      return `d${it.gameClock.day ?? "?"} ${hh}:${mm}`;
    }
    if (it && it.ts) { try { const d = new Date(it.ts); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { /* fall through */ } }
    return "";
  }
  // One activity row's inner HTML. `text` is trusted-render from the endpoint but we STILL esc() it (defense in
  // depth — it's interpolated into innerHTML). status rows get a friendlier label than the endpoint's bare
  // "status" (the endpoint stringifies the kind; the rich emoji+verb live in payload, surfaced here when present).
  function activityRowHTML(it) {
    const kind = String(it.kind || "").toLowerCase();
    const meta = ACT_KIND[kind] || { cls: "evt", ico: "·" };
    let ico = meta.ico;
    let text = it.text != null ? String(it.text) : "";
    if (kind === "result") ico = /✗|fail|error/i.test(text) ? "✗" : "✓";
    if (kind === "status") {
      // the endpoint sends bare "status"; if a richer payload rode along, prefer it; else keep a clean label.
      const p = it.payload || {};
      if (p.text || p.emoji || p.verb) text = `${p.emoji ? p.emoji + " " : ""}${p.text || p.verb || "working"}`;
      else if (!text || text === "status") text = "working";
    }
    const t = activityTime(it);
    const tHtml = t ? `<span class="inspector-act-t">${esc(t)}</span>` : "";
    const src = it.source === "trace" ? "" : ' data-evt="1"'; // event rows read slightly dimmer (see CSS)
    return `<div class="inspector-act-row ${esc(meta.cls)}"${src}>` +
      `<span class="inspector-act-ico">${ico}</span>${tHtml}` +
      `<span class="inspector-act-text">${esc(text)}</span></div>`;
  }
  // The full activity list body for a payload (or a friendly empty/error state). Pure → headless-testable.
  function activityListHTML(data) {
    const items = data && Array.isArray(data.items) ? data.items : [];
    if (!items.length) return `<div class="inspector-act-empty">no recent activity</div>`;
    return items.map(activityRowHTML).join("");
  }

  // Build the full panel HTML for an /agent/:id payload (+ optional shop catalogs for the market list).
  function panelHTML(data, catalogs) {
    const color = data.color || "#ff9100";
    const inv = Array.isArray(data.inventory) ? data.inventory : [];
    const invHtml = inv.length
      ? inv.map((it) => `<li class="inspector-row" data-item="${esc(it.item || "")}" data-tx="${esc(it.txHash || "")}">${inventoryRowHTML(it)}</li>`).join("")
      : `<li class="inspector-empty">nothing bought yet</li>`;

    let marketHtml = "";
    if (catalogs && Object.keys(catalogs).length) {
      const shops = Object.keys(catalogs).map((id) => {
        const s = catalogs[id];
        return `<div class="inspector-shop"><span class="inspector-shoplabel" style="color:${esc(s.color || "#00d4ff")}">${esc(s.label)}</span> ${goodsHTML(s.goods)}</div>`;
      }).join("");
      marketHtml =
        `<div class="inspector-sec">MARKET</div><div class="inspector-market">${shops}</div>`;
    }

    // NOTE: stats/close/activity/logs hooks are CLASSES (not ids) — many cards coexist now, so ids would collide.
    // Controllers (renderStats/loadActivity/switchTab/onPurchaseEvent) scope every query to the card's own `el`.
    return (
      `<div class="inspector-head">` +
        `<span class="inspector-dot" style="background:${esc(color)}"></span>` +
        `<span class="inspector-id">${esc(data.id)}</span>` +
        `<button class="inspector-close" title="close">✕</button>` +
      `</div>` +
      `<div class="inspector-addr">${esc(data.address || "no wallet")}</div>` +
      `<div class="inspector-balance"><span class="inspector-bal">${esc(fmtUsd(data.usdc))}</span> <span class="inspector-unit">USDC</span></div>` +
      `<div class="inspector-flow">` +
        `<span>spent <b class="inspector-out inspector-spent">${esc(fmtUsd(data.spent))}</b></span>` +
        `<span>earned <b class="inspector-in inspector-earned">${esc(fmtUsd(data.earned))}</b></span>` +
      `</div>` +
      // Action row: open THIS citizen's live session in iTerm (POST /observe {id}). The sim opens a split
      // window — LEFT: tail -f the live log (reasoning + tool calls); RIGHT: `npm run inspect -- <id>` (the
      // full inner-life dashboard — persona, memory stream, reflections, plan, relationships, economy, trace).
      // data-agent-id carries the exact resolved id, so the handler never depends on module state.
      `<div class="inspector-actions">` +
        `<button class="inspector-btn inspector-logs" type="button" data-agent-id="${esc(data.id)}" ` +
          `title="open ${esc(data.id)}'s live logs + mind (memory, reflections, plan, trace) in iTerm">` +
          `<span class="inspector-btn-ico">▦</span> inspect in iTerm</button>` +
      `</div>` +
      // B5/C-panel: tabbed content region — ACTIVITY (default) | INVENTORY. The operator wants the live
      // thought→tool→result stream FIRST, so ACTIVITY opens active (its `on` pill + un-hidden pane) and its poll
      // starts immediately when the card opens; INVENTORY starts hidden. The iTerm button above is the heavyweight
      // tmux view; this tab is the lightweight in-card version. (openAgent calls switchTab(card,"activity") on open.)
      `<div class="inspector-tabs" role="tablist">` +
        `<button class="inspector-tab" data-tab="inventory" role="tab">INVENTORY</button>` +
        `<button class="inspector-tab on" data-tab="activity" role="tab">ACTIVITY</button>` +
      `</div>` +
      `<div class="inspector-tabpane" data-pane="inventory" hidden>` +
        `<ul class="inspector-inv">${invHtml}</ul>` +
        marketHtml +
      `</div>` +
      `<div class="inspector-tabpane" data-pane="activity">` +
        `<div class="inspector-act-list inspector-activity"><div class="inspector-act-empty">loading…</div></div>` +
      `</div>`
    );
  }

  // Shop panel: label, what it sells, its owner, and the owner's balance (== the shop's wallet, since
  // the shop's payTo is the owner) + total earned. ownerData is the /agent/<owner> payload (or null if
  // owner unknown / fetch failed). Uses .inspector-bal / .inspector-earned (per-card classes) so live stats apply.
  function shopPanelHTML(b, ownerData) {
    const color = b.color || "#00d4ff";
    const owner = b.owner || (ownerData && ownerData.id) || null;
    const hasOwner = !!ownerData;
    const balRow = hasOwner
      ? `<div class="inspector-balance"><span class="inspector-bal">${esc(fmtUsd(ownerData.usdc))}</span> <span class="inspector-unit">USDC · shop balance</span></div>` +
        `<div class="inspector-flow"><span>earned <b class="inspector-in inspector-earned">${esc(fmtUsd(ownerData.earned))}</b></span></div>`
      : `<div class="inspector-addr">${owner ? "loading owner balance…" : "owner unknown — balance unavailable"}</div>`;
    const ownerLine = owner
      ? `<div class="inspector-owner">owner <span class="inspector-good">${esc(owner)}</span>${hasOwner && ownerData.address ? ` <span class="inspector-dim">${esc(ownerData.address)}</span>` : ""}</div>`
      : "";
    return (
      `<div class="inspector-head">` +
        `<span class="inspector-dot inspector-square" style="background:${esc(color)}"></span>` +
        `<span class="inspector-id">${esc(b.label || b.id)}</span>` +
        `<span class="inspector-tag">shop</span>` +
        `<button class="inspector-close" title="close">✕</button>` +
      `</div>` +
      ownerLine +
      balRow +
      `<div class="inspector-sec">SELLS</div>` +
      `<div class="inspector-market"><div class="inspector-shop">${goodsHTML(b.goods)}</div></div>`
    );
  }

  // ---------- everything below only runs in a browser ----------
  // No DOM (e.g. a Node smoke test) -> expose the pure helpers if a CommonJS env is present, then stop.
  if (typeof window === "undefined" || typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = { clickToTile, hitTest, hitTestAll, panelHTML, inventoryRowHTML, shopCatalogs, fmtUsd, fmtPrice, itemIcon, goodsHTML, buildingHitTest, shopPanelHTML, activityRowHTML, activityListHTML, activityTime };
    }
    return;
  }

  // styles (namespaced)
  // C-panel: the card styles target the CLASS .inspector-panel-card (not the old #inspector-panel id) so MANY
  // cards can coexist on screen at once. Each open citizen/shop gets its own node carrying this class.
  const style = document.createElement("style");
  style.textContent = `
    .inspector-panel-card {
      position: fixed; z-index: 9000; width: 300px; max-height: 78vh; overflow-y: auto;
      background: #0b0b0a; color: #fafaf5; border: 1px solid #1f1f1c; border-radius: 10px;
      box-shadow: 0 18px 60px rgba(0,0,0,.6); padding: 12px 14px;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.5;
    }
    /* the header doubles as the DRAG handle — grab cursor + no text-selection while dragging the title bar */
    .inspector-panel-card .inspector-head { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; cursor: grab; user-select: none; }
    .inspector-panel-card.inspector-dragging { cursor: grabbing; }
    .inspector-panel-card.inspector-dragging .inspector-head { cursor: grabbing; }
    .inspector-panel-card .inspector-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px #0b0b0a; }
    .inspector-panel-card .inspector-id { color: #ff9100; font-weight: 600; font-size: 15px; letter-spacing: .04em; }
    .inspector-panel-card .inspector-close {
      margin-left: auto; background: none; border: none; color: #6b6b66; cursor: pointer;
      font-size: 14px; line-height: 1; padding: 2px 4px; font-family: inherit;
    }
    .inspector-panel-card .inspector-close:hover { color: #fafaf5; }
    .inspector-panel-card .inspector-addr { color: #6b6b66; font-size: 10.5px; word-break: break-all; margin-bottom: 8px; }
    .inspector-panel-card .inspector-balance { color: #6ee7b7; font-size: 26px; font-weight: 700; line-height: 1.1; }
    .inspector-panel-card .inspector-unit { color: #6b6b66; font-size: 12px; font-weight: 400; }
    .inspector-panel-card .inspector-flow { display: flex; gap: 16px; margin: 6px 0 4px; color: #9a9a93; font-size: 11px; }
    .inspector-panel-card .inspector-out { color: #ff5247; }
    .inspector-panel-card .inspector-in { color: #6ee7b7; }
    .inspector-panel-card .inspector-sec {
      color: #ff9100; font-size: 10px; letter-spacing: .12em; margin: 12px 0 6px;
      border-top: 1px solid #1a1a1a; padding-top: 8px;
    }
    .inspector-panel-card .inspector-inv { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
    .inspector-panel-card .inspector-row { background: #111110; border-left: 3px solid #6ee7b7; border-radius: 4px; padding: 5px 8px; word-break: break-word; }
    .inspector-panel-card .inspector-good { font-weight: 600; }
    .inspector-panel-card .inspector-amt { color: #6ee7b7; font-weight: 600; }
    .inspector-panel-card .inspector-dim { color: #6b6b66; }
    .inspector-panel-card .inspector-tx { color: #00d4ff; text-decoration: none; }
    .inspector-panel-card .inspector-tx:hover { text-decoration: underline; }
    .inspector-panel-card .inspector-empty { list-style: none; color: #6b6b66; font-style: italic; }
    .inspector-panel-card .inspector-market { display: flex; flex-direction: column; gap: 4px; }
    .inspector-panel-card .inspector-shop { font-size: 11px; color: #cfcfc8; }
    .inspector-panel-card .inspector-shoplabel { font-weight: 600; }
    .inspector-panel-card .inspector-icon { display: inline-block; width: 1.2em; text-align: center; }
    .inspector-panel-card .inspector-square { border-radius: 3px; }
    .inspector-panel-card .inspector-tag { font-size: 9px; letter-spacing: .1em; text-transform: uppercase;
      color: #0b0b0a; background: #00d4ff; border-radius: 3px; padding: 1px 5px; align-self: center; }
    .inspector-panel-card .inspector-owner { color: #9a9a93; font-size: 11px; margin-bottom: 6px; }
    /* "open this citizen's live session in iTerm" action — small, matches the inspector's mono/dark chrome. */
    .inspector-panel-card .inspector-actions { display: flex; gap: 8px; margin: 8px 0 2px; }
    .inspector-panel-card .inspector-btn {
      display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
      background: #141413; color: #cfcfc8; border: 1px solid #2a2a2a; border-radius: 5px;
      padding: 4px 9px; font-family: inherit; font-size: 10.5px; letter-spacing: .04em; line-height: 1.2;
      transition: background .12s, border-color .12s, color .12s;
    }
    .inspector-panel-card .inspector-btn:hover { background: #1c1c1a; border-color: #ff9100; color: #fafaf5; }
    .inspector-panel-card .inspector-btn:active { transform: translateY(1px); }
    .inspector-panel-card .inspector-btn:disabled { opacity: .55; cursor: default; transform: none; }
    .inspector-panel-card .inspector-btn .inspector-btn-ico { color: #ff9100; }
    /* transient confirmation toast, anchored to the card (bottom-right), never blocks the close button */
    .inspector-panel-card .inspector-toast {
      position: absolute; right: 12px; bottom: 10px; max-width: 240px;
      background: #14241a; color: #6ee7b7; border: 1px solid #1f3a2a; border-radius: 6px;
      padding: 5px 9px; font-size: 10.5px; line-height: 1.35; pointer-events: none;
      opacity: 0; transform: translateY(4px); transition: opacity .15s, transform .15s;
    }
    .inspector-panel-card .inspector-toast.inspector-toast-show { opacity: 1; transform: translateY(0); }
    .inspector-panel-card .inspector-toast.inspector-toast-err { background: #241414; color: #ff8a80; border-color: #3a1f1f; }
    .inspector-panel-card .inspector-tick { animation: inspector-tick 0.7s ease-out; }
    @keyframes inspector-tick {
      0% { transform: scale(1.18); text-shadow: 0 0 10px currentColor; }
      100% { transform: scale(1); text-shadow: none; }
    }
    .inspector-panel-card .inspector-fresh { animation: inspector-fresh 0.6s ease-out; }
    @keyframes inspector-fresh { 0% { opacity: 0; transform: translateY(-4px); background: #1a2a1a; } 100% { opacity: 1; transform: translateY(0); } }
    /* A3-5: clustered-click roster picker — a tiny floating menu listing the citizens stacked under the cursor. */
    #inspector-roster {
      position: fixed; z-index: 9100; min-width: 150px; max-width: 240px;
      background: #0b0b0a; color: #fafaf5; border: 1px solid #1f1f1c; border-radius: 8px;
      box-shadow: 0 14px 44px rgba(0,0,0,.6); padding: 5px; display: none;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 12px;
    }
    #inspector-roster .inspector-roster-head {
      color: #6b6b66; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; padding: 4px 8px 5px;
    }
    #inspector-roster .inspector-roster-item {
      display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px; cursor: pointer;
      transition: background .1s;
    }
    #inspector-roster .inspector-roster-item:hover { background: #181816; }
    #inspector-roster .inspector-roster-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px #0b0b0a; }
    #inspector-roster .inspector-roster-name { color: #fafaf5; font-weight: 600; letter-spacing: .03em; }
    /* B5: INVENTORY | ACTIVITY tabs + the activity (thought→tool→result) log inside the card. */
    .inspector-panel-card .inspector-tabs { display: flex; gap: 4px; margin: 12px 0 8px; border-bottom: 1px solid #1a1a1a; }
    .inspector-panel-card .inspector-tab {
      background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer;
      color: #6b6b66; font-family: inherit; font-size: 10px; letter-spacing: .12em; padding: 4px 6px 7px;
      transition: color .12s, border-color .12s;
    }
    .inspector-panel-card .inspector-tab:hover { color: #cfcfc8; }
    .inspector-panel-card .inspector-tab.on { color: #ff9100; border-bottom-color: #ff9100; }
    .inspector-panel-card .inspector-tabpane[hidden] { display: none; }
    .inspector-panel-card .inspector-act-list { display: flex; flex-direction: column; gap: 3px; max-height: 320px; overflow-y: auto; }
    .inspector-panel-card .inspector-act-empty { color: #6b6b66; font-style: italic; font-size: 11px; padding: 6px 2px; }
    .inspector-panel-card .inspector-act-row {
      display: grid; grid-template-columns: 16px auto 1fr; align-items: baseline; gap: 6px;
      font-size: 11px; line-height: 1.4; padding: 4px 6px; border-left: 2px solid #2a2a2a;
      border-radius: 3px; background: #111110; word-break: break-word;
    }
    .inspector-panel-card .inspector-act-row[data-evt] { opacity: .82; } /* sim events read a touch quieter than trace */
    .inspector-panel-card .inspector-act-ico { text-align: center; }
    .inspector-panel-card .inspector-act-t { color: #6b6b66; font-size: 9.5px; white-space: nowrap; }
    .inspector-panel-card .inspector-act-text { color: #d6d6cf; grid-column: 3; }
    /* per-kind accents (left border + glyph hue via the row color) */
    .inspector-panel-card .inspector-act-row.think  { border-left-color: #b79cff; }
    .inspector-panel-card .inspector-act-row.tool   { border-left-color: #00d4ff; }
    .inspector-panel-card .inspector-act-row.result { border-left-color: #6ee7b7; }
    .inspector-panel-card .inspector-act-row.say    { border-left-color: #ffd479; }
    .inspector-panel-card .inspector-act-row.status { border-left-color: #ff9100; }
    .inspector-panel-card .inspector-act-row.pay    { border-left-color: #6ee7b7; }
    .inspector-panel-card .inspector-act-row.make   { border-left-color: #9a9a93; }
    .inspector-panel-card .inspector-act-row.move   { border-left-color: #3a3a36; opacity: .6; }
  `;
  document.head.appendChild(style);

  // C-panel: MANY cards at once. `panels` maps id -> card; each card owns its DOM node, poll, token, stats + tabs.
  //   card = { el, id, kind, ownerId, stats, token, activeTab, activityTimer, toast, toastTimer, key }
  // Agent cards are keyed by the citizen id; shop cards by "shop:<buildingId>" (prefix avoids id collisions).
  const panels = new Map();
  let zTop = 9000; // z-index high-water mark; bumped each time a card is raised so the focused card sits on top.
  const SHOP_PREFIX = "shop:";

  // Each card carries its OWN confirmation toast (one per card, a child of card.el — positioned relative to it).
  // Kept as a single node per card (vs. re-creating) so an in-flight fade survives a benign innerHTML rebuild.
  function ensureToast(card) {
    if (!card.toast) { card.toast = document.createElement("div"); card.toast.className = "inspector-toast"; card.toastTimer = 0; }
    if (card.toast.parentNode !== card.el) card.el.appendChild(card.toast); // re-attach after an innerHTML rebuild
    return card.toast;
  }
  function showToast(card, msg, isErr) {
    if (!card || !card.el) return;
    const toast = ensureToast(card);
    toast.textContent = msg;
    toast.classList.toggle("inspector-toast-err", !!isErr);
    toast.classList.add("inspector-toast-show");
    if (card.toastTimer) clearTimeout(card.toastTimer);
    card.toastTimer = setTimeout(() => toast.classList.remove("inspector-toast-show"), isErr ? 4200 : 2200);
  }

  // A3-5: the clustered-click roster picker (its own DOM node, sibling to the panel). One reusable element; we
  // rebuild its rows per open. Picking a row opens that citizen via the normal openAgent() path.
  const roster = document.createElement("div");
  roster.id = "inspector-roster";
  document.body.appendChild(roster);
  function hideRoster() { roster.style.display = "none"; roster.innerHTML = ""; }
  function showRoster(agents, clientX, clientY) {
    // Build "choose a citizen" rows: a color dot + the id, nearest-first (the order hitTestAll returns).
    const head = `<div class="inspector-roster-head">${agents.length} citizens here — pick one</div>`;
    const items = agents.map((a) => {
      const color = (a && a.color) || "#ff9100";
      return `<div class="inspector-roster-item" data-agent-id="${esc(a.id)}">` +
        `<span class="inspector-roster-dot" style="background:${esc(color)}"></span>` +
        `<span class="inspector-roster-name">${esc(a.id)}</span></div>`;
    }).join("");
    roster.innerHTML = head + items;
    // wire each row → open that citizen (and dismiss the picker)
    roster.querySelectorAll(".inspector-roster-item").forEach((row) => {
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = row.getAttribute("data-agent-id");
        hideRoster();
        if (id) openAgent(id, clientX, clientY);
      });
    });
    // place near the click, clamped into the viewport (same approach as positionPanel)
    roster.style.display = "block";
    const pad = 12, w = roster.offsetWidth || 180, h = roster.offsetHeight || 120;
    let x = clientX + 14, y = clientY - 6;
    if (x + w + pad > window.innerWidth) x = clientX - w - 14;
    if (x < pad) x = pad;
    if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
    if (y < pad) y = pad;
    roster.style.left = x + "px";
    roster.style.top = y + "px";
  }

  let world = null;
  let liveAgents = [];
  let catalogs = {};
  let cardSeq = 0; // monotonic per-card token source: each card gets its own token, bumped per (re)fetch on it.

  // ---------- B5: ACTIVITY tab controller (per-card) ----------
  // Each controller takes the CARD it acts on (no module globals). The card's own `token` guards against a stale
  // in-flight fetch overwriting the card after it was closed/re-fetched; the card being in `panels` + on the
  // activity tab gates the paint. Best-effort: a missing endpoint (older sim) shows "unavailable", never throws.
  // Fetch THIS card's recent activity once and paint it newest-first. `seq` orders responses (a slower earlier
  // fetch must NOT overwrite a newer one) WITHOUT being tied to the poll's liveness — the interval keeps running
  // regardless, so the stream stays live (the old code killed the whole interval on any token bump → the card
  // froze at a stale snapshot, the operator-flagged bug). Only paints if the card is still open + still on activity.
  async function loadActivity(card, seq) {
    if (!card || !card.el || !panels.has(card.key)) return;
    const listEl = card.el.querySelector(".inspector-activity");
    if (!listEl) return;
    const id = card.id;
    try {
      const res = await fetch("/agent/" + encodeURIComponent(id) + "/activity?recent=40");
      if (!panels.has(card.key) || card.activeTab !== "activity") return; // card closed / tabbed away mid-fetch
      if (seq < (card._actSeq || 0)) return;                              // a newer fetch already painted — drop this stale one
      card._actSeq = seq;
      if (!res.ok) { listEl.innerHTML = `<div class="inspector-act-empty">activity unavailable (status ${res.status})</div>`; return; }
      const data = await res.json();
      if (!panels.has(card.key) || card.activeTab !== "activity" || seq < (card._actSeq || 0)) return;
      listEl.innerHTML = activityListHTML(data);
    } catch {
      if (!panels.has(card.key) || card.activeTab !== "activity") return;
      // a transient network blip: leave the last-good content up rather than blanking a live stream.
    }
  }
  function stopActivityPoll(card) { if (card && card.activityTimer) { clearInterval(card.activityTimer); card.activityTimer = 0; } }
  // Start (or restart) THIS card's CONTINUOUS live-stream poll. Loads immediately, then refreshes every 2s WHILE
  // the card is open AND its activity tab is showing — a true live mind-feed that stays current (operator ask).
  // The interval's liveness depends ONLY on "open + on activity tab"; response ordering is handled by `_actSeq`
  // inside loadActivity, so a slow fetch can never kill the poll (the prior bug that froze the card at a snapshot).
  function startActivityPoll(card) {
    stopActivityPoll(card);
    if (!card || card.kind !== "agent" || !card.id) return;
    if (typeof card._actSeq !== "number") card._actSeq = 0;
    if (typeof card._actReq !== "number") card._actReq = 0;
    card._actReq += 1; loadActivity(card, card._actReq);
    card.activityTimer = setInterval(() => {
      if (!panels.has(card.key) || card.activeTab !== "activity") { stopActivityPoll(card); return; }
      card._actReq += 1; loadActivity(card, card._actReq);
    }, 2000);
  }
  // Switch a card to a tab: toggle its pill + pane (scoped to card.el), and start/stop its activity poll.
  function switchTab(card, tab) {
    if (!card || !card.el) return;
    card.activeTab = tab;
    card.el.querySelectorAll(".inspector-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    card.el.querySelectorAll(".inspector-tabpane").forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    if (tab === "activity") startActivityPoll(card); else stopActivityPoll(card);
  }

  // ---------- own WebSocket (world catalogs + tick positions) ----------
  function connect() {
    let ws;
    try { ws = new WebSocket(`ws://${location.host}`); }
    catch { return; }
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "world") {
        world = m.world;
        liveAgents = m.agents || [];
        catalogs = shopCatalogs(world);
      } else if (m.type === "tick") {
        liveAgents = m.agents || [];
      } else if (m.type === "event" && m.kind === "purchase") {
        // A purchase can touch MULTIPLE open cards at once (the buyer's card AND the seller/shop owner's card),
        // so fan the event out to every open card — each decides per-card whether it's the buyer/seller side.
        if (panels.size) for (const card of panels.values()) onPurchaseEvent(card, m);
      } else if (m.type === "event" && m.kind === "consume") {
        // The actor consumed a unit -> drop a matching inventory row on THAT citizen's card if it's open.
        const card = panels.get(m.actor);
        if (card && card.kind === "agent") onConsumeEvent(card, m);
      }
    };
    ws.onclose = () => setTimeout(connect, 1500);
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  connect();

  // ---------- card lifecycle (create / raise / position / drag / close) ----------
  // Make a fresh card node, register it in `panels`, append to <body>. The card object holds ALL of this card's
  // state (no module globals) so any number of cards coexist. `key` is the map key (agent id, or "shop:<id>").
  function createCard(key, kind) {
    const el = document.createElement("div");
    el.className = "inspector-panel-card";
    el.dataset.card = key;
    const card = {
      el, key, id: null, kind, ownerId: null, stats: null,
      token: ++cardSeq, activeTab: "activity", activityTimer: 0, toast: null, toastTimer: 0,
    };
    el.style.zIndex = String(++zTop);
    document.body.appendChild(el);
    panels.set(key, card);
    return card;
  }
  // Bring a card to the front (focus) — used when re-opening an already-open citizen instead of duplicating it.
  function raiseCard(card) { if (card && card.el) card.el.style.zIndex = String(++zTop); }
  // Close ONLY this card: stop its poll, drop it from the body + the map. This is the ONE path that removes a
  // card (its ✕, or an explicit hide(id)). Outside-clicks / opening another citizen NEVER call this (persistence).
  function closeCard(card) {
    if (!card) return;
    stopActivityPoll(card);
    if (card.el && card.el.parentNode) card.el.parentNode.removeChild(card.el);
    panels.delete(card.key);
  }

  // Place a freshly-opened card near the click, clamped into the viewport. Cards are position:fixed; with the
  // node already in the DOM, offsetWidth/Height are real. (Re-clamp on drag uses clampCard below.)
  function positionCard(card, clientX, clientY) {
    const el = card.el;
    const pad = 12;
    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 320;
    let x = (clientX == null ? 200 : clientX) + 16;
    let y = (clientY == null ? 120 : clientY) - 8;
    if (x + w + pad > window.innerWidth) x = (clientX == null ? 200 : clientX) - w - 16;
    if (x < pad) x = pad;
    if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
    if (y < pad) y = pad;
    el.style.left = x + "px";
    el.style.top = y + "px";
  }
  // Clamp a card so it stays within the viewport (used after a drag move and on pointerup).
  function clampCard(card, left, top) {
    const el = card.el, pad = 4;
    const w = el.offsetWidth || 300, h = el.offsetHeight || 320;
    let x = left, y = top;
    x = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
    y = Math.max(pad, Math.min(y, window.innerHeight - h - pad));
    el.style.left = x + "px";
    el.style.top = y + "px";
  }

  // Make a card draggable by its HEADER/title bar (.inspector-head). A pointerdown that lands on the ✕, a tab
  // button, the iTerm button, or a link does NOT start a drag (those keep their own click behavior); the drag
  // starts only on the bare title bar. We move left/top live and clamp to the viewport. position:fixed → the
  // pointer delta maps 1:1 to left/top. setPointerCapture keeps tracking even if the pointer outruns the card.
  function makeDraggable(card) {
    const el = card.el;
    const head = el.querySelector(".inspector-head");
    if (!head) return;
    head.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return; // left-drag only
      // Don't hijack a click meant for an interactive child (close/tabs/buttons/links).
      if (e.target.closest(".inspector-close, .inspector-tab, .inspector-btn, a, button")) return;
      raiseCard(card); // dragging focuses the card
      const rect = el.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      el.classList.add("inspector-dragging");
      let moved = false;
      const onMove = (ev) => {
        moved = true;
        clampCard(card, ev.clientX - offX, ev.clientY - offY);
      };
      const onUp = (ev) => {
        head.removeEventListener("pointermove", onMove);
        head.removeEventListener("pointerup", onUp);
        head.removeEventListener("pointercancel", onUp);
        el.classList.remove("inspector-dragging");
        clampCard(card, ev.clientX - offX, ev.clientY - offY); // final clamp
        if (moved && ev.cancelable) ev.preventDefault(); // swallow the click that would otherwise follow a drag
      };
      try { head.setPointerCapture(e.pointerId); } catch {}
      head.addEventListener("pointermove", onMove);
      head.addEventListener("pointerup", onUp);
      head.addEventListener("pointercancel", onUp);
      e.preventDefault(); // prevent text selection while dragging the title bar
    });
  }

  // ---------- live WS stat/inventory updates (per-card) ----------
  function appendInventoryRow(card, ev) {
    const ul = card.el.querySelector(".inspector-inv");
    if (!ul) return;
    const empty = ul.querySelector(".inspector-empty");
    if (empty) empty.remove();
    const p = ev.payload || {};
    const it = { item: p.item, price_usdc: p.price_usdc, shop: p.shop, from: p.from, counterparty: p.counterparty, txHash: ev.txHash, explorer: ev.explorer };
    const li = document.createElement("li");
    li.className = "inspector-row inspector-fresh";
    li.dataset.item = it.item || "";
    li.dataset.tx = it.txHash || "";
    li.innerHTML = inventoryRowHTML(it);
    ul.appendChild(li);
  }

  // A consume event drops one held unit from THIS card. payload.remaining (units of that item left after) lets us
  // reconcile to truth: trim rows of that item down to `remaining`. If remaining is absent, just remove one
  // (FIFO = the oldest/topmost matching row, mirroring the custody store). Restore the placeholder if it empties.
  function onConsumeEvent(card, ev) {
    const p = ev.payload || {};
    const item = p.item;
    if (!item) return;
    const ul = card.el.querySelector(".inspector-inv");
    if (!ul) return;
    const rows = Array.prototype.filter.call(ul.children, (li) => li.dataset && li.dataset.item === item);
    const remaining = typeof p.remaining === "number" && p.remaining >= 0 ? p.remaining : Math.max(0, rows.length - 1);
    // Remove from the front (oldest) until only `remaining` of this item are left.
    for (let i = 0; i < rows.length - remaining; i++) rows[i].remove();
    if (!ul.querySelector(".inspector-row") && !ul.querySelector(".inspector-empty")) {
      const li = document.createElement("li");
      li.className = "inspector-empty";
      li.textContent = "nothing bought yet";
      ul.appendChild(li);
    }
  }

  // Repaint THIS card's three money figures from card.stats, briefly flashing whichever changed. Lookups are
  // scoped to the card (the stat hooks are CLASSES now, .inspector-bal/.inspector-spent/.inspector-earned).
  function renderStats(card, changed) {
    if (!card.stats) return;
    const set = (cls, val) => {
      const el = card.el.querySelector("." + cls);
      if (!el) return;
      el.textContent = fmtUsd(val);
      if (changed && changed[cls]) {
        el.classList.remove("inspector-tick");
        void el.offsetWidth; // restart the CSS animation
        el.classList.add("inspector-tick");
      }
    };
    set("inspector-bal", card.stats.usdc);
    set("inspector-spent", card.stats.spent);
    set("inspector-earned", card.stats.earned);
  }

  // A purchase, applied live to ONE card without a re-fetch (the WS handler fans this to every open card).
  //  - Buyer side (this card is the buying CITIZEN): append an inventory row + spent up + balance down.
  //  - Seller side (this card's wallet owner is the counterparty): earned up + balance up. For a shop card the
  //    wallet IS the owner, so a purchase whose counterparty === owner ticks that shop card's earned.
  function onPurchaseEvent(card, ev) {
    const p = ev.payload || {};
    const price = Number(p.price_usdc);
    const isBuyer = card.kind === "agent" && ev.actor === card.id;
    const isSeller = card.ownerId != null && p.counterparty === card.ownerId;
    if (!isBuyer && !isSeller) return;
    if (isBuyer) appendInventoryRow(card, ev);
    if (!card.stats) return; // card still loading; the fetch will reflect final numbers
    const changed = {};
    // Only adjust the balance if we actually have a numeric one (null = unknown, stays "—").
    const hasBal = typeof card.stats.usdc === "number" && isFinite(card.stats.usdc);
    if (isFinite(price) && price !== 0) {
      if (isBuyer) {
        card.stats.spent += price;
        changed["inspector-spent"] = true;
        if (hasBal) { card.stats.usdc -= price; changed["inspector-bal"] = true; }
      }
      if (isSeller) {
        card.stats.earned += price;
        changed["inspector-earned"] = true;
        if (hasBal) { card.stats.usdc += price; changed["inspector-bal"] = true; }
      }
    }
    renderStats(card, changed);
  }

  // POST /observe {id} → the sim spawns that citizen's iTerm split window (tail -f log | npm run inspect)
  // detached and returns 200 {ok:true} IMMEDIATELY (fire-and-forget — 200 means "launched", not "window is
  // up"). Best-effort + non-blocking: the click shows an immediate "opening iTerm…" toast on THIS card, then the
  // response confirms or shows a graceful error. NEVER throws into the UI (a dead/feature-off endpoint just toasts).
  // Error contract (cog-finisher): non-2xx with { error } — 400 "id required", 404 "no such agent in roster".
  function observeInITerm(card, id, btn) {
    if (!id) return;
    if (btn) btn.disabled = true; // guard against a double-fire; :disabled dims it while the POST is in flight
    const reEnable = () => { if (btn) btn.disabled = false; };
    showToast(card, "opening iTerm…", false);
    fetch("/observe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    })
      .then((res) => res.json().catch(() => ({})).then((body) => ({ res, body })))
      .then(({ res, body }) => {
        if (res.ok && (body == null || body.ok !== false)) showToast(card, "launched " + id + " in iTerm ✓", false);
        else showToast(card, (body && body.error) ? String(body.error) : ("couldn't open viewer (status " + res.status + ")"), true);
      })
      .catch((err) => showToast(card, "couldn't reach the sim (" + (err && err.message ? err.message : "network error") + ")", true))
      .finally(reEnable);
  }

  // Wire a card's close button + the (agent-only) "open in iTerm" logs button + tabs + drag; place it near the
  // click. Shared by both open paths and the error card. Every query is scoped to card.el and guarded so
  // shop/error cards (no logs button / no tabs) are fine. Re-called after each innerHTML rebuild (re-wires).
  function finishCard(card, clientX, clientY, place) {
    const close = card.el.querySelector(".inspector-close");
    // ✕ closes ONLY this card (persistence: nothing else closes it). stopPropagation so the document click
    // handler doesn't also see it (the roster picker still dismisses on a true outside-click).
    if (close) close.addEventListener("click", (e) => { e.stopPropagation(); closeCard(card); });
    const logs = card.el.querySelector(".inspector-logs");
    if (logs) logs.addEventListener("click", (e) => {
      e.stopPropagation();
      observeInITerm(card, logs.getAttribute("data-agent-id") || card.id, logs);
    });
    // B5: wire the INVENTORY|ACTIVITY tabs (agent cards only; shop/error cards have none → the query is empty).
    card.el.querySelectorAll(".inspector-tab").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      switchTab(card, b.dataset.tab);
    }));
    makeDraggable(card);                     // C-panel: the header is the drag handle
    if (place) positionCard(card, clientX, clientY); // only on first paint (a re-render keeps the dragged spot)
  }

  function showError(card, title, err) {
    card.stats = null;
    card.el.innerHTML =
      `<div class="inspector-head"><span class="inspector-id">${esc(title)}</span>` +
      `<button class="inspector-close">✕</button></div>` +
      `<div class="inspector-addr">could not load (${esc(err && err.message)})</div>`;
    finishCard(card, null, null, false);
  }

  // Fetch the /agent/:id payload, guarding against THIS card being closed/re-fetched (token bump) meanwhile.
  async function fetchAgent(card, id, token) {
    const res = await fetch("/agent/" + encodeURIComponent(id));
    if (!res.ok) throw new Error("status " + res.status);
    const data = await res.json();
    if (token !== card.token || !panels.has(card.key)) return null; // superseded / closed
    return data;
  }

  // Open a citizen card. If it's already open, just raise it to the front (no duplicate). Otherwise create a new
  // card node, fetch /agent/:id, render, default to the ACTIVITY tab (poll starts immediately), wire ✕/tabs/drag.
  async function openAgent(id, clientX, clientY) {
    const existing = panels.get(id);
    if (existing) { raiseCard(existing); return; } // re-opening focuses the existing card (don't duplicate)
    const card = createCard(id, "agent");
    card.id = id;
    card.ownerId = id; // a citizen's own wallet backs the card
    const token = ++card.token;
    try {
      const data = await fetchAgent(card, id, token);
      if (!data) return;
      card.stats = { usdc: data.usdc, spent: Number(data.spent) || 0, earned: Number(data.earned) || 0 };
      card.el.innerHTML = panelHTML(data, catalogs);
      finishCard(card, clientX, clientY, true);
      switchTab(card, "activity"); // C-panel: ACTIVITY is the default tab → its poll starts right away
    } catch (err) {
      if (token !== card.token || !panels.has(card.key)) return;
      showError(card, id, err);
    }
  }

  async function openShop(b, clientX, clientY) {
    const key = SHOP_PREFIX + b.id;
    const existing = panels.get(key);
    if (existing) { raiseCard(existing); return; } // re-opening a shop focuses its card
    const card = createCard(key, "shop");
    card.id = null;             // a shop has no "bought" inventory of its own
    card.ownerId = b.owner || null; // the shop's wallet == its owner's wallet
    const token = ++card.token;
    // Render the shop immediately (label + goods); fill in owner balance once /agent/<owner> returns.
    card.el.innerHTML = shopPanelHTML(b, null);
    finishCard(card, clientX, clientY, true);
    if (!b.owner) return; // owner not exposed yet -> catalog-only view, no balance to fetch
    try {
      const data = await fetchAgent(card, b.owner, token);
      if (!data) return;
      card.stats = { usdc: data.usdc, spent: Number(data.spent) || 0, earned: Number(data.earned) || 0 };
      card.el.innerHTML = shopPanelHTML(b, data);
      finishCard(card, clientX, clientY, false); // keep the dragged/initial position on the balance re-render
    } catch (err) {
      if (token !== card.token || !panels.has(card.key)) return;
      // Keep the catalog view; just note the balance couldn't load.
      card.el.innerHTML = shopPanelHTML(b, null);
      finishCard(card, clientX, clientY, false);
    }
  }

  // hide(id?) — programmatic close used by the __inspector hook + the interior enter-path. With an id, close just
  // that card; with no id, close ALL cards (an explicit teardown — NOT what outside-click does; see below).
  function hide(id) {
    if (id != null) { const c = panels.get(id) || panels.get(SHOP_PREFIX + id); if (c) closeCard(c); return; }
    for (const c of Array.from(panels.values())) closeCard(c);
  }

  function onCanvasClick(e) {
    const c = e.currentTarget;
    // B2 coexistence seam: while the INTERIOR scene owns the canvas, town clicks must NOT hit-test against stale
    // town coords (__townDrawPos/__townWorld). The renderer publishes window.__townView; in "interior" the
    // interior scene handles all clicks, so the town inspector stands down. No-op until the interior view exists
    // (the flag is unset → town). (tx-overlay.js + control.js get the same 1-line guard.)
    if (typeof window !== "undefined" && window.__townView === "interior") return;
    if (!world || !world.tile) return;
    const rect = c.getBoundingClientRect();
    // Prefer the renderer-published, camera-aware transform (Phaser getWorldPoint): the Wave-3 camera zooms/pans
    // to frame the town (and the user can wheel-zoom), so canvas-px != world-px. window.__townScreenToTile maps a
    // canvas-relative point to the EXACT world pixel under the cursor at any zoom/scroll. Fall back to the legacy
    // 1:1 math (canvas-px == world-px) only if the renderer hasn't published the helper (e.g. the old flat-canvas
    // renderer). Note getWorldPoint expects canvas-internal coords, so apply the CSS-scale (canvas.width/rect.w).
    const W = typeof window !== "undefined" ? window : null;
    let px, py;
    if (W && typeof W.__townScreenToTile === "function") {
      const sx = c.width / rect.width, sy = c.height / rect.height;
      const r = W.__townScreenToTile((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
      px = r.px; py = r.py;
    } else {
      ({ px, py } = clickToTile(rect, e.clientX, e.clientY, c.width, c.height, world.tile));
    }
    // Prefer the renderer's exact draw positions so clicks land on the sprite under the cursor:
    //   __townDrawPos = FANNED positions for co-located citizens (crowded shops) — exact, so a tight
    //     radius (sprite is drawn at ~0.36 tile) keeps each fanned sprite individually clickable.
    //   __townRenderPos = interpolated walk positions (may be un-fanned) — use a forgiving radius to
    //     catch a sprite drifting mid-walk between tick tiles.
    //   tick tile (agent.x/y) — last resort if neither global is present.
    // Resolve per-agent (drawPos -> renderPos -> tick) so an empty/partial map degrades gracefully;
    // hitTest is nearest-wins, so among a fanned ring the closest center is selected. (W declared above.)
    const drawPos = (W && W.__townDrawPos) || null;
    const renderPos = (W && W.__townRenderPos) || null;
    // "Fanning is live" only if drawPos actually has entries — an empty {} must NOT shrink the radius
    // while sprites are still drawn un-fanned/interpolated.
    const fanActive = !!(drawPos && Object.keys(drawPos).length);
    const posOf = (a) => (drawPos && drawPos[a.id]) || (renderPos && renderPos[a.id]) || null;
    const radius = fanActive ? 0.45 : 0.8;
    // A citizen takes priority over the shop they're standing in (more specific foreground target).
    // A3-5: gather ALL citizens under the cursor. One → open it (the fast path, unchanged). More than one
    // (a fanned cluster in a crowded shop) → a tiny roster picker so the user CHOOSES, instead of the old
    // nearest-wins silently swallowing the others. Use a slightly wider gather radius than the single-hit
    // radius so the whole visible cluster is offered (the fan spreads sprites ~0.28t around the tile).
    const agentHits = hitTestAll(liveAgents, px, py, world.tile, Math.max(radius, 0.8), posOf);
    if (agentHits.length > 1) { showRoster(agentHits, e.clientX, e.clientY); return; }
    if (agentHits.length === 1) { hideRoster(); openAgent(agentHits[0].id, e.clientX, e.clientY); return; }
    // B2: a building click. If it has a modelled interior, STEP INSIDE (the renderer owns the scene-switch);
    // otherwise keep the existing shop panel (back-compat for buildings without an interior). We hit ANY
    // building footprint here (not just shops) so a home/civic with an interior is enterable too.
    const bHit = buildingAt(world.buildings, px / world.tile, py / world.tile);
    if (bHit && bHit.interior && typeof window !== "undefined" && window.__townRenderer && typeof window.__townRenderer.enterInterior === "function") {
      // KEEP open citizen cards across the scene-switch (lead's ruling): the operator's persistence intent is
      // "stays until ✕ only", so entering an interior must NOT auto-close cards. They're DOM overlays that survive
      // the town↔interior switch — the operator can drag or ✕ them. (Only the transient roster picker dismisses.)
      hideRoster(); window.__townRenderer.enterInterior(bHit.id); return;
    }
    const shopHit = buildingHitTest(world.buildings, px / world.tile, py / world.tile);
    if (shopHit) { hideRoster(); openShop(shopHit, e.clientX, e.clientY); return; }
    // C-panel PERSISTENCE: a click on empty ground dismisses only the roster picker — it does NOT close any open
    // card. Cards persist until the operator clicks their own ✕ (the old `hide()` here was the auto-close we removed).
    hideRoster();
  }

  // Wait for the canvas (#c) — main.js creates it in markup, but guard anyway.
  function attach() {
    const c = document.getElementById("c");
    if (!c) { setTimeout(attach, 200); return; }
    c.addEventListener("click", onCanvasClick);
    c.style.cursor = "pointer";
  }
  attach();

  // C-panel PERSISTENCE: the document-level handler now ONLY dismisses the A3-5 roster picker on a true
  // outside-click. The old agent-card auto-close (outside-click → hide()) is REMOVED — a card stays open until
  // its own ✕ is clicked. (A click that isn't on the canvas or the roster dismisses just the roster.)
  document.addEventListener("click", (e) => {
    const onCanvas = e.target && e.target.id === "c";
    if (roster.style.display !== "none" && !roster.contains(e.target) && !onCanvas) hideRoster();
  });
  // Esc: dismiss the roster picker if it's up; otherwise close the TOP-MOST card (highest z-index) — never all
  // cards at once (persistence). The scene's own Esc (camera-follow release / interior exit) is handled elsewhere.
  function topCard() {
    let top = null, z = -Infinity;
    for (const c of panels.values()) { const cz = parseInt(c.el.style.zIndex, 10) || 0; if (cz >= z) { z = cz; top = c; } }
    return top;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (roster.style.display !== "none") { hideRoster(); return; }
    const t = topCard();
    if (t) closeCard(t);
  });

  // Debug / verification surface (mirrors window.__townRenderer / __ctrlPanel): open a card by id without a
  // pixel-perfect canvas click, switch a card's tab, close a card, and read the set of open ids. Used by the
  // Playwright visual-gate (and the interior scene calls __inspector.openAgent to surface an occupant). The
  // switchTab/hide args are id-keyed now (multi-panel); switchTab with no id targets the top-most card.
  if (typeof window !== "undefined") {
    window.__inspector = {
      openAgent: (id, x, y) => openAgent(id, x ?? 200, y ?? 120),
      switchTab: (id, tab) => {
        // tolerant signature: switchTab(id, tab) targets that card; switchTab(tab) targets the top-most card.
        if (tab === undefined) { const t = topCard(); if (t) switchTab(t, id); return; }
        const c = panels.get(id) || panels.get(SHOP_PREFIX + id);
        if (c) switchTab(c, tab);
      },
      hide,
      get state() {
        const ids = Array.from(panels.keys());
        const top = topCard();
        return {
          open: ids,                       // every open card key (agent id, or "shop:<id>")
          count: ids.length,
          openIds: ids,                    // alias
          // back-compat single-card readout (the top-most card) for older gate assertions:
          openKind: top ? top.kind : null,
          openAgentId: top ? top.id : null,
          activeTab: top ? top.activeTab : null,
          polling: !!(top && top.activityTimer),
        };
      },
    };
  }
})();
