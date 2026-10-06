// 🎵 Cozy + retro background music — a ONE-BUTTON song cycler for the sim.
//
// UX: one button changes the song on every press, and one of its positions is off. So the 🎵 button
// steps through a RING each click:   off → track 1 → track 2 → … → track N → off → (repeat).
// "Off" is just a position in the ring, so a single button does both: every click =
// next song, and one more click past the last song = off. A tiny toast shows the
// current track name on each switch (and "muted" when you land on off).
//
// WHY click-to-start: Chrome/Safari block audio until a user gesture, so nothing plays
// on load — the first click IS the unlocking gesture. Mouse-wheel over the button nudges
// volume. on/off + current track + volume persist in localStorage across refreshes.
//
// Self-contained IIFE, vanilla ES (mirrors control.js / tx-overlay.js). Nothing imports
// it. Included from index.html with:  <script src="./music.js"></script>  (after control.js).
//
// AUDIO (all 10 are CC0 / public-domain — commit-safe, no attribution required; see
// assets/audio/CREDITS.md). All normalized to 192k stereo MP3 + loudnorm (-16 LUFS) so
// every track plays in every browser and none is so quiet it seems "not to play."
(() => {
  "use strict";

  // ---- the playlist (the ring; add/remove freely) ------------------------
  // Each entry: { src, title }. The ring is: [off] then these in order, then back to off.
  const TRACKS = [
    { src: "./assets/audio/town-theme.mp3",       title: "Town Theme RPG — cynicmusic" },
    { src: "./assets/audio/city-loop.mp3",        title: "City Loop — upbeat chiptune" },
    { src: "./assets/audio/happy-wireframes.mp3", title: "Happy Wireframes — jovial 8-bit" },
    { src: "./assets/audio/upbeat-chiptune.mp3",  title: "Upbeat Chiptune Theme — retro" },
    { src: "./assets/audio/loop-town.mp3",        title: "Loop Town — small-town chiptune" },
    { src: "./assets/audio/happy-adventure.mp3",  title: "Happy Adventure — TinyWorlds" },
    { src: "./assets/audio/fort-fairy.mp3",       title: "Fort Fairy — dreamy town theme" },
    { src: "./assets/audio/quaint-town.mp3",      title: "Quaint Town — cozy loop" },
    { src: "./assets/audio/flowerbed-fields.mp3", title: "Flowerbed Fields — cute chiptune" },
    { src: "./assets/audio/puppy-garden.mp3",     title: "Puppy in the Garden — NES cutie" },
  ];

  // ---- persisted prefs ----------------------------------------------------
  const LS_IDX = "town.music.track";   // index into TRACKS (current song)
  const LS_VOL = "town.music.volume";  // 0..1
  const LS_ON  = "town.music.on";      // "1" playing / "0" off (the ring position)

  const readVol = () => {
    const v = parseFloat(localStorage.getItem(LS_VOL));
    return isFinite(v) && v >= 0 && v <= 1 ? v : 0.35; // cozy background default
  };
  const readIdx = () => {
    const i = parseInt(localStorage.getItem(LS_IDX), 10);
    return Number.isInteger(i) && i >= 0 && i < TRACKS.length ? i : 0;
  };

  // ---- state --------------------------------------------------------------
  // idx = which track is *selected*; `on` = whether we're playing it (vs the off slot).
  let idx = readIdx();
  let on  = false; // reflects ACTUAL playback; restore is attempted after a gesture

  const audio = new Audio(TRACKS[idx].src);
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = readVol();

  // ---- the toggle button --------------------------------------------------
  const btn = document.createElement("button");
  btn.id = "music-toggle";
  btn.type = "button";
  btn.setAttribute("aria-label", "Cycle background music (click = next song, then off)");
  btn.textContent = "🎵";
  Object.assign(btn.style, {
    position: "fixed", bottom: "14px", left: "14px", zIndex: "50",
    width: "40px", height: "40px", fontSize: "18px", lineHeight: "40px",
    textAlign: "center", padding: "0", cursor: "pointer",
    background: "rgba(0,0,0,.55)", color: "#fafaf5",
    border: "1px solid #2a2a2a", borderRadius: "999px",
    fontFamily: "inherit", userSelect: "none",
    transition: "color .15s, border-color .15s",
  });

  // ---- the track-name toast (next to the button) --------------------------
  const toast = document.createElement("div");
  toast.id = "music-toast";
  Object.assign(toast.style, {
    position: "fixed", bottom: "20px", left: "62px", zIndex: "50",
    maxWidth: "260px", padding: "5px 11px",
    background: "rgba(0,0,0,.72)", color: "#fafaf5",
    border: "1px solid #2a2a2a", borderRadius: "7px",
    fontFamily: "inherit", fontSize: "12px", lineHeight: "1.4",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    pointerEvents: "none", opacity: "0",
    transition: "opacity .25s",
  });
  document.body.appendChild(toast);

  let toastTimer = null;
  function showToast(text, accent) {
    toast.textContent = text;
    toast.style.color = accent || "#fafaf5";
    toast.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.opacity = "0"; }, 2600);
  }

  function paint() {
    btn.textContent = on ? "🔊" : "🎵";
    btn.style.color = on ? "#6ee7b7" : "#fafaf5";
    btn.style.borderColor = on ? "#6ee7b7" : "#2a2a2a";
    const pos = on ? `${TRACKS[idx].title}  (${idx + 1}/${TRACKS.length})` : "off";
    btn.title = `Music: ${pos}  ·  click: next track · cycles ${TRACKS.length} tracks → off  ·  wheel: volume`;
  }

  // ---- core: load + play a given track index ------------------------------
  // THE "only one song" BUG + FIX: switching tracks used to do
  //   audio.src = url; audio.load();  …then synchronously…  audio.play();
  // Calling play() *during* the load aborts it ("The play() request was interrupted
  // by a call to load()"), so only track 1 (which had no prior load to interrupt)
  // ever actually sounded — names/icon/currentSrc still advanced, masking it.
  // FIX: when the src changes, defer play() until the element is actually ready
  // (loadeddata), via a one-shot listener — so play() never races load(). A
  // generation token makes only the LATEST click's deferred play win (rapid cycling
  // can't leave a stale track playing). OPTIMISTIC UI stays: icon flips + localStorage
  // persists + toast fires SYNCHRONOUSLY on click, so cycling feels instant.
  let gen = 0;
  function startPlay(myGen) {
    if (myGen !== gen) return; // a newer click superseded this one
    Promise.resolve(audio.play()).catch((e) => {
      if (myGen !== gen || !on) return;          // superseded or turned off meanwhile
      if (e && e.name === "AbortError") return;   // benign: a newer load/play took over
      on = false;
      localStorage.setItem(LS_ON, "0");
      paint();
      showToast("⚠ couldn't start — click to retry", "#fbbf24");
      console.warn("[music] playback rejected:", e);
    });
  }
  function playIdx(nextIdx) {
    idx = ((nextIdx % TRACKS.length) + TRACKS.length) % TRACKS.length;
    on = true;
    localStorage.setItem(LS_IDX, String(idx));
    localStorage.setItem(LS_ON, "1");
    paint();
    showToast("♪ " + TRACKS[idx].title, "#6ee7b7");
    const myGen = ++gen;
    const mySrc = TRACKS[idx].src;
    const sameSrc = audio.src.indexOf(mySrc.replace("./", "")) !== -1;
    if (sameSrc) {
      // Same file (e.g. resume from off) — no load to race, play now.
      startPlay(myGen);
    } else {
      // New file: set src, then play ONLY once it can actually play. One-shot
      // listener, guarded so a superseded switch's listener does nothing.
      audio.src = mySrc;
      const onReady = () => {
        audio.removeEventListener("loadeddata", onReady);
        audio.removeEventListener("canplay", onReady);
        startPlay(myGen);
      };
      audio.addEventListener("loadeddata", onReady, { once: true });
      audio.addEventListener("canplay", onReady, { once: true }); // belt-and-suspenders
      audio.load();
    }
  }

  function goOff() {
    gen++;                                  // invalidate any in-flight play()
    audio.pause();
    on = false;
    localStorage.setItem(LS_ON, "0");
    paint();
    showToast("muted", "#9a9a93");
  }

  // ---- the ring step: off → t1 → t2 → … → tN → off -----------------------
  // If currently off → start the current/last-selected track.
  // If playing track i → advance to track i+1; once past the last, go off.
  function step() {
    if (!on) { playIdx(idx); return; }
    const next = idx + 1;
    if (next >= TRACKS.length) { goOff(); }   // past the last track → off
    else { playIdx(next); }
  }

  btn.addEventListener("click", step);

  // Mouse wheel over the button = volume nudge (and persist it).
  btn.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const stepV = ev.deltaY < 0 ? 0.05 : -0.05;
    const v = Math.min(1, Math.max(0, +(audio.volume + stepV).toFixed(2)));
    audio.volume = v;
    localStorage.setItem(LS_VOL, String(v));
    showToast(`volume ${Math.round(v * 100)}%`, "#9a9a93");
  }, { passive: false });

  // ---- mount + restore ----------------------------------------------------
  document.body.appendChild(btn);
  paint();

  // If music was ON last session, attempt to resume the same track — browsers will
  // (correctly) reject this until the operator clicks, since there's been no gesture.
  // We try once; on rejection paint() keeps the icon honest (🎵 / off) and the next
  // click starts it. (No toast on this silent attempt.)
  if (localStorage.getItem(LS_ON) === "1") {
    on = true; paint();
    audio.play().catch(() => { on = false; localStorage.setItem(LS_ON, "0"); paint(); });
  }
})();
