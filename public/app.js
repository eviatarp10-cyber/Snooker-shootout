"use strict";

const STORE_KEY = "shootout:v2";
const RING_LEN = 276.46; // 2πr for r = 44
// Shot clock start modes: -1 = tap to start, 0 = immediately, N = N seconds after each shot.
const SHOT_START_MODES = [-1, 0, 2, 3, 5];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- State ----------
let S = load() || { screen: "setup", sound: true };
let lastTick = 0;
let wakeLock = null;

function newGame(cfg) {
  return {
    screen: "game",
    sound: S.sound !== false,
    cfg,
    players: [
      { name: cfg.names[0], score: 0 },
      { name: cfg.names[1], score: 0 },
    ],
    turn: cfg.breaker,
    brk: 0,
    ballInHand: false,
    matchMs: cfg.frameSec * 1000,
    shotMs: cfg.shot1 * 1000,
    frameRun: false,     // frame clock counting
    shot: "idle",        // shot clock: "idle" (waiting) | "armed" (auto-start pending) | "run"
    shotDelayMs: 0,      // time left before an armed shot clock starts
    paused: true,        // global pause (overlay) — freezes both clocks
    started: false,
    timeUp: false,
    expiredAlerted: false,
    history: [],
    blue: null,
    result: null,
  };
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {}
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.screen === "game" && !s.timeUp) s.paused = true; // never resume clocks silently after reload
    return s;
  } catch { return null; }
}

// ---------- Timing helpers ----------
const late = () => S.matchMs <= S.cfg.switchSec * 1000;
const shotLimit = () => (late() ? S.cfg.shot2 : S.cfg.shot1);
const other = (p) => 1 - p;

// After every shot the shot clock goes back to full and waits (or auto-starts per setting).
function resetShot() {
  S.shotMs = shotLimit() * 1000;
  S.expiredAlerted = false;
  const mode = S.cfg.shotStart;
  if (mode < 0) S.shot = "idle";
  else if (mode === 0) S.shot = "run";
  else { S.shot = "armed"; S.shotDelayMs = mode * 1000; }
}
function startShot() {
  if (S.shotMs <= 0) S.shotMs = shotLimit() * 1000;
  S.expiredAlerted = false;
  S.shot = "run";
}
function stopShot() {
  S.shotMs = shotLimit() * 1000;
  S.expiredAlerted = false;
  S.shot = "idle";
}

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function shotStartLabel(mode) {
  if (mode < 0) return "Tap to start";
  if (mode === 0) return "Immediately";
  return `Auto after ${mode}s`;
}

// ---------- Undo ----------
const SNAP_KEYS = ["players", "turn", "brk", "ballInHand"];
function snapshot() {
  const snap = {};
  for (const k of SNAP_KEYS) snap[k] = structuredClone(S[k]);
  S.history.push(snap);
  if (S.history.length > 200) S.history.shift();
}
function undo() {
  const snap = S.history.pop();
  if (!snap) return;
  Object.assign(S, snap);
  stopShot();
  commit();
}

// ---------- Actions ----------
function pot(v) {
  snapshot();
  S.players[S.turn].score += v;
  S.brk += v;
  S.ballInHand = false;
  resetShot();
  beep(880, 0.06);
  commit();
}
function endTurn() {
  snapshot();
  S.turn = other(S.turn);
  S.brk = 0;
  S.ballInHand = false;
  resetShot();
  commit();
}
function foul(pts) {
  snapshot();
  const opp = other(S.turn);
  S.players[opp].score += pts;
  S.turn = opp;
  S.brk = 0;
  S.ballInHand = true;
  resetShot();
  beep(220, 0.25);
  commit();
}
function setTurn(p) {
  if (p === S.turn) return;
  snapshot();
  S.turn = p;
  S.brk = 0;
  S.ballInHand = false;
  resetShot();
  commit();
}

// Start (first time) or resume from the global pause.
function resume() {
  unlockAudio();
  if (!S.started) {
    S.started = true;
    S.frameRun = true;
    S.shot = "run"; // the break is on the clock straight away
  }
  S.paused = false;
  lastTick = performance.now();
  requestWakeLock();
  commit();
}
function pauseAll() {
  S.paused = true;
  commit();
}
function toggleFrame() {
  if (S.paused || S.timeUp) return;
  S.frameRun = !S.frameRun;
  commit();
}
function toggleShot() {
  if (S.paused || S.timeUp) return;
  unlockAudio();
  if (S.shot === "run") stopShot();
  else startShot();
  closeSheets();
  commit();
}
function adjustFrame(deltaSec) {
  const max = S.cfg.frameSec * 1000;
  const wasLate = late();
  S.matchMs = Math.min(max, Math.max(1000, S.matchMs + deltaSec * 1000));
  if (wasLate !== late() && S.shot !== "run") S.shotMs = shotLimit() * 1000;
  commit();
}

