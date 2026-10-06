// W0 Operator Control Plane — self-contained overlay panel.
//
// Provides: run controls (start/pause/resume/stop), mandatory duration opt-in,
// per-agent enable/model toggles, live token meter, and run-state display.
//
// DATA: GET /run-state + GET /usage on load; then subscribes to the EXISTING
// sim WebSocket for {type:"run-state"} and {type:"usage"} live broadcasts.
// (Reuses the same WS event stream that main.js and tx-overlay.js use — no
// separate socket; we subscribe via a shared onmessage multiplexer.)
//
// Do NOT import / bundle — vanilla ES matching the surrounding renderer.
// Include with: <script src="./control.js"></script>  (after layout.css).
(() => {
  "use strict";

  // ---- palette (matches index.html / main.js) ----
  const MODEL_OPTIONS = [
    { value: "claude-haiku-4-5-20251001", label: "haiku-4-5" },
    { value: "claude-sonnet-5-5",         label: "sonnet-5-5" },
    { value: "claude-opus-5-5",           label: "opus-5-5" },
  ];

  // Agent-dot colours — pulled from the live world state when available, else
  // we fall back to the color the sim assigned. Track here so dots stay stable.
  const agentColors = {}; // id -> hex color

  // ---- state ----
  let runState = null;  // last-known GET /run-state or WS run-state payload
  let usageData = null; // last-known GET /usage  or WS usage payload

  // Duration selection. null until operator actively picks one.
  // { kind: "minutes"|"game-days"|"forever", value, label }
  let selectedDuration = null;
  // True once "forever" has been explicitly confirmed in the two-step flow.
  let foreverConfirmed = false;

  const DURATION_PRESETS = [
    { kind: "minutes",    value: 15,        label: "15m" },
    { kind: "minutes",    value: 60,        label: "1h" },
    { kind: "minutes",    value: 240,       label: "4h" },
    { kind: "game-days",  value: 1,         label: "game-day 1" },
    { kind: "forever",    value: null,       label: "forever" },
  ];

  // ---- helpers ----
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  const fmtUsd = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    if (n < 0.0001) return "$0.0000";
    return "$" + n.toFixed(n < 0.01 ? 4 : n < 1 ? 3 : 2);
  };

  const fmtMs = (ms) => {
    if (!ms || !isFinite(ms)) return "—";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  const fmtGameClock = (gc) => {
    if (!gc) return "—";
    const hh = String(gc.hh ?? 0).padStart(2, "0");
    const mm = String(gc.mm ?? 0).padStart(2, "0");
    return `day ${gc.day ?? 0}  ${hh}:${mm}`;
  };

  const fmtRate = (usd, ticks) => {
    // If we have USD and ticks, show $/min as a rough approximation.
    // The sim ticks every ~N seconds (we don't know the exact period here),
    // so we label it "est" and fall back to showing ticks/min if usd=0.
    if (!ticks || ticks < 1) return "";
    if (usd && usd > 0) {
      // approximate: show per-100-tick rate as a proxy until the sim emits timestamps
      const rate = (usd / ticks) * 10; // ≈ $/100-ticks
      return `~${fmtUsd(rate)}/100t`;
    }
    return `${ticks} ticks`;
  };

  // POST /control — fire and forget (log errors, don't block UI).
  function postControl(body) {
    fetch("/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((err) => {
      console.warn("[ctrl] POST /control failed:", err);
    });
  }

  // ---- DOM injection ----
  // Panel (collapsed by default, toggled with the tab button)
  const panel = document.createElement("div");
  panel.id = "ctrl-panel";
  panel.innerHTML = `
    <div class="ctrl-sec">
      <span class="ctrl-dot" id="ctrl-live-dot"></span>
      <span>OPERATOR CONTROL PLANE</span>
    </div>

    <!-- 1. RUN STATE -->
    <div id="ctrl-run-status">
      <span class="ctrl-status-badge stopped" id="ctrl-status-badge">STOPPED</span>
      <span class="ctrl-status-reason" id="ctrl-status-reason">—</span>
    </div>
    <div id="ctrl-clock-row">
      <span>
        <span class="ctrl-clock-label">CLOCK </span>
        <span class="ctrl-clock-val" id="ctrl-game-clock">—</span>
      </span>
      <span>
        <span class="ctrl-clock-label">VIEWERS </span>
        <span class="ctrl-viewers-val" id="ctrl-viewers">—</span>
      </span>
    </div>
    <div id="ctrl-elapsed-row">
      <span>
        <span class="ctrl-clock-label">ELAPSED </span>
        <span class="ctrl-clock-val" id="ctrl-elapsed">—</span>
      </span>
      <span>
        <span class="ctrl-clock-label">REMAINING </span>
        <span class="ctrl-clock-val" id="ctrl-remaining">—</span>
      </span>
    </div>

    <!-- 2. DURATION OPT-IN -->
    <div class="ctrl-sec"><span>DURATION (required before start)</span></div>
    <div id="ctrl-duration-area">
      <div class="ctrl-dur-label">Choose a run ceiling — Start is disabled until you pick one.</div>
      <div class="ctrl-dur-presets" id="ctrl-dur-presets"></div>
      <div id="ctrl-forever-confirm">
        <strong>Run forever?</strong> This disables automatic stop. Only use for long manual sessions
        where you'll actively monitor burn.
        <br>
        <button id="ctrl-forever-yes">Yes, run forever</button>
        <button id="ctrl-forever-cancel">Cancel</button>
      </div>
    </div>

    <!-- 3. RUN CONTROLS -->
    <div class="ctrl-sec"><span>CONTROLS</span></div>
    <div id="ctrl-run-btns">
      <button class="ctrl-btn start" id="ctrl-btn-start" disabled>▶ Start</button>
      <button class="ctrl-btn pause" id="ctrl-btn-pause" disabled>⏸ Pause</button>
      <button class="ctrl-btn resume" id="ctrl-btn-resume" disabled>↺ Resume</button>
      <button class="ctrl-btn stop"  id="ctrl-btn-stop"  disabled>■ Stop</button>
    </div>

    <!-- 4. TOKEN METER -->
    <div class="ctrl-sec">
      <span class="ctrl-dot" id="ctrl-meter-dot"></span>
      <span>TOKEN METER</span>
    </div>
    <div id="ctrl-meter-area">
      <div class="ctrl-meter-label">
        <em>API list-price cost (billed with an API key; notional on a subscription)</em>
      </div>
      <div class="ctrl-meter-top">
        <span id="ctrl-fleet-usd">$0.0000</span>
        <span id="ctrl-fleet-rate"></span>
        <span id="ctrl-fleet-ceiling"></span>
      </div>
      <div class="ctrl-bar-track">
        <div class="ctrl-bar-fill" id="ctrl-bar-fill" style="width:0%"></div>
      </div>
      <div class="ctrl-agent-rows" id="ctrl-agent-meter-rows"></div>
    </div>

    <!-- 5. PER-AGENT ROSTER -->
    <div class="ctrl-sec"><span>AGENTS</span></div>
    <div id="ctrl-roster-area">
      <div class="ctrl-roster-rows" id="ctrl-roster-rows">
        <span style="color:#6b6b66;font-size:11px;padding:4px 0;">waiting for roster…</span>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // Toggle button (always visible)
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "ctrl-toggle";
  toggleBtn.textContent = "⚙ CTRL";
  document.body.appendChild(toggleBtn);

  // ---- wire toggle ----
  let panelOpen = false;
  function togglePanel(open) {
    panelOpen = typeof open === "boolean" ? open : !panelOpen;
    panel.classList.toggle("open", panelOpen);
    toggleBtn.classList.toggle("panel-open", panelOpen);
    toggleBtn.textContent = panelOpen ? "✕ CTRL" : "⚙ CTRL";
  }
  toggleBtn.addEventListener("click", () => togglePanel());

  // ---- element refs (resolved after injection) ----
  const el = (id) => document.getElementById(id);
  const liveDot    = el("ctrl-live-dot");
  const statusBadge = el("ctrl-status-badge");
  const statusReason = el("ctrl-status-reason");
  const gameClock  = el("ctrl-game-clock");
  const viewersEl  = el("ctrl-viewers");
  const elapsedEl  = el("ctrl-elapsed");
  const remainingEl = el("ctrl-remaining");
  const durPresets = el("ctrl-dur-presets");
  const foreverConfirm = el("ctrl-forever-confirm");
  const foreverYes   = el("ctrl-forever-yes");
  const foreverCancel = el("ctrl-forever-cancel");
  const btnStart   = el("ctrl-btn-start");
  const btnPause   = el("ctrl-btn-pause");
  const btnResume  = el("ctrl-btn-resume");
  const btnStop    = el("ctrl-btn-stop");
  const fleetUsd   = el("ctrl-fleet-usd");
  const fleetRate  = el("ctrl-fleet-rate");
  const fleetCeiling = el("ctrl-fleet-ceiling");
  const barFill    = el("ctrl-bar-fill");
  const agentMeterRows = el("ctrl-agent-meter-rows");
  const rosterRows = el("ctrl-roster-rows");

  // ---- duration presets ----
  DURATION_PRESETS.forEach((preset) => {
    const btn = document.createElement("button");
    btn.className = "ctrl-dur-btn" + (preset.kind === "forever" ? " forever" : "");
    btn.dataset.kind = preset.kind;
    btn.dataset.value = preset.value ?? "";
    btn.textContent = preset.label;
    btn.addEventListener("click", () => onDurationClick(preset, btn));
    durPresets.appendChild(btn);
  });

  function onDurationClick(preset, btn) {
    // Clear all selections visually first.
    durPresets.querySelectorAll(".ctrl-dur-btn").forEach((b) => b.classList.remove("selected"));

    if (preset.kind === "forever") {
      // Two-step confirmation: show confirm box first; don't mark as selected yet.
      foreverConfirm.classList.add("visible");
      btn.classList.add("selected"); // highlight pending confirm
      foreverConfirmed = false;
      selectedDuration = null;
      refreshButtons();
      return;
    }

    // Non-forever: select immediately.
    foreverConfirm.classList.remove("visible");
    btn.classList.add("selected");
    foreverConfirmed = false;
    selectedDuration = preset;
    refreshButtons();
  }

  foreverYes.addEventListener("click", () => {
    foreverConfirmed = true;
    selectedDuration = DURATION_PRESETS.find((p) => p.kind === "forever");
    foreverConfirm.classList.remove("visible");
    refreshButtons();
  });

  foreverCancel.addEventListener("click", () => {
    foreverConfirm.classList.remove("visible");
    durPresets.querySelectorAll(".ctrl-dur-btn").forEach((b) => b.classList.remove("selected"));
    selectedDuration = null;
    foreverConfirmed = false;
    refreshButtons();
  });

  // ---- button wiring ----
  btnStart.addEventListener("click", () => {
    if (!selectedDuration) return; // guard (shouldn't be reachable — button is disabled)
    postControl({ action: "start", duration: { kind: selectedDuration.kind, value: selectedDuration.value } });
  });
  btnPause.addEventListener("click", () => postControl({ action: "pause" }));
  btnResume.addEventListener("click", () => postControl({ action: "resume" }));
  btnStop.addEventListener("click",  () => {
    if (!confirm("Stop the sim? All citizens will idle until restarted.")) return;
    postControl({ action: "stop" });
  });

  // ---- run state render ----
  function refreshButtons() {
    const status = runState ? runState.status : "stopped";
    const durOk = !!(selectedDuration && (selectedDuration.kind !== "forever" || foreverConfirmed));

    btnStart.disabled  = !durOk || status === "running";
    btnPause.disabled  = status !== "running";
    btnResume.disabled = status !== "paused";
    btnStop.disabled   = status === "stopped";
  }

  function renderRunState(rs) {
    if (!rs) return;
    runState = rs;

    // Status badge
    const s = rs.status || "stopped";
    statusBadge.className = `ctrl-status-badge ${s}`;
    statusBadge.textContent = s.toUpperCase();

    // Reason
    const reasonMap = {
      "no-viewer":        "paused: no viewer",
      "duration-elapsed": "stopped: duration elapsed",
      "budget-ceiling":   "stopped: budget ceiling hit",
      "operator":         "stopped: operator",
    };
    statusReason.textContent = rs.reason ? (reasonMap[rs.reason] || rs.reason) : "—";

    // Game clock
    gameClock.textContent = fmtGameClock(rs.gameClock);
    viewersEl.textContent = rs.viewers != null ? String(rs.viewers) : "—";

    // Elapsed / remaining
    const elapsed = rs.elapsedMs != null ? rs.elapsedMs : null;
    elapsedEl.textContent = elapsed != null ? fmtMs(elapsed) : "—";

    // Remaining: compute from duration kind/value if available
    const dur = rs.duration;
    if (dur && dur.kind === "minutes" && dur.value != null && elapsed != null) {
      const totalMs = dur.value * 60 * 1000;
      const rem = Math.max(0, totalMs - elapsed);
      remainingEl.textContent = fmtMs(rem);
    } else if (dur && dur.kind === "forever") {
      remainingEl.textContent = "∞";
    } else if (dur && dur.kind === "game-days") {
      const gc = rs.gameClock;
      if (gc) {
        remainingEl.textContent = `until day ${(dur.value || 1) + 1}`;
      } else {
        remainingEl.textContent = "—";
      }
    } else {
      remainingEl.textContent = "—";
    }

    refreshButtons();

    // If the sim tells us the roster (it may not on very early states)
    if (Array.isArray(rs.roster) && rs.roster.length) {
      mergeRoster(rs.roster);
    }
  }

  // ---- roster ----
  // Keyed by id; we render from this so partial updates are additive.
  const roster = {}; // id -> { id, name, enabled, model }

  function mergeRoster(entries) {
    entries.forEach((e) => {
      if (!e.id) return;
      roster[e.id] = Object.assign(roster[e.id] || {}, e);
    });
    renderRoster();
  }

  function renderRoster() {
    const ids = Object.keys(roster);
    if (!ids.length) return;

    // Stable sort by id
    ids.sort((a, b) => String(a).localeCompare(String(b)));

    // Keep existing rows for IDs already rendered; add missing; remove stale.
    const existingById = {};
    rosterRows.querySelectorAll(".ctrl-roster-row").forEach((row) => {
      existingById[row.dataset.agentId] = row;
    });

    // Remove stale
    Object.keys(existingById).forEach((id) => {
      if (!roster[id]) existingById[id].remove();
    });

    ids.forEach((id) => {
      const agent = roster[id];
      const color = agentColors[id] || "#6b6b66";
      const enabled = agent.enabled !== false;
      let row = existingById[id];

      if (!row) {
        row = document.createElement("div");
        row.className = "ctrl-roster-row";
        row.dataset.agentId = id;
        row.innerHTML = buildRosterRowHTML(agent, color, enabled);
        rosterRows.appendChild(row);
        wireRosterRow(row, agent);
      } else {
        // Update enabled state + dot colour without full rebuild (avoids flicker).
        row.classList.toggle("disabled-agent", !enabled);
        const dot = row.querySelector(".ctrl-agent-dot");
        if (dot) {
          dot.classList.toggle("enabled", enabled);
          dot.style.background = enabled ? (color !== "#6b6b66" ? color : "") : "";
        }
        const chk = row.querySelector(".ctrl-roster-toggle");
        if (chk) chk.checked = enabled;
        const sel = row.querySelector(".ctrl-model-select");
        if (sel && agent.model) sel.value = agent.model;
      }
    });
  }

  function buildRosterRowHTML(agent, color, enabled) {
    const modelOpts = MODEL_OPTIONS.map((m) =>
      `<option value="${esc(m.value)}"${agent.model === m.value ? " selected" : ""}>${esc(m.label)}</option>`
    ).join("");
    return `
      <span class="ctrl-agent-dot${enabled ? " enabled" : ""}" style="background:${esc(enabled ? color : "")}"></span>
      <span class="ctrl-roster-name">${esc(agent.name || agent.id)}</span>
      <label class="ctrl-toggle-wrap" title="${esc(enabled ? "Disable" : "Enable")} ${esc(agent.name || agent.id)}">
        <input type="checkbox" class="ctrl-roster-toggle"${enabled ? " checked" : ""}>
        <span class="ctrl-toggle-track"></span>
      </label>
      <select class="ctrl-model-select">${modelOpts}</select>
    `;
  }

  function wireRosterRow(row, agent) {
    const chk = row.querySelector(".ctrl-roster-toggle");
    const sel = row.querySelector(".ctrl-model-select");
    if (chk) {
      chk.addEventListener("change", () => {
        const enabled = chk.checked;
        // Optimistic local update
        if (roster[agent.id]) roster[agent.id].enabled = enabled;
        row.classList.toggle("disabled-agent", !enabled);
        const dot = row.querySelector(".ctrl-agent-dot");
        if (dot) {
          dot.classList.toggle("enabled", enabled);
          dot.style.background = enabled ? (agentColors[agent.id] || "") : "";
        }
        postControl({ action: "set-agent", id: agent.id, enabled });
      });
    }
    if (sel) {
      sel.addEventListener("change", () => {
        const model = sel.value;
        if (roster[agent.id]) roster[agent.id].model = model;
        postControl({ action: "set-agent", id: agent.id, model });
      });
    }
  }

  // ---- token meter ----
  function renderUsage(usage) {
    if (!usage) return;
    usageData = usage;

    const fleet = usage.fleet || {};
    const perAgent = usage.perAgent || {};
    const ceiling = typeof usage.ceilingUsd === "number" ? usage.ceilingUsd : null;

    // Fleet total
    const totalUsd = fleet.apiEquivUsd || 0;
    fleetUsd.textContent = fmtUsd(totalUsd);
    fleetRate.textContent = fmtRate(totalUsd, fleet.ticks);

    // Ceiling + bar
    if (ceiling != null && ceiling > 0) {
      const pct = Math.min(100, (totalUsd / ceiling) * 100);
      fleetCeiling.textContent = `/ ${fmtUsd(ceiling)} ceiling`;
      barFill.style.width = pct + "%";
      barFill.className = "ctrl-bar-fill" +
        (pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
    } else {
      fleetCeiling.textContent = "no ceiling set";
      barFill.style.width = "0%";
      barFill.className = "ctrl-bar-fill";
    }

    // Per-agent breakdown
    const agentIds = Object.keys(perAgent);
    if (!agentIds.length) {
      agentMeterRows.innerHTML = '<span style="color:#6b6b66;font-size:11px;">no agent data yet</span>';
      return;
    }

    // Sort by USD spend desc
    agentIds.sort((a, b) => (perAgent[b].apiEquivUsd || 0) - (perAgent[a].apiEquivUsd || 0));

    const maxUsd = Math.max(...agentIds.map((id) => perAgent[id].apiEquivUsd || 0), 0.000001);

    // Re-render the rows (small enough set; DOM is stable via innerHTML)
    agentMeterRows.innerHTML = agentIds.map((id) => {
      const a = perAgent[id];
      const usd = a.apiEquivUsd || 0;
      const pct = Math.round((usd / maxUsd) * 100);
      const color = agentColors[id] || "#6b6b66";
      return `
        <div class="ctrl-meter-row">
          <span class="ctrl-agent-name" title="${esc(id)}">${esc(id)}</span>
          <div class="ctrl-agent-bar-track">
            <div class="ctrl-agent-bar-fill" style="width:${pct}%;background:${esc(color)}"></div>
          </div>
          <span class="ctrl-agent-usd">${fmtUsd(usd)}</span>
          <span class="ctrl-agent-ticks">${a.ticks != null ? String(a.ticks) : "—"}t</span>
        </div>`;
    }).join("");

    // Also push model/enabled state into the roster if we got it here (perAgent carries them).
    const rostersFromUsage = agentIds.map((id) => ({
      id,
      enabled: perAgent[id].enabled !== false,
      model: perAgent[id].model,
    }));
    mergeRoster(rostersFromUsage);
  }

  // ---- WebSocket integration ----
  // Intercept the WS instance that main.js creates. main.js assigns to `window.ws` OR we can
  // piggyback on the same socket event via a MutationObserver-free approach: we subscribe once
  // main.js's socket is ready by hooking the prototype BEFORE main.js fires. But since scripts
  // share the same scope and main.js instantiates the WS in module scope, the cleanest approach
  // is to open our own socket (same pattern as tx-overlay.js) — it's cheap (HTTP upgrade, same
  // node process) and avoids tight coupling to main.js internals.
  function connectWS() {
    let ws;
    try { ws = new WebSocket(`ws://${location.host}`); } catch { return; }
    ws.onopen = () => liveDot.classList.add("live");
    ws.onclose = () => {
      liveDot.classList.remove("live");
      setTimeout(connectWS, 2500);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (!m) return;

      // Opportunistically harvest agent colors from world/tick messages.
      if ((m.type === "world" || m.type === "tick") && Array.isArray(m.agents)) {
        m.agents.forEach((a) => { if (a.id && a.color) agentColors[a.id] = a.color; });
        // Also merge roster data from the world agents list.
        const rosterEntries = m.agents.map((a) => ({ id: a.id, name: a.id }));
        mergeRoster(rosterEntries);
      }

      if (m.type === "run-state") {
        renderRunState(m);
      } else if (m.type === "usage") {
        renderUsage(m);
      }
    };
  }

  // ---- initial HTTP fetch ----
  function initialFetch() {
    fetch("/run-state")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) renderRunState(data); })
      .catch(() => {}); // not fatal — WS will catch up

    fetch("/usage")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) renderUsage(data); })
      .catch(() => {});
  }

  // ---- init ----
  connectWS();
  initialFetch();
  refreshButtons();

  // Expose minimal surface for verification / dev-console testing.
  window.__ctrlPanel = {
    renderRunState,
    renderUsage,
    postControl,
    getState: () => ({ runState, usageData, selectedDuration, roster: Object.assign({}, roster) }),
  };
})();
