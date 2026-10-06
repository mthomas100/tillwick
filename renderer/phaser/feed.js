// renderer/phaser/feed.js — the live ACTIVITY FEED + spend tally (ported verbatim in behavior from the feed
// half of renderer/main.js, so replacing main.js with the Phaser renderer loses nothing). Pure DOM; it owns
// the #rows / #tally / .chip elements that already exist in index.html. The Phaser scene draws the MAP; this
// draws the SIDEBAR. Kept as its own module so the engine (town-scene.js) stays view-only and feed logic
// lives in one place.
//
// Exposes createFeed({ colorByActor }) -> { addEvent(ev) }. colorByActor is shared (the renderer fills it as
// agents arrive) so feed rows + bars match sprite colors.

// online/offline are STATUS events (a citizen booted / exited) — categorize them as "talk" so they live in the
// conversation stream (and show under "all"); they render as a distinct system line, not a say.
const KIND_CAT = { purchase: "pay", sale: "pay", fund: "pay", say: "talk", online: "talk", offline: "talk", decision: "think", skip: "think", consume: "think", status: "think", move: "move" };
const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// A stable key per feed item, so hydration (replaying the backlog) and the live WS stream can't double-render
// the same event in the overlap window. Events carry the sim's `ts`; dialogues carry a unique `id`.
const eventKey = (ev) => `e:${ev.ts || ""}|${ev.actor || ""}|${ev.kind || ""}`;
const dialogueKey = (d) => `d:${d.id || (d.participants || []).join("-") + ":" + (d.endedAtGameMin ?? "")}`;

// Inject the feed's own status-line styles ONCE (kept here, not in index.html which is a hot/convergence file —
// mirrors how inspector.js scopes its styles). Online/offline rows read as quiet SYSTEM lines, set apart from
// says/trades: dimmer, italic, a tinted left border + a colored status dot (green online / grey offline).
function ensureFeedStyles() {
  if (typeof document === "undefined" || document.getElementById("feed-sys-styles")) return;
  const s = document.createElement("style");
  s.id = "feed-sys-styles";
  s.textContent = `
    #rows .row.sys { background: #0e0e0d; font-style: italic; color: #cfcfc8; }
    #rows .row.sys .who { font-style: normal; }
    #rows .row.sys .dim { color: #8a8a82; }
    #rows .row.sys .dot-online { color: #6ee7b7; font-style: normal; }
    #rows .row.sys .dot-offline { color: #6b6b66; font-style: normal; }
  `;
  document.head.appendChild(s);
}