function finishFrame() {
  S.paused = true;
  S.frameRun = false;
  S.shot = "idle";
  const [a, b] = S.players;
  if (a.score === b.score) {
    S.screen = "blue";
    S.blue = { first: S.cfg.breaker, shots: [[], []] };
  } else {
    showResult(a.score > b.score ? 0 : 1, "");
  }
  commit();
}
function showResult(winner, note) {
  S.screen = "result";
  S.result = { winner, note };
  releaseWakeLock();
}

// ---------- Blue ball shoot-out ----------
function blueShooter() {
  const { first, shots } = S.blue;
  return shots[first].length === shots[other(first)].length ? first : other(first);
}
function blueShot(hit) {
  const p = blueShooter();
  S.blue.shots[p].push(hit);
  const [a, b] = S.blue.shots;
  if (a.length === b.length) {
    const ta = a.filter(Boolean).length, tb = b.filter(Boolean).length;
    if (ta !== tb) {
      const w = ta > tb ? 0 : 1;
      showResult(w, `Won the blue ball shoot-out ${Math.max(ta, tb)}–${Math.min(ta, tb)}`);
    }
  }
  beep(hit ? 880 : 220, 0.12);
  commit();
}
function blueUndo() {
  const { first, shots } = S.blue;
  const last = shots[first].length > shots[other(first)].length ? first : other(first);
  if (shots[last].length) shots[last].pop();
  commit();
}

// ---------- Tick ----------
function tick(now) {
  requestAnimationFrame(tick);
  const dt = now - lastTick;
  lastTick = now;
  if (S.screen !== "game" || S.paused || S.timeUp) return;

  let changed = false;

  if (S.frameRun) {
    const wasLate = late();
    S.matchMs -= dt;
    // Entering the late phase: the shot clock drops to the shorter limit.
    if (!wasLate && late()) {
      S.shotMs = S.shot === "run" ? Math.min(S.shotMs, S.cfg.shot2 * 1000) : S.cfg.shot2 * 1000;
      beep(660, 0.15); setTimeout(() => beep(660, 0.15), 220);
    }
    if (S.matchMs <= 0) {
      S.matchMs = 0;
      S.frameRun = false;
      S.shot = "idle";
      S.timeUp = true;
      closeSheets();
      beep(440, 1.2);
      vibrate([400, 150, 400]);
      commit();
      return;
    }
  }

  if (S.shot === "armed") {
    S.shotDelayMs -= dt;
    if (S.shotDelayMs <= 0) { S.shot = "run"; changed = true; }
  } else if (S.shot === "run" && !S.expiredAlerted) {
    const prevSec = Math.ceil(S.shotMs / 1000);
    S.shotMs -= dt;
    const sec = Math.ceil(S.shotMs / 1000);
    if (sec !== prevSec && sec > 0 && sec <= 5) {
      beep(sec === 1 ? 1100 : 990, 0.07);
      vibrate(40);
    }
    if (S.shotMs <= 0) {
      S.shotMs = 0;
      S.expiredAlerted = true;
      beep(330, 0.6);
      vibrate([200, 100, 200]);
      openSheet("expired");
      changed = true;
    }
  }

  if (changed) save();
  renderClocks();
}

// ---------- Rendering ----------
function show(id) {
  for (const s of $$(".screen")) s.hidden = s.id !== id;
}

function render() {
  show(S.screen);
  $("#timeup-sheet").hidden = !(S.screen === "game" && S.timeUp);
  if (S.screen === "setup") return renderSetup();
  if (S.screen === "game") return renderGame();
  if (S.screen === "blue") return renderBlue();
  if (S.screen === "result") return renderResult();
}

function renderSetup() {
  const f = $("#setup-form");
  const last = S.lastCfg;
  if (last && !f.dataset.filled) {
    f.p1.value = last.names[0];
    f.p2.value = last.names[1];
    f.frameMin.value = last.frameSec / 60;
    f.switchMin.value = last.switchSec / 60;
    f.shot1.value = last.shot1;
    f.shot2.value = last.shot2;
    f.timeFoul.value = last.timeFoul;
    f.shotStart.value = last.shotStart ?? -1;
    f.dataset.filled = "1";
  }
  syncBreakerLabels();
}
function syncBreakerLabels() {
  const f = $("#setup-form");
  const spans = $$(".seg span", f);
  spans[0].textContent = f.p1.value.trim() || "Player 1";
  spans[1].textContent = f.p2.value.trim() || "Player 2";
}

