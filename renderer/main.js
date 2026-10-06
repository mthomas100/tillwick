// Read-only top-down renderer + live activity feed. Subscribes to the sim's WS.
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("hud");
const rowsEl = document.getElementById("rows");
const tallyEl = document.getElementById("tally");

let world = null;
let agents = [];
let tick = 0;
const colorByActor = {};
const speech = {}; // actor -> { text, t }
const renderPos = {}; // id -> { x, y } interpolated for smooth walking between tiles
const pos = (a) => renderPos[a.id] || { x: a.x, y: a.y };
window.__townRenderPos = renderPos; // exposed so inspector.js hit-tests clicks accurately mid-walk
window.__townDrawPos = {}; // id -> { x, y } *fanned* draw positions (tile units); inspector.js hit-tests these first

// Several citizens can legitimately share one tile (a shop has a single "door-inside" tile, so 2-5
// pile onto it). That's fine for the sim — but their circular sprites would render stacked. So we
// spread the SPRITES (not the sim positions): each member of a co-located group gets a small,
// DETERMINISTIC offset around the shared tile center. Same id in the same group => same spot every
// frame (sorted by id), so there's no jitter/flicker. A solo agent gets zero offset (unchanged).
const FAN_RADIUS = 0.28; // tiles; ring on which a crowded tile's sprites are arranged
let fanOffsets = {}; // recomputed once per draw(): id -> { dx, dy } in tile units
function computeFanOffsets() {
  const groups = new Map(); // "tx,ty" -> [agent, ...] grouped by rounded rendered tile
  for (const a of agents) {
    const p = pos(a);
    const key = Math.round(p.x) + "," + Math.round(p.y);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(a);
  }
  const out = {};
  for (const g of groups.values()) {
    if (g.length < 2) { out[g[0].id] = { dx: 0, dy: 0 }; continue; }
    g.sort((m, n) => String(m.id).localeCompare(String(n.id))); // stable order -> stable spots
    const n = g.length;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2; // i=0 -> right; N=2 -> right+left; N>=3 -> around a circle
      out[g[i].id] = { dx: Math.cos(ang) * FAN_RADIUS, dy: Math.sin(ang) * FAN_RADIUS };
    }
  }
  return out;
}
// Interpolated tile position + this frame's fan offset. Use for EVERYTHING drawn for an agent so the
// whole avatar (sprite, label, moving-ring, link endpoints, bubble) moves together.
const drawPos = (a) => {
  const p = pos(a), o = fanOffsets[a.id] || { dx: 0, dy: 0 };
  return { x: p.x + o.dx, y: p.y + o.dy };
};

