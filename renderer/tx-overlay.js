// On-chain TRANSACTION OVERLAY — a self-contained live monitor of the project's
// Base Sepolia x402 settlements, shown over the town GUI.
//
// It is fully self-contained: on load it injects its own namespaced DOM (#tx-overlay),
// opens its OWN WebSocket to the sim, listens for {type:"event"} messages that carry a
// real txHash (kind ∈ purchase|sale|fund), and prepends one row per payment with a
// pending→confirmed badge and a BaseScan click-through. It then polls the Base Sepolia
// RPC (eth_getTransactionReceipt) to flip each row from ⏳ pending to ✅ confirmed.
//
// Does NOT touch renderer/main.js or the map canvas — all IDs are #tx-* namespaced.
// Include with: <script src="./tx-overlay.js"></script>  (after main.js is fine).
(() => {
  "use strict";

  // ---- config ----
  const RPC_URL = "https://sepolia.base.org"; // Base Sepolia JSON-RPC
  const EXPLORER_TX = "https://sepolia.basescan.org/tx/"; // fallback if event omits `explorer`
  const POLL_MS = 4000; // receipt poll cadence
  const POLL_GIVEUP_MS = 5 * 60 * 1000; // stop polling a tx after 5 min (don't poll forever)
  const MAX_ROWS = 60; // cap DOM growth on long sessions

  // Renderer palette (matches index.html / main.js): bg #0b0b0a, amber #ff9100,
  // cyan #00d4ff, mint #6ee7b7, danger #ff5247.
  const C = { amber: "#ff9100", cyan: "#00d4ff", mint: "#6ee7b7", danger: "#ff5247", dim: "#6b6b66" };

  // ---- DOM injection (one styled glassy panel, bottom-right, monospace) ----
  const style = document.createElement("style");
  style.textContent = `
    #tx-overlay { position: fixed; right: 14px; bottom: 14px; width: 360px; max-height: 60vh;
      display: flex; flex-direction: column; z-index: 9999;
      background: rgba(8,8,7,.82); backdrop-filter: blur(8px) saturate(1.1);
      border: 1px solid #1f1f1d; border-radius: 10px; overflow: hidden;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; color: #fafaf5;
      box-shadow: 0 12px 40px rgba(0,0,0,.55); }
    #tx-overlay-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 9px 12px;
      font-size: 12px; letter-spacing: .04em; border-bottom: 1px solid #1a1a18;
      background: linear-gradient(180deg, rgba(255,145,0,.06), transparent); }
    #tx-overlay-head .tx-title { color: ${C.amber}; font-weight: 600; }
    #tx-overlay-head .tx-dot { width: 8px; height: 8px; border-radius: 50%;
      background: ${C.dim}; box-shadow: 0 0 6px transparent; }
    #tx-overlay-head .tx-dot.live { background: ${C.mint}; box-shadow: 0 0 8px ${C.mint}; }
    #tx-overlay-head .tx-count { margin-left: auto; color: ${C.dim}; font-size: 11px; }
    #tx-overlay-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 5px; }
    #tx-overlay-empty { color: ${C.dim}; font-size: 11px; padding: 14px 8px; text-align: center; line-height: 1.5; }
    .tx-row { border: 1px solid #1c1c1a; border-left: 3px solid ${C.dim}; border-radius: 7px;
      padding: 7px 9px; background: rgba(255,255,255,.015); font-size: 12px; line-height: 1.45;
      animation: tx-in .25s ease; }
    .tx-row.kind-purchase { border-left-color: ${C.amber}; }
    .tx-row.kind-sale { border-left-color: ${C.mint}; }
    .tx-row.kind-fund { border-left-color: ${C.cyan}; }
    .tx-row .tx-line1 { display: flex; align-items: baseline; gap: 6px; }
    .tx-row .tx-amt { color: ${C.amber}; font-weight: 600; }
    .tx-row.kind-sale .tx-amt { color: ${C.mint}; }
    .tx-row.kind-fund .tx-amt { color: ${C.cyan}; }
    .tx-row .tx-flow { color: #fafaf5; }
    .tx-row .tx-arrow { color: ${C.dim}; }
    .tx-row .tx-good { color: ${C.dim}; margin-left: auto; font-size: 11px; }
    .tx-row .tx-line2 { display: flex; align-items: center; gap: 7px; margin-top: 4px; }
    .tx-badge { font-size: 10.5px; padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
    .tx-badge.pending { color: ${C.amber}; background: rgba(255,145,0,.1); border: 1px solid rgba(255,145,0,.25); }
    .tx-badge.confirmed { color: ${C.mint}; background: rgba(110,231,183,.1); border: 1px solid rgba(110,231,183,.25); }
    .tx-badge.failed { color: ${C.danger}; background: rgba(255,82,71,.1); border: 1px solid rgba(255,82,71,.25); }
    .tx-link { margin-left: auto; color: ${C.cyan}; text-decoration: none; font-size: 11px;
      border: 1px solid rgba(0,212,255,.25); border-radius: 4px; padding: 1px 6px; }
    .tx-link:hover { background: rgba(0,212,255,.12); }
    .tx-hash { color: ${C.dim}; font-size: 10.5px; }
    @keyframes tx-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "tx-overlay";
  overlay.innerHTML = `
    <div id="tx-overlay-head">
      <span class="tx-dot" id="tx-overlay-dot"></span>
      <span class="tx-title">⛓ on-chain · base sepolia</span>
      <span class="tx-count" id="tx-overlay-count">0 tx</span>
    </div>
    <div id="tx-overlay-list">
      <div id="tx-overlay-empty">waiting for settlements…<br>x402 payments appear here, live</div>
    </div>`;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector("#tx-overlay-list");
  const emptyEl = overlay.querySelector("#tx-overlay-empty");
  const countEl = overlay.querySelector("#tx-overlay-count");
  const dotEl = overlay.querySelector("#tx-overlay-dot");

  // ---- helpers ----
  const short = (h) => (h && h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h || "");
  const fmtAmt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `$${n.toFixed(n < 0.01 ? 4 : 2)}` : String(v ?? "?");
  };
  // kind → who-paid-whom. For a purchase the actor is the buyer paying the counterparty (seller);
  // for a sale the counterparty (buyer) paid the actor (seller); fund flows treasury → actor.
  function flowFor(actor, kind, payload) {
    const cp = payload?.counterparty ?? payload?.to ?? payload?.from ?? "?";
    if (kind === "sale") return { from: cp, to: actor };
    if (kind === "fund") return { from: payload?.from ?? "treasury", to: actor };
    return { from: actor, to: cp }; // purchase (and any other txful kind)
  }

  const seen = new Set(); // txHash → already have a row (dedup purchase/sale pair → keep first)
  let txCount = 0;

  function addRow(ev) {
    const txHash = ev.txHash;
    if (!txHash || seen.has(txHash)) return;
    seen.add(txHash);

    const kind = ev.kind || "purchase";
    const p = ev.payload || {};
    const explorer = ev.explorer || EXPLORER_TX + txHash;
    const { from, to } = flowFor(ev.actor, kind, p);
    const good = p.item ?? p.good ?? "";

    if (emptyEl) emptyEl.style.display = "none";

    const row = document.createElement("div");
    row.className = `tx-row kind-${kind}`;
    row.dataset.tx = txHash;
    row.innerHTML = `
      <div class="tx-line1">
        <span class="tx-amt">${fmtAmt(p.price_usdc ?? p.amount ?? p.amount_usdc)}</span>
        <span class="tx-flow">${escapeHtml(from)} <span class="tx-arrow">→</span> ${escapeHtml(to)}</span>
        ${good ? `<span class="tx-good">${escapeHtml(good)}</span>` : ""}
      </div>
      <div class="tx-line2">
        <span class="tx-badge pending">⏳ pending</span>
        <span class="tx-hash">${short(txHash)}</span>
        <a class="tx-link" href="${escapeAttr(explorer)}" target="_blank" rel="noopener">BaseScan ↗</a>
      </div>`;
    listEl.prepend(row);

    txCount++;
    countEl.textContent = `${txCount} tx`;

    // trim old rows so a long run can't unbounded-grow the DOM
    while (listEl.querySelectorAll(".tx-row").length > MAX_ROWS) {
      listEl.querySelector(".tx-row:last-child")?.remove();
    }

    pollReceipt(txHash, row.querySelector(".tx-badge"), Date.now());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const escapeAttr = escapeHtml;

  // ---- RPC: poll eth_getTransactionReceipt until confirmed (or revert / give up) ----
  async function pollReceipt(txHash, badgeEl, startedAt) {
    if (!badgeEl) return;
    let receipt = null;
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      });
      receipt = (await res.json())?.result; // null while still pending
    } catch {
      /* transient RPC error — fall through and retry */
    }

    if (receipt) {
      const ok = receipt.status === "0x1";
      const block = parseInt(receipt.blockNumber, 16);
      badgeEl.className = `tx-badge ${ok ? "confirmed" : "failed"}`;
      badgeEl.textContent = ok ? `✅ confirmed · block ${block}` : `✖ reverted · block ${block}`;
      return; // terminal
    }

    if (Date.now() - startedAt > POLL_GIVEUP_MS) {
      badgeEl.textContent = "⏳ pending (slow)";
      return; // stop polling, but leave the BaseScan link for manual follow-up
    }
    setTimeout(() => pollReceipt(txHash, badgeEl, startedAt), POLL_MS);
  }

  // ---- our own WebSocket to the sim (separate from main.js's socket) ----
  function connect() {
    const ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => dotEl.classList.add("live");
    ws.onclose = () => {
      dotEl.classList.remove("live");
      setTimeout(connect, 2000); // auto-reconnect if the sim restarts
    };
    ws.onmessage = (msgEvt) => {
      let m;
      try { m = JSON.parse(msgEvt.data); } catch { return; }
      // We only care about economic events that settled on-chain (carry a txHash).
      if (m && m.type === "event" && m.txHash) addRow(m);
    };
  }
  connect();

  // Expose the render entry point so it can be driven from the console for verification.
  window.__txOverlay = { addRow };
})();