function renderClocks() {
  const mc = $("#match-clock");
  $("#match-time").textContent = fmtClock(S.matchMs);
  mc.classList.toggle("late", late() && S.matchMs > 60000);
  mc.classList.toggle("final", S.matchMs <= 60000);
  mc.classList.toggle("stopped", !S.frameRun);
  $("#frame-state").textContent = S.frameRun ? "" : "Stopped";
  $("#phase-label").textContent = `${shotLimit()}s per shot`;

  const limit = shotLimit() * 1000;
  const sec = Math.max(0, Math.ceil(S.shotMs / 1000));
  $("#shot-time").textContent = sec;
  $("#shot-ring").style.strokeDashoffset = RING_LEN * (1 - Math.max(0, S.shotMs) / limit);
  const sc = $("#shot-clock");
  const running = S.shot === "run";
  sc.classList.toggle("idle", !running);
  sc.classList.toggle("warn", running && sec <= 5 && sec > 0);
  sc.classList.toggle("out", running && sec === 0);
  $("#shot-state").textContent =
    S.shot === "idle" ? "▶ Start"
    : S.shot === "armed" ? `In ${Math.max(1, Math.ceil(S.shotDelayMs / 1000))}s`
    : sec === 0 ? "Time!" : "■ Stop";
}

function renderGame() {
  renderClocks();
  $$(".player").forEach((el, i) => {
    const p = S.players[i];
    $(".name", el).textContent = p.name;
    $(".score", el).textContent = p.score;
    el.classList.toggle("active", S.turn === i);
    el.classList.toggle("bih-on", S.turn === i && S.ballInHand);
    $(".brk", el).textContent = S.turn === i && S.brk > 0 ? `Break ${S.brk}` : "";
  });
  $("#btn-undo").disabled = $("#btn-timeup-undo").disabled = S.history.length === 0;
  $("#btn-sound").textContent = `Sound: ${S.sound ? "on" : "off"}`;
  $("#btn-shotstart").textContent = `Shot clock: ${shotStartLabel(S.cfg.shotStart)}`;

  const overlay = $("#start-overlay");
  overlay.hidden = !S.paused || S.timeUp;
  if (S.paused) {
    $("#start-msg").textContent = !S.started ? `${S.players[S.turn].name} to break` : "Paused";
    $("#btn-go").textContent = S.started ? "Resume" : "Start clock";
  }

  if (S.timeUp) {
    const [a, b] = S.players;
    $("#timeup-score").textContent = `${a.name} ${a.score} – ${b.score} ${b.name}`;
  }
}

function renderBlue() {
  const { shots } = S.blue;
  const cur = blueShooter();
  $("#blue-rows").innerHTML = "";
  S.players.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "blue-row" + (i === cur ? " active" : "");
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = p.name;
    const tot = document.createElement("div");
    tot.className = "tot";
    tot.textContent = shots[i].filter(Boolean).length;
    const dots = document.createElement("div");
    dots.className = "dots";
    for (const h of shots[i]) {
      const d = document.createElement("span");
      d.className = "dot " + (h ? "hit" : "miss");
      dots.append(d);
    }
    row.append(nm, tot, dots);
    $("#blue-rows").append(row);
  });
  $("#blue-turn").textContent = `${S.players[cur].name} to shoot`;
  const any = shots[0].length + shots[1].length > 0;
  $("#blue-undo").disabled = !any;
  $("#blue-swap").disabled = any;
}

function renderResult() {
  const { winner, note } = S.result;
  const [a, b] = S.players;
  $("#winner-name").textContent = `${S.players[winner].name} wins`;
  $("#final-score").textContent = `${a.name} ${a.score} – ${b.score} ${b.name}`;
  $("#final-note").textContent = note;
}

function commit() { save(); render(); }

// ---------- Sheets ----------
function openSheet(name) {
  if (name === "foul") $("#foul-by").textContent = S.players[S.turn].name;
  if (name === "expired") {
    $("#expired-hint").textContent =
      `${S.cfg.timeFoul} points to ${S.players[other(S.turn)].name} · ball in hand`;
  }
  $(`#${name}-sheet`).hidden = false;
}
function closeSheets() {
  for (const el of $$(".overlay[id$='-sheet']")) if (el.id !== "timeup-sheet") el.hidden = true;
}

// ---------- Sound / vibration / wake lock ----------
let audio = null;
function unlockAudio() {
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  audio?.resume?.();
}
function beep(freq, dur) {
  if (!S.sound || !audio) return;
  const t = audio.currentTime;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function vibrate(p) { if (S.sound) navigator.vibrate?.(p); }

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function releaseWakeLock() { wakeLock?.release?.(); wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.screen === "game" && !S.paused) requestWakeLock();
});

// ---------- Wiring ----------
const clampNum = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