export function createFeed({ colorByActor }) {
  ensureFeedStyles();
  const rowsEl = document.getElementById("rows");
  const tallyEl = document.getElementById("tally");
  const active = new Set(["pay", "talk", "think"]);
  const spent = {};
  const seen = new Set(); // de-dupe keys (hydration backlog vs. live WS overlap) — see eventKey/dialogueKey
  const who = (a) => `<span class="who" style="color:${colorByActor[a] || "#999"}">${esc(a)}</span>`;

  document.querySelectorAll(".chip").forEach((ch) =>
    ch.addEventListener("click", () => {
      const f = ch.dataset.f;
      if (f === "all") ["pay", "talk", "think", "move"].forEach((c) => active.add(c));
      else active.has(f) ? active.delete(f) : active.add(f);
      syncChips(); applyFilter();
    }),
  );
  function syncChips() {
    document.querySelectorAll(".chip").forEach((ch) => {
      const f = ch.dataset.f;
      ch.classList.toggle("on", f === "all" ? active.size >= 4 : active.has(f));
    });
  }
  function applyFilter() {
    rowsEl?.querySelectorAll(".row").forEach((r) => (r.style.display = active.has(r.dataset.cat) ? "" : "none"));
  }

  function addEvent(ev) {
    if (!rowsEl) return;
    const k = eventKey(ev);
    if (seen.has(k)) return; // already rendered (hydration/live overlap)
    seen.add(k);
    const p = ev.payload || {};
    const cat = KIND_CAT[ev.kind] || "move";
    const link = ev.explorer ? ` · <a href="${esc(ev.explorer)}" target="_blank" rel="noopener">tx ↗</a>` : "";
    let html;
    let sys = false; // system/status line (online/offline) — styled apart from says/trades
    if (ev.kind === "online") {
      sys = true;
      html = `<span class="dot-online">●</span> ${who(ev.actor)} <span class="dim">${esc(p.name ? p.name + " " : "")}came online</span>`;
    } else if (ev.kind === "offline") {
      sys = true;
      html = `<span class="dot-offline">●</span> ${who(ev.actor)} <span class="dim">${esc(p.name ? p.name + " " : "")}went offline</span>`;
    } else if (ev.kind === "say") {
      html = `🗣 ${who(ev.actor)} → ${esc(p.to || "?")}: "${esc(p.text || "")}"`;
    } else if (ev.kind === "purchase") {
      html = `💸 ${who(ev.actor)} → ${esc(p.counterparty || p.shop || "shop")} <span class="amt">$${esc(p.price_usdc || p.price || "")}</span> ${esc(p.item || "")}${link}`;
      if (p.price_usdc) spent[ev.actor] = (spent[ev.actor] || 0) + Number(p.price_usdc);
    } else if (ev.kind === "sale") {
      html = `🪙 ${who(ev.actor)} sold ${esc(p.item || "")} to ${esc(p.counterparty || "?")} <span class="amt">$${esc(p.price_usdc || "")}</span>${link}`;
    } else if (ev.kind === "fund") {
      html = `🏦 treasury → ${who(ev.actor)} <span class="amt">$${esc(p.amount || p.price_usdc || "")}</span>${link}`;
    } else if (ev.kind === "decision" || ev.kind === "skip") {
      const did = p.worth === false || ev.kind === "skip" ? "skipped" : "eyeing";
      html = `🤔 ${who(ev.actor)} ${did} ${esc(p.item || "")} ${p.price_usdc ? `($${esc(p.price_usdc)})` : ""}${p.reason ? ` — "${esc(p.reason)}"` : ""}`;
    } else if (ev.kind === "consume") {
      html = `🍽 ${who(ev.actor)} used ${esc(p.item || "")}${p.remaining != null ? ` (${esc(p.remaining)} left)` : ""}`;
    } else if (ev.kind === "status") {
      // A3-2: a role-action status ("🥖 baker baking…") — a quiet think-row mirroring the on-map status bubble.
      html = `${esc(p.emoji || "🛠")} ${who(ev.actor)} <span class="dim">${esc(p.text || p.verb || "working…")}</span>`;
    } else {
      html = `${who(ev.actor)} ${esc(ev.kind)}`;
    }
    const div = document.createElement("div");
    div.className = "row" + (sys ? " sys" : cat === "pay" ? " pay" : cat === "think" ? " think" : cat === "move" ? " move" : "");
    div.dataset.cat = cat;
    div.style.borderLeftColor = sys ? (ev.kind === "online" ? "#6ee7b7" : "#6b6b66") : (colorByActor[ev.actor] || "#333");
    div.innerHTML = html;
    if (!active.has(cat)) div.style.display = "none";
    rowsEl.prepend(div);
    while (rowsEl.children.length > 200) rowsEl.removeChild(rowsEl.lastChild);
    renderTally();
  }

  // A conversation just closed — surface it in the feed as a talk row (NEW; dialogue records weren't shown).
  function addDialogue(d) {
    if (!rowsEl || !d || d.outcome !== "conversed") return;
    const dk = dialogueKey(d);
    if (seen.has(dk)) return; // hydration/live overlap
    seen.add(dk);
    const [a, b] = d.participants || [];
    const div = document.createElement("div");
    div.className = "row";
    div.dataset.cat = "talk";
    div.style.borderLeftColor = colorByActor[a] || "#333";
    div.innerHTML = `💬 ${who(a)} ↔ ${who(b)} <span class="dim">— ${esc(d.topic || "talked")}</span>${d.turns ? ` <span class="dim">(${esc(d.turns)} turns)</span>` : ""}`;
    if (!active.has("talk")) div.style.display = "none";
    rowsEl.prepend(div);
    while (rowsEl.children.length > 200) rowsEl.removeChild(rowsEl.lastChild);
  }

  function renderTally() {
    if (!tallyEl) return;
    const actors = Object.keys(spent).sort((a, b) => spent[b] - spent[a]);
    if (!actors.length) { tallyEl.innerHTML = '<span class="dim">no spending yet</span>'; return; }
    const max = Math.max(...actors.map((a) => spent[a]), 0.0001);
    tallyEl.innerHTML =
      '<div class="dim" style="margin-bottom:4px;">spent this session (USDC)</div>' +
      actors.map((a) => `<div>${who(a)} <span class="amt">$${spent[a].toFixed(3)}</span></div>` +
        `<div class="bar" style="width:${Math.round((100 * spent[a]) / max)}%;background:${colorByActor[a] || "#888"}"></div>`).join("");
  }

  // HYDRATE the feed from a recent-event backlog so a browser refresh mid-run doesn't blank the panel. The
  // backlog is fetched once on WS-open and replayed through the SAME addEvent/addDialogue paths the live stream
  // uses (so history renders identically). Replays OLDEST→NEWEST: since each row is prepended, the newest backlog
  // item lands on top, below any live event that arrived first; the `seen` de-dupe makes the overlap idempotent.
  // Accepts either { events:[...], dialogues:[...] } or a bare events array. Tolerant + best-effort (never throws).
  function hydrate(backlog) {
    if (!backlog) return { events: 0, dialogues: 0 };
    const events = Array.isArray(backlog) ? backlog : (Array.isArray(backlog.events) ? backlog.events : []);
    const dialogues = Array.isArray(backlog) ? [] : (Array.isArray(backlog.dialogues) ? backlog.dialogues : []);
    // oldest→newest by wall-clock ts (events) — backlog may arrive in either order; sort defensively.
    const evs = events.slice().sort((x, y) => String(x.ts || "").localeCompare(String(y.ts || "")));
    for (const ev of evs) { try { addEvent(ev); } catch { /* skip a malformed backlog row */ } }
    // dialogues use game-minutes; render after events, oldest→newest.
    const dls = dialogues.slice().sort((x, y) => (x.endedAtGameMin ?? 0) - (y.endedAtGameMin ?? 0));
    for (const d of dls) { try { addDialogue(d); } catch { /* skip */ } }
    return { events: evs.length, dialogues: dls.length };
  }

  syncChips();
  return { addEvent, addDialogue, hydrate };
}