// ---------- map ----------
function fit() {
  canvas.width = world.width * world.tile;
  canvas.height = world.height * world.tile;
}
function rememberColors() {
  for (const a of agents) colorByActor[a.id] = a.color;
}
function draw() {
  if (!world) return;
  const T = world.tile;
  // Spread co-located sprites; publish the fanned positions for inspector.js click hit-testing.
  fanOffsets = computeFanOffsets();
  const dpos = {};
  for (const a of agents) dpos[a.id] = drawPos(a);
  window.__townDrawPos = dpos;
  const streetTop = world.street.rows[0];
  ctx.fillStyle = "#14241a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#3a3a36";
  for (const r of world.sidewalks.rows) ctx.fillRect(0, r * T, canvas.width, T);
  ctx.fillStyle = "#1c1c1e";
  for (const r of world.street.rows) ctx.fillRect(0, r * T, canvas.width, T);
  const midY = (streetTop + 1) * T;
  ctx.strokeStyle = "#ffb300";
  ctx.lineWidth = 2;
  ctx.setLineDash([T * 0.5, T * 0.4]);
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(canvas.width, midY); ctx.stroke();
  ctx.setLineDash([]);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const b of world.buildings) {
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x * T, b.y * T, b.w * T, b.h * T);
    ctx.strokeStyle = "rgba(0,0,0,.45)";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x * T, b.y * T, b.w * T, b.h * T);
    const topB = b.y < streetTop;
    const edgeY = (topB ? b.y + b.h : b.y) * T;
    ctx.fillStyle = "#0b0b0a";
    ctx.fillRect(b.door.x * T + T * 0.15, edgeY - T * 0.3, T * 0.7, T * 0.6);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = `600 ${Math.floor(T * 0.5)}px ui-monospace, monospace`;
    ctx.fillText(b.label, (b.x + b.w / 2) * T, (b.y + b.h / 2) * T);
  }

  // adjacency links
  ctx.strokeStyle = "rgba(110,231,183,.55)";
  ctx.lineWidth = 2;
  const seen = new Set();
  for (const a of agents) for (const oid of a.adjacentTo || []) {
    const k = [a.id, oid].sort().join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    const o = agents.find((z) => z.id === oid);
    if (!o) continue;
    const pa = drawPos(a), po = drawPos(o);
    ctx.beginPath();
    ctx.moveTo(pa.x * T + T / 2, pa.y * T + T / 2);
    ctx.lineTo(po.x * T + T / 2, po.y * T + T / 2);
    ctx.stroke();
  }

  for (const a of agents) {
    const ap = drawPos(a);
    const cx = ap.x * T + T / 2, cy = ap.y * T + T / 2;
    if (a.moving) {
      ctx.beginPath(); ctx.arc(cx, cy, T * 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(250,250,245,.35)"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.beginPath(); ctx.arc(cx, cy, T * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = a.color; ctx.fill();
    ctx.strokeStyle = "#0b0b0a"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#fafaf5";
    ctx.font = `${Math.floor(T * 0.42)}px ui-monospace, monospace`;
    ctx.fillText(a.id, cx, cy - T * 0.62);
    const sp = speech[a.id];
    if (sp && Date.now() - sp.t < 6000 && sp.text) drawBubble(cx, cy - T * 1.1, sp.text);
  }

  const moving = agents.filter((a) => a.moving).length;
  hud.innerHTML =
    `<b>${world.title}</b> · ${agents.length} citizens · <span class="live">${moving}</span> walking · tick <span class="live">${tick}</span>` +
    `<br><span class="dim">top-down view · green links = citizens who met</span>`;
}
function drawBubble(x, y, text) {
  const t = text.length > 38 ? text.slice(0, 36) + "…" : text;
  ctx.font = "11px ui-monospace, monospace";
  const w = ctx.measureText(t).width + 12;
  ctx.fillStyle = "rgba(250,250,245,.95)";
  roundRect(x - w / 2, y - 14, w, 18, 5); ctx.fill();
  ctx.fillStyle = "#0b0b0a";
  ctx.fillText(t, x, y - 5);
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- feed ----------
const KIND_CAT = { purchase: "pay", sale: "pay", fund: "pay", say: "talk", decision: "think", skip: "think", consume: "think", move: "move" };
const active = new Set(["pay", "talk", "think"]);
const spent = {};
const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const who = (a) => `<span class="who" style="color:${colorByActor[a] || "#999"}">${esc(a)}</span>`;

document.querySelectorAll(".chip").forEach((ch) =>
  ch.addEventListener("click", () => {
    const f = ch.dataset.f;
    if (f === "all") { ["pay", "talk", "think", "move"].forEach((c) => active.add(c)); }
    else { active.has(f) ? active.delete(f) : active.add(f); }
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
  rowsEl.querySelectorAll(".row").forEach((r) => (r.style.display = active.has(r.dataset.cat) ? "" : "none"));
}
function addEvent(ev) {
  const p = ev.payload || {};
  const cat = KIND_CAT[ev.kind] || "move";
  const link = ev.explorer ? ` · <a href="${esc(ev.explorer)}" target="_blank" rel="noopener">tx ↗</a>` : "";
  let html;
  if (ev.kind === "say") {
    html = `🗣 ${who(ev.actor)} → ${esc(p.to || "?")}: "${esc(p.text || "")}"`;
    speech[ev.actor] = { text: p.text, t: Date.now() };
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
  } else {
    html = `${who(ev.actor)} ${esc(ev.kind)}`;
  }
  const div = document.createElement("div");
  div.className = "row" + (cat === "pay" ? " pay" : cat === "think" ? " think" : cat === "move" ? " move" : "");
  div.dataset.cat = cat;
  div.style.borderLeftColor = colorByActor[ev.actor] || "#333";
  div.innerHTML = html;
  if (!active.has(cat)) div.style.display = "none";
  rowsEl.prepend(div);
  while (rowsEl.children.length > 200) rowsEl.removeChild(rowsEl.lastChild);
  renderTally();
}
function renderTally() {
  const actors = Object.keys(spent).sort((a, b) => spent[b] - spent[a]);
  if (!actors.length) { tallyEl.innerHTML = '<span class="dim">no spending yet</span>'; return; }
  const max = Math.max(...actors.map((a) => spent[a]), 0.0001);
  tallyEl.innerHTML =
    '<div class="dim" style="margin-bottom:4px;">spent this session (USDC)</div>' +
    actors.map((a) => `<div>${who(a)} <span class="amt">$${spent[a].toFixed(3)}</span></div>` +
      `<div class="bar" style="width:${Math.round((100 * spent[a]) / max)}%;background:${colorByActor[a] || "#888"}"></div>`).join("");
}
syncChips();

// ---------- socket ----------
function syncTargets() {
  for (const a of agents) if (!renderPos[a.id]) renderPos[a.id] = { x: a.x, y: a.y };
}
let started = false;
function animate() {
  for (const a of agents) {
    const rp = renderPos[a.id];
    if (rp) { rp.x += (a.x - rp.x) * 0.2; rp.y += (a.y - rp.y) * 0.2; } // ease toward the tile target
  }
  draw();
  requestAnimationFrame(animate);
}
const ws = new WebSocket(`ws://${location.host}`);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "world") {
    world = m.world; agents = m.agents; rememberColors(); syncTargets(); fit();
    if (!started) { started = true; requestAnimationFrame(animate); }
  } else if (m.type === "tick") {
    tick = m.tick; agents = m.agents; rememberColors(); syncTargets();
  } else if (m.type === "event") {
    addEvent(m);
  }
};
ws.onclose = () => { hud.innerHTML = `<b>disconnected</b> <span class="dim">— is the sim running?</span>`; };