$("#setup-form").addEventListener("input", syncBreakerLabels);
$("#setup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const frameSec = Math.round(clampNum(f.frameMin.value, 1, 60, 10) * 60);
  const cfg = {
    names: [f.p1.value.trim() || "Player 1", f.p2.value.trim() || "Player 2"],
    breaker: Number(f.breaker.value),
    frameSec,
    switchSec: Math.min(frameSec, Math.round(clampNum(f.switchMin.value, 0, 60, 5) * 60)),
    shot1: clampNum(f.shot1.value, 3, 120, 15),
    shot2: clampNum(f.shot2.value, 3, 120, 10),
    timeFoul: clampNum(f.timeFoul.value, 0, 20, 5),
    shotStart: Number(f.shotStart.value),
  };
  unlockAudio();
  S = newGame(cfg);
  S.lastCfg = cfg;
  S.shotMs = shotLimit() * 1000;
  commit();
});

for (const b of $$("#game .ball")) b.addEventListener("click", () => pot(Number(b.dataset.v)));
for (const b of $$("#timeup-sheet .ball")) b.addEventListener("click", () => pot(Number(b.dataset.v)));
for (const el of $$(".player")) el.addEventListener("click", () => setTurn(Number(el.dataset.p)));

$("#btn-miss").addEventListener("click", endTurn);
$("#btn-foul").addEventListener("click", () => openSheet("foul"));
$("#btn-undo").addEventListener("click", undo);
$("#btn-timeup-undo").addEventListener("click", undo);
$("#btn-pause").addEventListener("click", pauseAll);
$("#btn-go").addEventListener("click", resume);
$("#btn-menu").addEventListener("click", () => openSheet("menu"));
$("#shot-clock").addEventListener("click", toggleShot);
$("#match-clock").addEventListener("click", toggleFrame);

for (const b of $$("#foul-sheet [data-f]")) {
  b.addEventListener("click", () => { closeSheets(); foul(Number(b.dataset.f)); });
}
$("#btn-timefoul").addEventListener("click", () => { closeSheets(); foul(S.cfg.timeFoul); });
for (const b of $$("[data-close]")) b.addEventListener("click", () => {
  closeSheets();
  if (b.closest("#expired-sheet")) { stopShot(); commit(); }
});

for (const b of $$("[data-adj]")) b.addEventListener("click", () => adjustFrame(Number(b.dataset.adj)));
$("#btn-shotstart").addEventListener("click", () => {
  const i = SHOT_START_MODES.indexOf(S.cfg.shotStart);
  S.cfg.shotStart = SHOT_START_MODES[(i + 1) % SHOT_START_MODES.length];
  S.lastCfg = { ...S.lastCfg, shotStart: S.cfg.shotStart };
  commit();
});
$("#btn-finish").addEventListener("click", () => { S.timeUp = false; finishFrame(); });
$("#btn-end").addEventListener("click", () => {
  if (!confirm("End the frame now (e.g. all balls potted)?")) return;
  closeSheets();
  finishFrame();
});
$("#btn-sound").addEventListener("click", () => { S.sound = !S.sound; unlockAudio(); commit(); });
$("#btn-abandon").addEventListener("click", () => {
  if (!confirm("Abandon this frame?")) return;
  closeSheets();
  releaseWakeLock();
  S = { screen: "setup", sound: S.sound, lastCfg: S.lastCfg };
  commit();
});

$("#blue-pot").addEventListener("click", () => { unlockAudio(); blueShot(true); });
$("#blue-miss").addEventListener("click", () => { unlockAudio(); blueShot(false); });
$("#blue-undo").addEventListener("click", blueUndo);
$("#blue-swap").addEventListener("click", () => { S.blue.first = other(S.blue.first); commit(); });

$("#btn-rematch").addEventListener("click", () => {
  const cfg = { ...S.cfg, breaker: other(S.cfg.breaker) };
  S = newGame(cfg);
  S.lastCfg = cfg;
  S.shotMs = shotLimit() * 1000;
  commit();
});
$("#btn-new").addEventListener("click", () => {
  S = { screen: "setup", sound: S.sound, lastCfg: S.lastCfg };
  commit();
});

// Keyboard shortcuts (handy on a laptop next to the table)
document.addEventListener("keydown", (e) => {
  if (S.screen !== "game" || e.target.tagName === "INPUT") return;
  if (e.key === "p") return S.paused ? resume() : pauseAll();
  if (S.paused || $$(".overlay[id$='-sheet']").some((el) => !el.hidden)) return;
  if (e.key >= "1" && e.key <= "7") pot(Number(e.key));
  else if (e.key === "Enter") endTurn();
  else if (e.key === " ") { e.preventDefault(); toggleShot(); }
  else if (e.key === "m") toggleFrame();
  else if (e.key === "f") openSheet("foul");
  else if (e.key === "z" || e.key === "Backspace") undo();
});

render();
requestAnimationFrame(tick);
