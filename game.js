/*
 * ==========================================================================
 *  ALWAYS WIN FIGHTER - game.js
 *
 *  A browser-based 2D arcade fighter drawn entirely with the HTML5 Canvas
 *  API. Plain JavaScript, no build step, no external assets.
 *
 *  The joke: the fight is rigged. The Hero (player 1) always wins.
 *    - the Challenger's hits do 1-2 damage and the Hero never drops below 10%
 *    - if the player does nothing, the Challenger trips, gets tired, whiffs or
 *      sneezes until she knocks herself out
 *    - every round ends with "HERO WINS!"
 *
 *  File layout (search for the numbered banners):
 *    1. Constants and small utilities
 *    2. Sound          - Web Audio API synthesised effects (no audio files)
 *    3. Input          - keyboard + on-screen touch buttons
 *    4. FaceStore      - the circular face images drawn on each fighter's head
 *    5. Poses & clips  - skeleton animation data (keyframes and procedural clips)
 *    6. Rendering      - drawing a fighter from a pose (hair, face, limbs...)
 *    7. Fighter        - physics, state machine, attacks, player + AI control
 *    8. Background     - pixel-art arena (drawn at 1/3 resolution, upscaled)
 *    9. Game           - rounds, HUD, hit resolution, effects, main loop
 *   10. Screens        - DOM overlays (start / pause / victory / customize)
 *   11. Boot
 * ==========================================================================
 */
(function () {
'use strict';

/* ==========================================================================
   1. CONSTANTS AND UTILITIES
   ========================================================================== */
const W = 960, H = 540;             // logical canvas size; scaled to fit the window
const FLOOR_Y = 450;                // y of the arena floor (feet rest here)
const ARENA_LEFT = 48, ARENA_RIGHT = W - 48;
const GRAVITY = 1800;               // px / s^2
const ROUND_TIME = 60;              // seconds per round
const ROUNDS_TO_WIN = 2;            // best of 3
const HERO_MIN_HP = 10;             // THE RIG: the Hero's health can never drop below 10%
const PUSH_DISTANCE = 52;           // fighters cannot overlap closer than this
const BLEND_TIME = 0.1;             // seconds to blend between animation poses
const LEG_SCALE = 1.13;             // poses are authored for shorter legs; this lengthens them
const BG_SCALE = 3;                 // background drawn at 1/3 resolution for a pixel-art look
const IDLE_PLAYER_SECONDS = 4;      // no attack input for this long = "player is doing nothing"
const TAU = Math.PI * 2;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const smooth = (t) => t * t * (3 - 2 * t);                // smoothstep easing
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/** Linear interpolation between two pose objects (numbers and nested objects). */
function lerpPose(a, b, t) {
  const out = {};
  for (const k in a) {
    const av = a[k], bv = b[k] === undefined ? av : b[k];
    out[k] = typeof av === 'number' ? av + (bv - av) * t : lerpPose(av, bv, t);
  }
  return out;
}

/** Tiny seeded random generator so the background looks the same every frame. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Mixes a hex colour toward white (amt > 0) or black (amt < 0). */
function tint(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
  const r = ch(n >> 16 & 255), g = ch(n >> 8 & 255), b = ch(n & 255);
  return `rgb(${r},${g},${b})`;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Chunky outlined arcade text used for banners, pop-ups and the HUD. */
function arcadeText(ctx, text, x, y, size, fill, stroke, align = 'center', italic = true) {
  ctx.font = `${italic ? 'italic ' : ''}900 ${size}px Impact, "Arial Black", Haettenschweiler, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (stroke) {
    ctx.lineWidth = Math.max(2, size * 0.14);
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function circleRectHit(cx, cy, r, box) {
  const nx = clamp(cx, box.x, box.x + box.w);
  const ny = clamp(cy, box.y, box.y + box.h);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

/* ==========================================================================
   2. SOUND - everything is synthesised with the Web Audio API
   ========================================================================== */
const Sound = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let muted = false, unlocked = false;

  /** Create (or resume) the AudioContext. Browsers only allow this after a user gesture. */
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.6;
      master.connect(ctx.destination);
      // One second of white noise, reused by every noise-based effect.
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function envelope(gain, t0, peak, attack, decay) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  /** A single oscillator sweeping from f0 to f1. */
  function tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.2, vol = 0.3, attack = 0.005, delay = 0 }) {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    envelope(g, t0, vol, attack, dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + attack + dur + 0.05);
  }

  /** Filtered noise burst (punch impacts, whooshes, thuds). */
  function noise({ dur = 0.15, vol = 0.3, type = 'bandpass', f0 = 800, f1 = f0, q = 1, attack = 0.002, delay = 0 }) {
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type; filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    envelope(g, t0, vol, attack, dur);
    src.connect(filter).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + attack + dur + 0.05);
  }

  const fx = {
    punch()  { noise({ dur: 0.09, vol: 0.5, f0: 1400, f1: 300, q: 0.8 }); tone({ f0: 160, f1: 50, dur: 0.12, vol: 0.5 }); },
    power()  { noise({ dur: 0.22, vol: 0.6, f0: 900, f1: 120, q: 0.7 }); tone({ type: 'square', f0: 120, f1: 30, dur: 0.28, vol: 0.3 }); tone({ f0: 70, f1: 35, dur: 0.3, vol: 0.6 }); },
    whoosh() { noise({ dur: 0.32, vol: 0.25, f0: 300, f1: 2200, q: 1.2, attack: 0.1 }); },
    block()  { tone({ type: 'square', f0: 700, f1: 500, dur: 0.07, vol: 0.18 }); noise({ dur: 0.05, vol: 0.25, type: 'highpass', f0: 3000 }); },
    poke()   { tone({ type: 'triangle', f0: 520, f1: 380, dur: 0.08, vol: 0.2 }); },
    jump()   { tone({ f0: 220, f1: 520, dur: 0.16, vol: 0.15 }); },
    land()   { noise({ dur: 0.08, vol: 0.2, type: 'lowpass', f0: 400, f1: 100 }); },
    ko()     { noise({ dur: 0.6, vol: 0.6, f0: 1200, f1: 60, q: 0.5 }); tone({ type: 'sawtooth', f0: 320, f1: 30, dur: 0.9, vol: 0.3 }); tone({ f0: 90, f1: 25, dur: 0.8, vol: 0.6 }); },
    round()  { tone({ type: 'square', f0: 440, dur: 0.18, vol: 0.18 }); tone({ type: 'square', f0: 660, dur: 0.25, vol: 0.18, delay: 0.18 }); },
    fight()  { tone({ type: 'square', f0: 330, dur: 0.12, vol: 0.2 }); tone({ type: 'square', f0: 494, dur: 0.12, vol: 0.2, delay: 0.12 }); tone({ type: 'square', f0: 659, dur: 0.35, vol: 0.22, delay: 0.24 }); noise({ dur: 0.3, vol: 0.15, f0: 200, f1: 1500, delay: 0.24 }); },
    timeup() { tone({ type: 'square', f0: 600, dur: 0.15, vol: 0.2 }); tone({ type: 'square', f0: 600, dur: 0.15, vol: 0.2, delay: 0.2 }); tone({ type: 'square', f0: 300, f1: 200, dur: 0.5, vol: 0.2, delay: 0.4 }); },
    victory() {
      [523, 659, 784, 1046, 784, 1046].forEach((f, i) => {
        tone({ type: 'square', f0: f, dur: 0.18, vol: 0.15, delay: i * 0.11 });
        tone({ type: 'triangle', f0: f / 2, dur: 0.2, vol: 0.15, delay: i * 0.11 });
      });
    },
    beat()   {
      // a bouncy 4/4 bar: kick on the beat, snare-ish noise on 2 and 4, hats on the eighths (8 eighths of 0.3 s)
      const e = 0.3;
      for (const i of [0, 2, 4, 6]) tone({ f0: 150, f1: 45, dur: 0.18, vol: 0.4, delay: i * e });
      for (const i of [2, 6]) noise({ dur: 0.12, vol: 0.25, f0: 1800, f1: 600, q: 0.6, delay: i * e });
      for (let i = 0; i < 8; i++) noise({ dur: 0.03, vol: 0.06, type: 'highpass', f0: 7000, delay: i * e });
      [523, 659, 784, 659].forEach((f, i) => tone({ type: 'square', f0: f, dur: 0.12, vol: 0.07, delay: i * 2 * e + e }));
    },
    clave()  {
      // one bar of 3-2 son clave on a woodblock, with a tumbao-ish bass underneath (16 eighths of 0.15 s)
      const e = 0.15;
      for (const i of [0, 3, 6, 10, 12]) tone({ type: 'square', f0: 1900, f1: 1300, dur: 0.035, vol: 0.14, delay: i * e });
      for (const i of [0, 3, 6, 8, 11, 14]) tone({ type: 'triangle', f0: i % 6 === 0 ? 98 : 131, f1: 70, dur: 0.16, vol: 0.22, delay: i * e });
      for (let i = 0; i < 16; i += 2) noise({ dur: 0.03, vol: 0.05, type: 'highpass', f0: 6000, delay: i * e + 0.075 });
    },
    trip()   { tone({ f0: 900, f1: 150, dur: 0.45, vol: 0.22 }); },                       // slide whistle
    thud()   { noise({ dur: 0.12, vol: 0.5, type: 'lowpass', f0: 500, f1: 80 }); tone({ f0: 90, f1: 40, dur: 0.15, vol: 0.5 }); },
    tired()  { noise({ dur: 0.35, vol: 0.12, f0: 500, f1: 250, q: 2, attack: 0.1 }); },
    sneeze() { noise({ dur: 0.08, vol: 0.2, f0: 1500, f1: 2500, attack: 0.05 }); noise({ dur: 0.18, vol: 0.45, f0: 2500, f1: 400, delay: 0.1 }); tone({ type: 'sawtooth', f0: 700, f1: 200, dur: 0.2, vol: 0.12, delay: 0.1 }); },
    dizzy()  { for (let i = 0; i < 4; i++) tone({ f0: 600 + i * 80, f1: 500 + i * 80, dur: 0.12, vol: 0.08, delay: i * 0.12 }); },
    ui()     { tone({ type: 'square', f0: 880, dur: 0.05, vol: 0.08 }); },
    plot()   { tone({ type: 'triangle', f0: 1046, f1: 1568, dur: 0.2, vol: 0.15 }); },     // "plot armor" chime
  };

  return {
    /** Call from a user gesture (key press, tap): creates or resumes the AudioContext. */
    unlock() { unlocked = true; try { ensure(); } catch (e) { /* audio is optional */ } },
    play(name) {
      if (!unlocked) return;                               // browsers block audio before the first gesture
      try { if (!ensure() || !fx[name]) return; fx[name](); } catch (e) { /* audio is optional */ }
    },
    setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.6; },
    get muted() { return muted; },
  };
})();

/* ==========================================================================
   3. INPUT - keyboard and touch buttons are merged into named actions
   ========================================================================== */
const Input = (() => {
  const ACTIONS = ['left', 'right', 'jump', 'block', 'jab', 'power', 'start', 'pause'];
  const KEYMAP = {
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ArrowUp: 'jump', w: 'jump', W: 'jump',
    ArrowDown: 'block', s: 'block', S: 'block',
    j: 'jab', J: 'jab',
    k: 'power', K: 'power',
    Enter: 'start', ' ': 'start',
    p: 'pause', P: 'pause', Escape: 'pause',
  };
  const keys = {}, touch = {}, cur = {}, prev = {}, pending = {};
  const listeners = [];

  const isDown = (a) => !!(keys[a] || touch[a]);

  /**
   * Called once per frame so pressed() can detect the rising edge of a button.
   * `pending` keeps a press alive until the next frame even if the key was
   * released in between, so very quick taps are never lost.
   */
  function update() {
    for (const a of ACTIONS) { prev[a] = !!cur[a]; cur[a] = isDown(a) || !!pending[a]; pending[a] = false; }
  }

  window.addEventListener('keydown', (e) => {
    const action = KEYMAP[e.key];
    if (!action) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;   // leave form controls alone
    if (action === 'start' && (tag === 'BUTTON' || tag === 'LABEL' || tag === 'A')) return;   // Enter/Space activate the focused button
    keys[action] = true;
    if (!e.repeat) { pending[action] = true; listeners.forEach((fn) => fn(action, e)); }
    if (action !== 'pause' || e.key === 'Escape') e.preventDefault();         // no page scrolling on arrows/space
  });
  window.addEventListener('keyup', (e) => {
    const action = KEYMAP[e.key];
    if (action) keys[action] = false;
  });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  /** Wire the on-screen buttons. Pointer events give us multi-touch for free. */
  function bindTouch(container) {
    container.querySelectorAll('[data-action]').forEach((btn) => {
      const action = btn.dataset.action;
      const down = (e) => {
        e.preventDefault();
        if (btn.setPointerCapture) { try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
        touch[action] = true; pending[action] = true;
        btn.classList.add('active');
        listeners.forEach((fn) => fn(action, e));
      };
      const up = (e) => { e.preventDefault(); touch[action] = false; btn.classList.remove('active'); };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  return {
    update, bindTouch,
    held: (a) => !!cur[a],
    pressed: (a) => !!cur[a] && !prev[a],
    onPress: (fn) => listeners.push(fn),
    clear() { for (const k in keys) keys[k] = false; for (const k in touch) touch[k] = false; for (const k in pending) pending[k] = false; },
  };
})();

/* ==========================================================================
   4. FACES - each fighter's head is a circle showing a 256x256 face image.
      The default faces are cartoon faces drawn here with the Canvas API, one
      per expression. A custom (uploaded) face replaces all expressions.
   ========================================================================== */
const FACE_SIZE = 256;
const EXPRESSIONS = ['normal', 'angry', 'hurt', 'happy', 'dizzy', 'tired'];

const FaceStore = (() => {
  const data = {
    hero: { custom: null, defaults: {} },
    challenger: { custom: null, defaults: {} },
  };
  const listeners = [];

  function buildDefaults(who) {
    for (const ex of EXPRESSIONS) {
      const c = makeCanvas(FACE_SIZE, FACE_SIZE);
      drawDefaultFace(c.getContext('2d'), FACE_SIZE, who, ex);
      data[who].defaults[ex] = c;
    }
  }

  return {
    init() { buildDefaults('hero'); buildDefaults('challenger'); },
    /** The canvas to draw on the head for this fighter and expression. */
    get(who, expr) {
      const d = data[who];
      if (d.custom) return d.custom;
      return d.defaults[expr] || d.defaults.normal;
    },
    getDefault(who, expr) { return data[who].defaults[expr || 'normal']; },
    /** Set a custom circular face canvas (FACE_SIZE square) or null to use the default. */
    setCustom(who, canvas) { data[who].custom = canvas; listeners.forEach((fn) => fn(who)); },
    hasCustom(who) { return !!data[who].custom; },
    onChange(fn) { listeners.push(fn); },
  };
})();

function fillEllipse(ctx, x, y, rx, ry) {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
}

function strokeLine(ctx, x1, y1, x2, y2, width, color) {
  ctx.lineCap = 'round'; ctx.lineWidth = width; ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

/**
 * Draws a cartoon face filling a `size` x `size` canvas (the whole canvas is the
 * head). Designed on a 256-unit grid; the fighter faces to the right.
 */
function drawDefaultFace(ctx, size, who, expr) {
  const u = size / 256;
  const hero = who === 'hero';
  const skin = hero ? '#c98f62' : '#b97a52';
  const shade = hero ? '#9a6540' : '#8a5636';
  const deep = hero ? '#6e4328' : '#5e3a22';
  const ink = '#2a1b2e';
  const iris = hero ? '#4a2c16' : '#3a2214';
  const lipCol = hero ? '#b8695c' : '#c9284f';

  ctx.save();
  ctx.scale(u, u);
  ctx.clearRect(0, 0, 256, 256);

  // skin disc, with soft shading on the jaw and under the cheekbones
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(128, 128, 128, 0, TAU); ctx.fill();
  let g = ctx.createRadialGradient(118, 100, 60, 128, 140, 140);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(128, 128, 128, 0, TAU); ctx.fill();
  ctx.fillStyle = shade; ctx.globalAlpha = 0.1;
  fillEllipse(ctx, 70, 166, 26, 10); fillEllipse(ctx, 186, 166, 26, 10);
  ctx.globalAlpha = 1;
  if (hero) {                                                   // trimmed full beard and moustache
    ctx.fillStyle = '#2b1d16'; ctx.globalAlpha = 0.72;
    ctx.beginPath();
    ctx.moveTo(34, 150);
    ctx.quadraticCurveTo(40, 232, 128, 246);
    ctx.quadraticCurveTo(216, 232, 222, 150);
    ctx.quadraticCurveTo(206, 190, 170, 196);                   // cheek line, leaving the cheeks bare
    ctx.quadraticCurveTo(150, 176, 128, 176);
    ctx.quadraticCurveTo(106, 176, 86, 196);
    ctx.quadraticCurveTo(50, 190, 34, 150);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.ellipse(132, 174, 30, 7, 0, 0, TAU); ctx.fill();   // moustache
    ctx.globalAlpha = 1;
  }
  // ear on the back edge (he faces to the right)
  ctx.fillStyle = skin; ctx.strokeStyle = ink; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(24, 126, 10, 16, 0, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = shade; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(24, 128, 5, 9, 0, 0, TAU); ctx.stroke();
  // blush
  if (!hero || expr === 'happy') {
    ctx.fillStyle = '#ff7f9f'; ctx.globalAlpha = expr === 'happy' ? 0.4 : 0.22;
    fillEllipse(ctx, 76, 150, 22, 11); fillEllipse(ctx, 180, 150, 22, 11);
    ctx.globalAlpha = 1;
  }

  // ---- eyes ------------------------------------------------------------
  const eyes = [{ x: 92, y: 112 }, { x: 166, y: 112 }];
  const eyeRx = hero ? 16 : 17, eyeRy = hero ? 9.5 : 11.5;
  for (let i = 0; i < 2; i++) {
    const { x, y } = eyes[i];
    const outer = i === 0 ? -1 : 1;
    if (expr === 'hurt') {
      strokeLine(ctx, x + outer * 13, y - 8, x - outer * 7, y, 4.5, ink);
      strokeLine(ctx, x + outer * 13, y + 8, x - outer * 7, y, 4.5, ink);
    } else if (expr === 'happy') {
      ctx.lineCap = 'round'; ctx.lineWidth = 4.5; ctx.strokeStyle = ink;
      ctx.beginPath(); ctx.moveTo(x - 15, y + 3); ctx.quadraticCurveTo(x, y - 13, x + 15, y + 3); ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = shade;
      ctx.beginPath(); ctx.moveTo(x - 10, y + 10); ctx.quadraticCurveTo(x, y + 14, x + 10, y + 10); ctx.stroke();
    } else if (expr === 'dizzy') {
      ctx.lineCap = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = ink;
      ctx.beginPath();
      for (let a = 0; a < TAU * 2.6; a += 0.15) {
        const r = a * 2.2, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else {
      // almond-shaped eye: white, iris with a dark ring, pupil, highlight
      ctx.save();
      ctx.beginPath(); ctx.ellipse(x, y, eyeRx, eyeRy, 0, 0, TAU); ctx.clip();
      ctx.fillStyle = '#fdfdfd'; ctx.fillRect(x - 30, y - 30, 60, 60);
      const look = expr === 'tired' ? 1 : 5, down = expr === 'tired' ? 4 : 1;
      const ig = ctx.createRadialGradient(x + look, y + down, 2, x + look, y + down, 9);
      ig.addColorStop(0, iris); ig.addColorStop(1, hero ? '#2b170c' : '#1d5a38');
      ctx.fillStyle = ig; ctx.beginPath(); ctx.arc(x + look, y + down, 8, 0, TAU); ctx.fill();
      ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(x + look, y + down, 3.6, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x + look + 2.5, y + down - 2.5, 2, 0, TAU); ctx.fill();
      // eyelid for narrowed / tired eyes
      if (expr === 'angry' || expr === 'tired') {
        ctx.fillStyle = skin;
        const lid = expr === 'angry' ? 7 : 10;
        ctx.fillRect(x - 30, y - 30, 60, 30 - eyeRy + lid);
      }
      // shadow under the upper lid
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(x - 30, y - eyeRy, 60, 4);
      ctx.restore();
      // lid lines: thick upper, thin lower
      ctx.lineCap = 'round'; ctx.strokeStyle = ink;
      ctx.lineWidth = hero ? 3 : 3.5;
      ctx.beginPath(); ctx.ellipse(x, y, eyeRx, eyeRy, 0, Math.PI, TAU); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(x, y, eyeRx, eyeRy, 0, 0, Math.PI); ctx.stroke();
      if (expr === 'angry' || expr === 'tired') {
        const lid = expr === 'angry' ? 7 : 10;
        strokeLine(ctx, x - eyeRx + 2, y - eyeRy + lid, x + eyeRx - 2, y - eyeRy + lid, 4, ink);
      }
      if (!hero) {                                              // lashes on the outer corner
        for (let k = 0; k < 3; k++) {
          const a = -Math.PI / 2 + outer * (0.5 + k * 0.3);
          const sx = x + Math.cos(a) * eyeRx, sy = y + Math.sin(a) * eyeRy;
          strokeLine(ctx, sx, sy, sx + Math.cos(a) * 8, sy + Math.sin(a) * 8, 3, ink);
        }
      }
    }
    // ---- eyebrow ----
    const browY = y - (hero ? 26 : 29);
    let inner = 0, outerLift = 0;
    if (expr === 'angry') { inner = 10; outerLift = -4; }
    else if (expr === 'hurt') { inner = -7; outerLift = -7; }
    else if (expr === 'happy') { inner = -5; outerLift = -5; }
    else if (expr === 'tired') { inner = -3; outerLift = 7; }
    else if (expr === 'dizzy') { inner = -5; outerLift = 3; }
    else if (hero) { inner = 2; }
    ctx.lineCap = 'round'; ctx.strokeStyle = hero ? '#1d1511' : '#20150f';
    ctx.lineWidth = hero ? 7.5 : 3.5;
    ctx.beginPath();
    ctx.moveTo(x - outer * 20, browY + inner);
    ctx.quadraticCurveTo(x + outer * 2, browY - 6 + (inner + outerLift) / 2, x + outer * 21, browY + outerLift);
    ctx.stroke();
  }

  // ---- nose: bridge, tip and nostrils ----------------------------------
  ctx.lineCap = 'round'; ctx.strokeStyle = shade;
  ctx.lineWidth = 3; ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.moveTo(130, 126); ctx.quadraticCurveTo(140, 146, 134, 158); ctx.stroke();
  ctx.globalAlpha = 0.85; ctx.lineWidth = 3; ctx.strokeStyle = deep;
  ctx.beginPath(); ctx.moveTo(118, 160); ctx.quadraticCurveTo(126, 168, 136, 161); ctx.quadraticCurveTo(142, 156, 138, 150); ctx.stroke();
  ctx.fillStyle = deep; ctx.globalAlpha = 0.8;
  fillEllipse(ctx, 121, 161, 3.5, 2.5); fillEllipse(ctx, 134, 162, 3.5, 2.5);
  ctx.globalAlpha = 1;

  // ---- mouth -----------------------------------------------------------
  const mx = 132, my = 190;
  ctx.lineCap = 'round';
  if (expr === 'angry') {
    ctx.fillStyle = '#4a1414'; fillEllipse(ctx, mx, my, 24, 14);
    ctx.save(); ctx.beginPath(); ctx.ellipse(mx, my, 24, 14, 0, 0, TAU); ctx.clip();
    ctx.fillStyle = '#fff'; ctx.fillRect(mx - 30, my - 16, 60, 11);
    ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1.5;
    for (let tx = mx - 18; tx <= mx + 18; tx += 9) { ctx.beginPath(); ctx.moveTo(tx, my - 16); ctx.lineTo(tx, my - 5); ctx.stroke(); }
    ctx.restore();
    ctx.lineWidth = 4; ctx.strokeStyle = hero ? deep : lipCol;
    ctx.beginPath(); ctx.ellipse(mx, my, 24, 14, 0, 0, TAU); ctx.stroke();
  } else if (expr === 'hurt') {
    ctx.fillStyle = '#4a1414'; fillEllipse(ctx, mx, my + 2, 12, 15);
    ctx.lineWidth = 4; ctx.strokeStyle = hero ? deep : lipCol;
    ctx.beginPath(); ctx.ellipse(mx, my + 2, 12, 15, 0, 0, TAU); ctx.stroke();
  } else if (expr === 'happy') {
    ctx.fillStyle = '#4a1414';
    ctx.beginPath(); ctx.ellipse(mx, my - 6, 34, 22, 0, 0, Math.PI); ctx.closePath(); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(mx, my - 6, 34, 22, 0, 0, Math.PI); ctx.closePath(); ctx.clip();
    ctx.fillStyle = '#fff'; ctx.fillRect(mx - 40, my - 8, 80, 10); ctx.restore();
    ctx.lineWidth = 4; ctx.strokeStyle = hero ? deep : lipCol;
    ctx.beginPath(); ctx.ellipse(mx, my - 6, 34, 22, 0, 0, Math.PI); ctx.closePath(); ctx.stroke();
    strokeLine(ctx, mx - 40, my - 8, mx - 46, my - 14, 3, deep); strokeLine(ctx, mx + 40, my - 8, mx + 46, my - 14, 3, deep);   // smile lines
  } else if (expr === 'dizzy') {
    ctx.lineWidth = 5; ctx.strokeStyle = hero ? deep : lipCol;
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) { const px = mx - 28 + i * 4.7, py = my + Math.sin(i * 1.3) * 4; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
    ctx.stroke();
    ctx.fillStyle = '#ff7f9f'; fillEllipse(ctx, mx + 13, my + 11, 7, 9);
  } else if (expr === 'tired') {
    ctx.fillStyle = '#4a1414'; fillEllipse(ctx, mx, my + 4, 10, 11);
    ctx.lineWidth = 3.5; ctx.strokeStyle = hero ? deep : lipCol;
    ctx.beginPath(); ctx.ellipse(mx, my + 4, 10, 11, 0, 0, TAU); ctx.stroke();
  } else {
    // closed lips: a thin upper lip line and a fuller lower lip (a smirk on him)
    ctx.fillStyle = lipCol; ctx.globalAlpha = hero ? 0.9 : 1;
    ctx.beginPath(); ctx.moveTo(106, my - 2);
    ctx.quadraticCurveTo(120, my - 9, 132, my - 4); ctx.quadraticCurveTo(146, my - 10, 160, my - (hero ? 5 : 2));
    ctx.quadraticCurveTo(140, my + 12, 106, my - 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3; ctx.strokeStyle = deep;
    ctx.beginPath(); ctx.moveTo(105, my - 3); ctx.quadraticCurveTo(134, my + 3, 161, my - (hero ? 6 : 2)); ctx.stroke();   // gentle smile
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; fillEllipse(ctx, 136, my + 4, 10, 2.5);           // lip highlight
  }

  // ---- little extras ---------------------------------------------------
  if (hero) {
    ctx.fillStyle = '#3a241a'; ctx.beginPath(); ctx.arc(110, 150, 3, 0, TAU); ctx.fill();   // mole beside the nose
  } else {
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(168, 176, 3, 0, TAU); ctx.fill();
  }
  if (expr === 'hurt' || expr === 'tired' || expr === 'dizzy') drawSweatDrop(ctx, 206, 78);
  if (expr === 'tired') drawSweatDrop(ctx, 48, 86);

  ctx.restore();
}

function drawSweatDrop(ctx, x, y) {
  ctx.fillStyle = '#8fd3ff'; ctx.strokeStyle = '#2a6f97'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, y - 16);
  ctx.quadraticCurveTo(x + 12, y + 2, x, y + 12);
  ctx.quadraticCurveTo(x - 12, y + 2, x, y - 16);
  ctx.fill(); ctx.stroke();
}

/* ==========================================================================
   5. POSES AND ANIMATION CLIPS
      A pose describes the skeleton in the fighter's own frame (facing +x,
      origin at the hip):
        hipH      height of the hip above the ground
        bodyAngle rotation of the whole body around the hip (±PI/2 = lying)
        lean      torso lean (+ forward)
        headTilt  extra head rotation
        armF/armB front and back arm: s = shoulder angle (0 = hanging down,
                  PI/2 = straight forward), e = elbow bend (+ bends forward)
        footF/footB foot position relative to the hip (y down; y == hipH
                  means the foot is on the ground). Knees come from IK.
      A clip is a function (time, fighter) -> pose.
   ========================================================================== */
function stand(hipH, fx, bx, extra = {}) {
  return Object.assign({
    hipH, bodyAngle: 0, lean: 0.05, headTilt: 0,
    armF: { s: 1.15, e: 1.95 }, armB: { s: 0.85, e: 2.1 },
    footF: { x: fx, y: hipH }, footB: { x: bx, y: hipH },
  }, extra);
}

/** Returns a copy of a pose with the legs lengthened by LEG_SCALE (hip height and foot positions). */
function scaleLegs(p) {
  const f = (ft) => ({ x: ft.x * LEG_SCALE, y: ft.y * LEG_SCALE, z: ft.z });
  return { ...p, hipH: p.hipH * LEG_SCALE, footF: f(p.footF), footB: f(p.footB) };
}

/** Builds a clip from absolute-time keyframes with smooth interpolation. */
function keyframes(frames) {
  const last = frames[frames.length - 1];
  return (time) => {
    if (time <= frames[0].t) return frames[0].pose;
    if (time >= last.t) return last.pose;
    for (let i = 1; i < frames.length; i++) {
      if (time <= frames[i].t) {
        const a = frames[i - 1], b = frames[i];
        return lerpPose(a.pose, b.pose, smooth((time - a.t) / (b.t - a.t)));
      }
    }
    return last.pose;
  };
}

const IDLE_POSE  = stand(72, 16, -18);
const CROUCH     = stand(50, 24, -24, { lean: 0.25 });
const BLOCK_POSE = stand(64, 20, -22, { lean: 0.08, headTilt: 0.1, armF: { s: 1.05, e: 2.45 }, armB: { s: 1.35, e: 2.25 } });
const JUMP_POSE  = { hipH: 72, bodyAngle: 0, lean: 0.05, headTilt: -0.05, armF: { s: 1.5, e: 1.5 }, armB: { s: 0.5, e: 2.0 }, footF: { x: 14, y: 52 }, footB: { x: -8, y: 46 } };
const LAND_POSE  = stand(58, 20, -20, { lean: 0.2 });
const HURT_POSE  = stand(70, 12, -26, { lean: -0.3, headTilt: -0.35, armF: { s: 1.1, e: 0.9 }, armB: { s: 0.9, e: 0.5 } });
const HURT_LIGHT = stand(71, 14, -22, { lean: -0.15, headTilt: -0.2, armF: { s: 1.2, e: 1.6 }, armB: { s: 0.9, e: 1.5 } });
const LIE_BACK   = { hipH: 22, bodyAngle: -Math.PI / 2, lean: 0.1, headTilt: 0.25, armF: { s: 2.6, e: 0.3 }, armB: { s: 2.9, e: 0.2 }, footF: { x: 14, y: 66 }, footB: { x: -4, y: 70 } };
const LIE_FRONT  = { hipH: 22, bodyAngle: Math.PI / 2, lean: -0.1, headTilt: -0.3, armF: { s: 2.7, e: 0.3 }, armB: { s: 2.4, e: 0.5 }, footF: { x: 8, y: 68 }, footB: { x: -6, y: 66 } };
const KNEEL      = { hipH: 42, bodyAngle: 0, lean: 0.35, headTilt: 0.3, armF: { s: 0.9, e: 0.4 }, armB: { s: 0.8, e: 0.5 }, footF: { x: 28, y: 42 }, footB: { x: -34, y: 40 } };
const TIRED_POSE = { hipH: 62, bodyAngle: 0, lean: 0.75, headTilt: 0.35, armF: { s: 1.0, e: 0.3 }, armB: { s: 0.95, e: 0.35 }, footF: { x: 20, y: 62 }, footB: { x: -20, y: 62 } };
const STUMBLE    = stand(60, 34, -34, { lean: 0.7, headTilt: 0.2, armF: { s: 2.0, e: 0.3 }, armB: { s: 1.6, e: 0.6 } });

const FALL_BACK_KF = keyframes([
  { t: 0, pose: HURT_POSE },
  { t: 0.3, pose: { ...LIE_BACK, hipH: 16 } },
  { t: 0.4, pose: { ...LIE_BACK, hipH: 27 } },
  { t: 0.55, pose: LIE_BACK },
]);
const FALL_FRONT_KF = keyframes([
  { t: 0, pose: STUMBLE },
  { t: 0.3, pose: { ...LIE_FRONT, hipH: 16 } },
  { t: 0.4, pose: { ...LIE_FRONT, hipH: 27 } },
  { t: 0.55, pose: LIE_FRONT },
]);
const GETUP_KF = keyframes([
  { t: 0, pose: LIE_BACK },
  { t: 0.3, pose: CROUCH },
  { t: 0.55, pose: IDLE_POSE },
]);
const DEFEAT_KF = keyframes([
  { t: 0, pose: IDLE_POSE },
  { t: 0.5, pose: TIRED_POSE },
  { t: 0.9, pose: KNEEL },
  { t: 1.3, pose: { ...LIE_FRONT, hipH: 16 } },
  { t: 1.6, pose: LIE_FRONT },
]);
const TRIP_KF = keyframes([
  { t: 0.5, pose: stand(70, 20, -20, { lean: 0.32 }) },
  { t: 0.75, pose: STUMBLE },
  { t: 1.05, pose: { ...LIE_FRONT, hipH: 16 } },
  { t: 1.15, pose: { ...LIE_FRONT, hipH: 27 } },
  { t: 1.3, pose: LIE_FRONT },
  { t: 2.1, pose: LIE_FRONT },
  { t: 2.35, pose: KNEEL },
  { t: 2.6, pose: IDLE_POSE },
]);
const WHIFF_KF = keyframes([
  { t: 0, pose: IDLE_POSE },
  { t: 0.4, pose: stand(66, 14, -28, { lean: -0.3, headTilt: -0.1, armB: { s: -1.3, e: 0.9 }, armF: { s: 1.3, e: 1.8 } }) },
  { t: 0.45, pose: stand(66, 14, -28, { lean: -0.32, headTilt: -0.1, armB: { s: -1.35, e: 0.9 }, armF: { s: 1.3, e: 1.8 } }) },
  { t: 0.6, pose: stand(64, 34, -8, { lean: 0.55, headTilt: 0.3, armB: { s: 2.3, e: 0.0 }, armF: { s: 0.4, e: 1.6 } }) },
  { t: 0.75, pose: stand(68, 22, -18, { lean: 0.25, headTilt: 0.2, armB: { s: 1.2, e: 0.3 }, armF: { s: 0.6, e: 0.4 } }) },
]);
const SNEEZE_KF = keyframes([
  { t: 0, pose: IDLE_POSE },
  { t: 0.35, pose: stand(72, 14, -18, { lean: -0.2, headTilt: -0.45, armF: { s: 1.45, e: 2.35 }, armB: { s: 0.6, e: 1.0 } }) },
  { t: 0.55, pose: stand(72, 14, -18, { lean: -0.28, headTilt: -0.55, armF: { s: 1.45, e: 2.4 }, armB: { s: 0.6, e: 1.0 } }) },
  { t: 0.65, pose: stand(66, 20, -22, { lean: 0.55, headTilt: 0.5, armF: { s: 1.0, e: 1.5 }, armB: { s: 0.8, e: 0.9 } }) },
  { t: 0.9, pose: stand(68, 18, -20, { lean: 0.35, headTilt: 0.3, armF: { s: 1.0, e: 1.5 }, armB: { s: 0.8, e: 0.9 } }) },
  { t: 1.4, pose: IDLE_POSE },
]);

const CLIPS = {
  idle(t) {
    const b = Math.sin(t * 3.2);
    return stand(72 + b * 1.2, 16, -18, {
      lean: 0.05 + b * 0.01,
      armF: { s: 1.15 + b * 0.04, e: 1.95 }, armB: { s: 0.85 + b * 0.04, e: 2.1 },
    });
  },
  /** Procedural walk cycle. f.walkDir is +1 when walking forward, -1 backward. */
  walk(t, f) {
    const dir = f.walkDir || 1;
    const ph = (t / 0.5) * TAU * dir;
    const stride = 18, lift = 12;
    const sF = Math.sin(ph);
    const hipH = 71 + Math.abs(sF) * 2;
    return {
      hipH, bodyAngle: 0, lean: 0.08 * dir, headTilt: 0,
      armF: { s: 1.15 + 0.12 * sF, e: 1.95 }, armB: { s: 0.85 - 0.12 * sF, e: 2.1 },
      footF: { x: Math.cos(ph) * stride + 4, y: hipH - Math.max(0, -sF) * lift },
      footB: { x: -Math.cos(ph) * stride - 4, y: hipH - Math.max(0, sF) * lift },
    };
  },
  jump: () => JUMP_POSE,
  land: () => LAND_POSE,
  block: () => BLOCK_POSE,
  hurt: (t, f) => (f.isHero ? HURT_LIGHT : HURT_POSE),
  fall: FALL_BACK_KF,
  fallFront: FALL_FRONT_KF,
  lieBack: () => LIE_BACK,
  lieFront: () => LIE_FRONT,
  getup: GETUP_KF,
  defeat: DEFEAT_KF,
  taunt(t) {
    const b = Math.sin(t * 8);
    return stand(72, 14, -16, { lean: -0.08 + b * 0.03, headTilt: -0.1 + b * 0.08, armF: { s: 0.55, e: 2.5 }, armB: { s: 0.55, e: 2.5 } });
  },
  /** The victory dance: a quick fist pump, then the routine chosen in DANCES (see game.dance). */
  victory(t, f) {
    if (t < 0.8) {                                            // one fist pump
      const k = smooth(Math.min(1, t / 0.25));
      return stand(72, 14, -14, { lean: -0.08 * k, headTilt: -0.2 * k, armF: { s: 1.15 + 1.75 * k, e: 1.95 - 1.8 * k }, armB: { s: 0.85, e: 2.1 } });
    }
    const dance = DANCES[f.game ? f.game.dance : 'showoff'] || DANCES.showoff;
    return dance.clip(t - 0.8);
  },
  tired(t) {
    const b = Math.sin(t * 9);
    return { ...TIRED_POSE, lean: 0.75 + b * 0.06, headTilt: 0.35 + b * 0.05 };
  },
  trip(t) {
    if (t < 0.5) {                       // a short run-up before the fall
      const p = CLIPS.walk(t * 1.7, { walkDir: 1 });
      p.lean = 0.32; p.armF = { s: 1.4, e: 1.4 }; p.armB = { s: 0.6, e: 1.6 };
      return p;
    }
    return TRIP_KF(t);
  },
  whiff(t) {
    if (t < 0.75) return WHIFF_KF(t);
    const w = Math.min(1, (t - 0.75) / 0.3);          // dizzy wobble after the big miss
    const p = stand(69, 20, -20, { lean: 0.15, armF: { s: 0.65, e: 0.5 }, armB: { s: 0.55, e: 0.4 } });
    p.lean += Math.sin(t * 8) * 0.18 * w;
    p.headTilt = Math.sin(t * 6) * 0.35 * w;
    return p;
  },
  sneeze: SNEEZE_KF,
};


/* ----- victory dances: each is a clip of time since the dance started ------ */
/** 0..1 progress of u through [a, b], smoothed. */
const seg = (u, a, b) => smooth(clamp((u - a) / (b - a), 0, 1));

const DANCES = {
  showoff: {
    label: 'Show-off', sound: 'beat', bar: 2.4, hops: [8.45],
    /**
     * Full-body routine, loops every 9.6 s: a spin, arm waves facing the crowd
     * with swinging hips, a moonwalk slide, a back-view wiggle looking over the
     * shoulder, then a jump into a split. `yaw` turns the body, `dx` moves it.
     */
    clip(t) {
      const u = t % 9.6;
      if (u < 1.2) {                                              // spin with the arms out
        const yaw = seg(u, 0, 1.2) * TAU, b = Math.sin(u * TAU / 0.3);
        return { hipH: 71 + b, bodyAngle: 0, yaw, dx: 0, sway: 0, lean: 0.02, headTilt: -0.1,
          armF: { s: 1.57, e: 0.05, z: 0.35 }, armB: { s: 1.57, e: 0.05, z: 0.35 },
          footF: { x: 8, y: 71 + b, z: 12 }, footB: { x: -8, y: 71 + b, z: -12 } };
      }
      if (u < 3.6) {                                              // facing the crowd: hands up, hips swinging
        const w = u - 1.2, sw = Math.sin(w * TAU / 0.6), bounce = Math.abs(Math.sin(w * TAU / 0.3));
        const hipH = 67 + 3 * bounce;
        return { hipH, bodyAngle: 0, yaw: Math.PI / 2, dx: 0, sway: 11 * sw, lean: 0.03, headTilt: -0.15,
          armF: { s: 2.85, e: 0.15, z: 0.75 + 0.45 * sw }, armB: { s: 2.85, e: 0.15, z: 0.75 - 0.45 * sw },
          footF: { x: 2, y: hipH, z: 20 }, footB: { x: -2, y: hipH, z: -20 } };
      }
      if (u < 6.0) {                                              // moonwalk: slide back, then forward
        const w = u - 3.6, yaw = (1 - seg(w, 0, 0.35)) * Math.PI / 2;
        const ph = w * TAU / 0.5, sF = Math.sin(ph);
        const hipH = 69 + 2 * Math.abs(sF);
        const dx = -70 * Math.sin(seg(w, 0.3, 2.4) * Math.PI);
        return { hipH, bodyAngle: 0, yaw, dx, sway: 0, lean: -0.14, headTilt: 0.05,
          armF: { s: 1.0 + 0.5 * sF, e: 1.7, z: 0.1 }, armB: { s: 1.0 - 0.5 * sF, e: 1.7, z: 0.1 },
          footF: { x: 16 * Math.cos(ph), y: hipH - 5 * Math.max(0, sF), z: 8 },
          footB: { x: -16 * Math.cos(ph), y: hipH - 5 * Math.max(0, -sF), z: -8 } };
      }
      if (u < 8.4) {                                              // back turned, hands on hips, wiggling, grinning over the shoulder
        const w = u - 6.0, yaw = lerp(0, 2.55, seg(w, 0, 0.4)), b = Math.sin(w * TAU / 0.24);
        const hipH = 63 + 1.5 * Math.abs(b);
        return { hipH, bodyAngle: 0, yaw, dx: 0, sway: 8 * b, lean: 0.28, headTilt: -0.55,
          armF: { s: 0.55, e: 2.5, z: 0.9 }, armB: { s: 0.55, e: 2.5, z: 0.9 },
          footF: { x: 6, y: hipH, z: 16 }, footB: { x: -6, y: hipH, z: -16 } };
      }
      // jump into a split, arms up in a V
      const w = u - 8.4, down = seg(w, 0.35, 0.75), yaw = lerp(2.55, Math.PI / 2, seg(w, 0, 0.3));
      const hipH = lerp(72, 30, down);
      return { hipH, bodyAngle: 0, yaw, dx: 0, sway: 0, lean: 0.05, headTilt: -0.25,
        armF: { s: 2.9, e: 0.1, z: 0.6 }, armB: { s: 2.9, e: 0.1, z: 0.6 },
        footF: { x: 4, y: hipH, z: lerp(16, 62, down) }, footB: { x: -4, y: hipH, z: lerp(-16, -62, down) } };
    },
  },
  salsa: {
    label: 'Salsa', sound: 'clave', bar: 2.4,
    /** Cuban motion: hips sway against planted feet, torso counter-leans, quick-quick-slow step. */
    clip(u) {
      const sway = Math.sin(u * TAU / 0.6);
      const hipShift = 9 * sway;
      const hipH = 70 + 1.5 * Math.abs(sway) + 0.8 * Math.sin(u * TAU / 0.3);
      const step = Math.sin(u * TAU / 1.2), stepVel = Math.cos(u * TAU / 1.2);
      const shine = (u % 4.8) > 3.9 ? smooth(Math.min(1, ((u % 4.8) - 3.9) / 0.2)) : 0;
      return {
        hipH, bodyAngle: 0,
        lean: -0.13 * sway + 0.03 * shine,
        headTilt: 0.09 * sway - 0.12 * shine,
        armF: shine ? { s: lerp(0.95 + 0.45 * sway, 2.55, shine), e: lerp(1.9, 0.35, shine) } : { s: 0.95 + 0.45 * sway, e: 1.9 },
        armB: { s: 0.95 - 0.45 * sway, e: 1.9 },
        footF: { x: 14 + 9 * step - hipShift, y: hipH - 4 * Math.max(0, stepVel) },
        footB: { x: -16 - 9 * step - hipShift, y: hipH - 4 * Math.max(0, -stepVel) },
      };
    },
  },
  wiggle: {
    label: 'Hip wiggle', sound: 'beat', bar: 2.4,
    /** Feet planted, knees bent, hips wiggling fast, fists pumping. The classic taunt. */
    clip(u) {
      const w = Math.sin(u * TAU / 0.24), pump = Math.sin(u * TAU / 0.48);
      const hipShift = 7 * w, hipH = 63 + 1.2 * Math.abs(w);
      return {
        hipH, bodyAngle: 0, lean: -0.1 * w + 0.05, headTilt: 0.12 * w - 0.1,
        armF: { s: 1.05, e: 2.25 + 0.35 * pump }, armB: { s: 1.05, e: 2.25 - 0.35 * pump },
        footF: { x: 20 - hipShift, y: hipH }, footB: { x: -22 - hipShift, y: hipH },
      };
    },
  },
  armswing: {
    label: 'Arm swing', sound: 'beat', bar: 2.4,
    /** Big relaxed arm swings with a head bob and little side steps (Carlton style). */
    clip(u) {
      const ph = u * TAU / 0.8, sw = Math.sin(ph), lift = Math.max(0, Math.cos(ph));
      const hipH = 70 + 2 * Math.abs(sw);
      return {
        hipH, bodyAngle: 0, lean: 0.12 * sw, headTilt: -0.15 + 0.2 * sw,
        armF: { s: 0.9 + 1.1 * sw, e: 0.5 - 0.3 * sw }, armB: { s: 0.9 + 1.1 * sw, e: 0.5 - 0.3 * sw },
        footF: { x: 16 + 10 * sw, y: hipH - 10 * lift * (sw > 0 ? 1 : 0) },
        footB: { x: -16 + 10 * sw, y: hipH - 10 * lift * (sw < 0 ? 1 : 0) },
      };
    },
  },
  buttshake: {
    label: 'Butt shake', sound: 'beat', bar: 2.4, faceAway: true,
    /** Turned away from the loser, bent forward, hips bouncing fast, looking back with a grin. */
    clip(u) {
      const b = Math.sin(u * TAU / 0.22);
      const hipH = 60 + 3 * Math.abs(b), hipShift = -5 * b;
      return {
        hipH, bodyAngle: 0, lean: 0.42 + 0.03 * b, headTilt: -0.75,
        armF: { s: 1.05, e: 0.35 }, armB: { s: 0.95, e: 0.45 },
        footF: { x: 22 - hipShift, y: hipH }, footB: { x: -20 - hipShift, y: hipH },
      };
    },
  },
  shuffle: {
    label: 'Shuffle + points', sound: 'beat', bar: 2.4,
    /** Running man with a finger point at the crowd every other bar. */
    clip(u) {
      const ph = u * TAU / 0.45, sF = Math.sin(ph);
      const hipH = 68 + Math.abs(sF) * 3;
      const point = (u % 2.4) > 1.8 ? smooth(Math.min(1, ((u % 2.4) - 1.8) / 0.15)) : 0;
      return {
        hipH, bodyAngle: 0, lean: -0.1, headTilt: -0.1 - 0.15 * point,
        armF: point ? { s: lerp(1.3 + 0.6 * sF, 1.75, point), e: lerp(1.6, 0, point) } : { s: 1.3 + 0.6 * sF, e: 1.6 },
        armB: { s: 1.3 - 0.6 * sF, e: 1.6 },
        footF: { x: 20 * Math.cos(ph) + 2, y: hipH - Math.max(0, -sF) * 22 },
        footB: { x: -20 * Math.cos(ph) - 2, y: hipH - Math.max(0, sF) * 22 },
      };
    },
  },
  chicken: {
    label: 'Chicken', sound: 'beat', bar: 2.4,
    /** Elbows flapping, knees bouncing in and out, head pecking. */
    clip(u) {
      const flap = Math.sin(u * TAU / 0.3), knee = Math.sin(u * TAU / 0.6);
      const hipH = 64 + 3 * Math.abs(knee);
      return {
        hipH, bodyAngle: 0, lean: 0.1 + 0.05 * flap, headTilt: 0.2 * Math.max(0, flap) - 0.05,
        armF: { s: 0.7 + 0.45 * flap, e: 2.6 - 0.3 * flap }, armB: { s: 0.7 + 0.45 * flap, e: 2.6 - 0.3 * flap },
        footF: { x: 14 + 9 * knee, y: hipH }, footB: { x: -14 - 9 * knee, y: hipH },
      };
    },
  },
};

/* ----- attacks: timing, damage and the animation that goes with them ------ */
const JAB_STRIKE = stand(71, 26, -14, { lean: 0.22, armF: { s: 1.62, e: 0.0 }, armB: { s: 0.8, e: 2.2 } });
const POWER_WINDUP = stand(66, 14, -28, { lean: -0.18, headTilt: -0.05, armB: { s: -0.9, e: 1.4 }, armF: { s: 1.25, e: 1.9 } });
const POWER_STRIKE = stand(66, 36, -10, { lean: 0.42, headTilt: 0.1, armB: { s: 1.75, e: 0.0 }, armF: { s: 0.55, e: 2.3 } });
const CH_JAB_STRIKE = stand(71, 24, -14, { lean: 0.18, armF: { s: 1.6, e: 0.0 }, armB: { s: 0.85, e: 2.2 } });
const KICK_POSE = { hipH: 70, bodyAngle: 0, lean: -0.25, headTilt: 0.05, armF: { s: 0.3, e: 1.2 }, armB: { s: 0.2, e: 1.0 }, footF: { x: 62, y: 14 }, footB: { x: -10, y: 70 } };

const ATTACKS = {
  hero_jab: {
    name: 'jab', startup: 0.07, active: 0.08, recovery: 0.17,
    damage: 7, hitstun: 0.35, knockback: 180, hitPoint: 'fistF', radius: 22, shake: 6, lunge: 120,
    sound: 'punch', words: ['POW!', 'BAM!', 'BIFF!', 'SOCK!', 'WHAP!', 'THWACK!'],
    clip: keyframes([
      { t: 0, pose: IDLE_POSE },
      { t: 0.07, pose: stand(72, 20, -16, { lean: 0.12, armF: { s: 1.35, e: 1.1 }, armB: { s: 0.9, e: 2.1 } }) },
      { t: 0.09, pose: JAB_STRIKE },
      { t: 0.15, pose: JAB_STRIKE },
      { t: 0.32, pose: IDLE_POSE },
    ]),
  },
  hero_power: {
    name: 'power', startup: 0.36, active: 0.12, recovery: 0.32,
    damage: 16, hitstun: 0.6, knockback: 460, hitPoint: 'fistB', radius: 26, shake: 16, lunge: 260,
    sound: 'power', windupSound: 'whoosh', guardBreak: true, knockdown: true, knockdownChance: 0.55,
    words: ['KAPOW!!', 'WHAM!!', 'BOOM!!', 'CRUNCH!!', 'KA-BLAM!!'],
    clip: keyframes([
      { t: 0, pose: IDLE_POSE },
      { t: 0.28, pose: POWER_WINDUP },
      { t: 0.36, pose: { ...POWER_WINDUP, lean: -0.22, armB: { s: -1.0, e: 1.4 } } },
      { t: 0.42, pose: POWER_STRIKE },
      { t: 0.48, pose: POWER_STRIKE },
      { t: 0.8, pose: IDLE_POSE },
    ]),
  },
  ch_jab: {
    name: 'jab', startup: 0.11, active: 0.08, recovery: 0.26,
    damage: 1, hitstun: 0.12, knockback: 70, hitPoint: 'fistF', radius: 18, shake: 1.5, lunge: 60,
    sound: 'poke', words: ['poke', 'tap', 'pat', 'boop', 'bonk'],
    clip: keyframes([
      { t: 0, pose: IDLE_POSE },
      { t: 0.11, pose: stand(72, 18, -16, { lean: 0.1, armF: { s: 1.3, e: 1.2 } }) },
      { t: 0.13, pose: CH_JAB_STRIKE },
      { t: 0.19, pose: CH_JAB_STRIKE },
      { t: 0.45, pose: IDLE_POSE },
    ]),
  },
  ch_kick: {
    name: 'kick', startup: 0.18, active: 0.1, recovery: 0.3,
    damage: 2, hitstun: 0.15, knockback: 100, hitPoint: 'footF', radius: 18, shake: 2, lunge: 80,
    sound: 'poke', words: ['tap!', 'plink', 'boop!', 'tink'],
    clip: keyframes([
      { t: 0, pose: IDLE_POSE },
      { t: 0.1, pose: { hipH: 70, bodyAngle: 0, lean: -0.1, headTilt: 0, armF: { s: 1.0, e: 2.0 }, armB: { s: 0.5, e: 2.0 }, footF: { x: 14, y: 36 }, footB: { x: -12, y: 70 } } },
      { t: 0.18, pose: KICK_POSE },
      { t: 0.28, pose: KICK_POSE },
      { t: 0.58, pose: IDLE_POSE },
    ]),
  },
};

/* ==========================================================================
   6. RENDERING A FIGHTER
   ========================================================================== */
const STYLES = {
  hero: {
    skin: '#c98f62', skinShade: '#9a6540', ink: '#3a2a22',
    top: '#4b505a', topShade: '#2c3038', topTrim: '#4f7fc4', pants: '#2c3f87', pantsShade: '#1b2756',
    belt: '#1d1530', glove: '#e63946', wrap: '#f5f5f5', shoe: '#2b2b3d', shoeTrim: '#f2f2f2', hair: '#17110f', band: '#e63946',
    torsoW: 40, waistW: 31, hipW: 32, torsoLen: 60, neck: 11, headR: 18,
    upperArm: 29, foreArm: 28, thigh: 43, shin: 41,
    armW: [15, 12, 9], legW: [18, 13, 10], fistW: 15, hairStyle: 'short',
  },
  challenger: {
    skin: '#b97a52', skinShade: '#8a5636', ink: '#2e2420',
    top: '#23232a', topShade: '#101014', topTrim: '#d4a93c', pants: '#2a2a33', pantsShade: '#15151b',
    belt: '#d4a93c', glove: '#8b1e3f', wrap: '#d4a93c', shoe: '#1a1a22', shoeTrim: '#d4a93c', hair: '#15100f', band: '#d4a93c',
    torsoW: 31, waistW: 21, hipW: 31, torsoLen: 57, neck: 11, headR: 17,
    upperArm: 28, foreArm: 27, thigh: 42, shin: 41,
    armW: [12, 9, 7], legW: [15, 11, 8], fistW: 12, hairStyle: 'long',
  },
};

/** Two-bone inverse kinematics: returns the knee for a hip joint and a foot. */
function solveIK(a, b, l1, l2) {
  let dx = b.x - a.x, dy = b.y - a.y;
  let d = Math.hypot(dx, dy) || 0.0001;
  const cd = clamp(d, Math.abs(l1 - l2) + 0.5, l1 + l2 - 0.5);
  dx *= cd / d; dy *= cd / d; d = cd;
  const ax = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - ax * ax));
  const mx = a.x + dx * ax / d, my = a.y + dy * ax / d;
  const k1 = { x: mx - dy / d * h, y: my + dx / d * h };
  const k2 = { x: mx + dy / d * h, y: my - dx / d * h };
  return k1.x >= k2.x ? k1 : k2;                       // knees bend forward
}

/**
 * Turns a pose into joint positions relative to the hip (before bodyAngle).
 * Points are 3D: x forward, y down, z sideways (toward the viewer in the
 * normal side view). The z axis only matters when a pose has a `yaw` (the
 * victory dances); arms get a lateral angle `z` and feet an optional `z`.
 * `sway` shifts everything but the feet sideways (hips swinging).
 */
function computeSkeleton(pose, st) {
  const lean = pose.lean, sway = pose.sway || 0;
  const shoulder = { x: Math.sin(lean) * st.torsoLen, y: -Math.cos(lean) * st.torsoLen, z: sway };
  const headAngle = lean + pose.headTilt;
  const headD = st.neck + st.headR;
  const head = { x: shoulder.x + Math.sin(headAngle) * headD, y: shoulder.y - Math.cos(headAngle) * headD, z: sway };
  const arm = (a, side) => {
    const sx = shoulder.x + side * 3, sy = shoulder.y + 4, sz = sway + side * st.torsoW * 0.5;
    const az = a.z || 0, cz = Math.cos(az), lz = side * Math.sin(az);
    const d1 = lean + a.s;
    const elbow = { x: sx + Math.sin(d1) * cz * st.upperArm, y: sy + Math.cos(d1) * cz * st.upperArm, z: sz + lz * st.upperArm };
    const d2 = d1 + a.e;
    const fist = { x: elbow.x + Math.sin(d2) * cz * st.foreArm, y: elbow.y + Math.cos(d2) * cz * st.foreArm, z: elbow.z + lz * st.foreArm };
    return { shoulder: { x: sx, y: sy, z: sz }, elbow, fist };
  };
  const leg = (foot, side) => {
    const hj = { x: side * 6, y: 2, z: sway + side * 7 };
    const ft = { x: foot.x, y: foot.y, z: foot.z === undefined ? side * 7 : foot.z };
    const knee = solveIK(hj, ft, st.thigh, st.shin);
    knee.z = (hj.z + ft.z) / 2;
    return { hip: hj, knee, foot: ft };
  };
  return {
    shoulder, head, headAngle, lean, sway,
    armF: arm(pose.armF, 1), armB: arm(pose.armB, -1),
    legF: leg(pose.footF, 1), legB: leg(pose.footB, -1),
  };
}

/** Projects a 3D skeleton point for a body turned by `yaw` (0 = side view, PI/2 = facing the viewer). */
function project(p, cy, sy) {
  return { x: p.x * cy + p.z * sy, y: p.y, d: -p.x * sy + p.z * cy };
}

/** Convex hull (monotone chain) of a few 2D points, used for the turned torso. */
function convexHull(pts) {
  const P = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function strokePath(ctx, pts, width, color) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = width; ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function fillPoly(ctx, pts, fill, stroke, lw) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke(); }
}

/** A tapered limb segment with round ends, as a path. */
function segmentPath(p1, p2, w1, w2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L, a = Math.atan2(dy, dx);
  const path = new Path2D();
  path.moveTo(p1.x + nx * w1 / 2, p1.y + ny * w1 / 2);
  path.lineTo(p2.x + nx * w2 / 2, p2.y + ny * w2 / 2);
  path.arc(p2.x, p2.y, w2 / 2, a + Math.PI / 2, a - Math.PI / 2, true);
  path.lineTo(p1.x - nx * w1 / 2, p1.y - ny * w1 / 2);
  path.arc(p1.x, p1.y, w1 / 2, a - Math.PI / 2, a + Math.PI / 2, true);
  path.closePath();
  return path;
}

/**
 * Draws a jointed limb (3 points, 3 widths): thin outlines, then each segment
 * filled with a gradient from the lit side to the shadow side.
 */
function drawLimb(ctx, pts, widths, color, shade, ink) {
  const segs = [segmentPath(pts[0], pts[1], widths[0], widths[1]), segmentPath(pts[1], pts[2], widths[1], widths[2])];
  ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = ink;
  for (const p of segs) ctx.stroke(p);
  for (let i = 0; i < 2; i++) {
    const p1 = pts[i], p2 = pts[i + 1], w = Math.max(widths[i], widths[i + 1]);
    const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy) || 1;
    let nx = -dy / L, ny = dx / L;
    if (nx + ny < 0) { nx = -nx; ny = -ny; }                      // n points away from the light
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const g = ctx.createLinearGradient(mx - nx * w / 2, my - ny * w / 2, mx + nx * w / 2, my + ny * w / 2);
    g.addColorStop(0, tint(color, 0.18)); g.addColorStop(0.45, color); g.addColorStop(1, shade);
    ctx.fillStyle = g; ctx.fill(segs[i]);
  }
}

function drawLeg(ctx, st, leg, fwd) {
  drawLimb(ctx, [leg.hip, leg.knee, leg.foot], st.legW, st.pants, st.pantsShade, st.ink);
  // shoe: heel, toe box and sole, pointing forward (foreshortened when the body turns)
  const sgn = fwd < 0 ? -1 : 1, L = 8 + 16 * Math.abs(fwd), f = leg.foot;
  const heelX = f.x - L * 0.32 * sgn, toeX = f.x + L * 0.68 * sgn;
  ctx.beginPath();
  ctx.moveTo(heelX, f.y - 7);
  ctx.quadraticCurveTo(heelX - 2 * sgn, f.y + 5, heelX + 4 * sgn, f.y + 6);
  ctx.lineTo(toeX - 3 * sgn, f.y + 6);
  ctx.quadraticCurveTo(toeX + 2 * sgn, f.y + 6, toeX, f.y + 1);
  ctx.quadraticCurveTo(toeX - 6 * sgn, f.y - 6, f.x + 5 * sgn, f.y - 8);
  ctx.lineTo(f.x - 5 * sgn, f.y - 9);
  ctx.closePath();
  ctx.fillStyle = st.shoe; ctx.fill();
  ctx.lineJoin = 'round'; ctx.lineWidth = 2.5; ctx.strokeStyle = st.ink; ctx.stroke();
  ctx.lineCap = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = st.shoeTrim;
  ctx.beginPath(); ctx.moveTo(heelX + 5 * sgn, f.y + 3); ctx.lineTo(toeX - 4 * sgn, f.y + 3); ctx.stroke();   // sole stripe
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(f.x - 1 * sgn, f.y - 5); ctx.lineTo(f.x + 6 * sgn, f.y - 2); ctx.stroke();      // lace
}

function drawArm(ctx, st, arm) {
  // rounded shoulder
  ctx.fillStyle = st.skin; ctx.strokeStyle = st.ink; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(arm.shoulder.x, arm.shoulder.y, st.armW[0] / 2 + 1, 0, TAU); ctx.fill(); ctx.stroke();
  drawLimb(ctx, [arm.shoulder, arm.elbow, arm.fist], st.armW, st.skin, st.skinShade, st.ink);
  ctx.fillStyle = st.skin; ctx.beginPath(); ctx.arc(arm.shoulder.x, arm.shoulder.y, st.armW[0] / 2 - 1, 0, TAU); ctx.fill();
  drawFist(ctx, st, arm);
}

/** A fist with knuckles, a thumb and a wrist wrap, oriented along the forearm. */
function drawFist(ctx, st, arm) {
  const dx = arm.fist.x - arm.elbow.x, dy = arm.fist.y - arm.elbow.y;
  const w = st.fistW, h = w * 0.8;
  ctx.save();
  ctx.translate(arm.fist.x, arm.fist.y);
  ctx.rotate(Math.atan2(dy, dx));
  // wrist wrap
  ctx.lineCap = 'butt'; ctx.lineWidth = 6; ctx.strokeStyle = st.ink;
  ctx.beginPath(); ctx.moveTo(-6, -st.armW[2] / 2 - 2); ctx.lineTo(-6, st.armW[2] / 2 + 2); ctx.stroke();
  ctx.lineWidth = 4; ctx.strokeStyle = st.wrap; ctx.stroke();
  // the fist
  ctx.fillStyle = st.glove; ctx.strokeStyle = st.ink; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-2, -h / 2); ctx.lineTo(w * 0.45, -h / 2);
  ctx.quadraticCurveTo(w * 0.8, -h / 2, w * 0.8, 0);
  ctx.quadraticCurveTo(w * 0.8, h / 2, w * 0.45, h / 2);
  ctx.lineTo(-2, h / 2); ctx.closePath();
  ctx.fill(); ctx.stroke();
  // thumb and knuckle lines
  ctx.beginPath(); ctx.arc(w * 0.15, -h / 2 + 1, h * 0.28, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(w * 0.62, k * h * 0.26); ctx.lineTo(w * 0.72, k * h * 0.26); ctx.stroke(); }
  ctx.restore();
}

function drawTorso(ctx, st, sk, cy, sy) {
  const px = Math.cos(sk.lean), py = Math.sin(sk.lean);          // perpendicular to the spine
  const s = sk.shoulder, tw = st.torsoW / 2, ww = st.waistW / 2, hw = st.hipW / 2;
  const shZ = st.torsoW * 0.6, waistZ = st.waistW * 0.62, hipZ = st.hipW * 0.58;
  const P = (x, y, z) => project({ x, y, z }, cy, sy);
  const extremes = (pts) => [pts.reduce((a, b) => (b.x < a.x ? b : a)), pts.reduce((a, b) => (b.x > a.x ? b : a))];
  // shorts / trousers top: a box from y = -6 to 14
  const shorts = [];
  for (const y of [-6, 14]) for (const x of [-hw - 1, hw + 1]) for (const z of [-hipZ, hipZ]) shorts.push(P(x, y, sk.sway + z));
  fillPoly(ctx, convexHull(shorts), st.pants, st.ink, 2.5);
  // torso outline: shoulders, waist, hips (each level is a box seen from the current angle)
  const top = [], waist = [], bottom = [];
  for (const sgn of [-1, 1]) for (const z of [-shZ, shZ]) top.push(P(s.x + sgn * px * tw, s.y + sgn * py * tw, sk.sway + z));
  const wx = s.x * 0.45, wy = s.y * 0.45;
  for (const sgn of [-1, 1]) for (const z of [-waistZ, waistZ]) waist.push(P(wx + sgn * px * ww, wy + sgn * py * ww, sk.sway + z));
  for (const x of [-hw, hw]) for (const z of [-hipZ, hipZ]) bottom.push(P(x, 4, sk.sway + z));
  const [tl, tr] = extremes(top), [wl, wr] = extremes(waist), [bl, br] = extremes(bottom);
  const poly = [tl, wl, bl, br, wr, tr];
  // soften the shoulder line into a slight curve by adding mid points above the shoulders
  const topMid = P(s.x, s.y - 3, sk.sway);
  const outline = [tl, wl, bl, br, wr, tr, topMid];
  fillPoly(ctx, outline, st.top, st.ink, 3);
  // lit on the left, shadowed on the right, clipped to the torso
  ctx.save();
  ctx.beginPath(); ctx.moveTo(outline[0].x, outline[0].y); for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y); ctx.closePath(); ctx.clip();
  const cx = (tl.x + tr.x) / 2, hwid = Math.max(12, (tr.x - tl.x) / 2);
  const g = ctx.createLinearGradient(cx - hwid, 0, cx + hwid, 0);
  g.addColorStop(0, tint(st.top, 0.16)); g.addColorStop(0.5, st.top); g.addColorStop(1, st.topShade);
  ctx.fillStyle = g; ctx.fillRect(cx - hwid - 20, -200, hwid * 2 + 40, 400);
  // fabric folds / muscle detail
  ctx.lineCap = 'round'; ctx.strokeStyle = st.topShade; ctx.globalAlpha = 0.7; ctx.lineWidth = 2.5;
  const chest = P(s.x * 0.8, s.y * 0.8 + 6, sk.sway), belly = P(2, -8, sk.sway);
  if (st.hairStyle === 'short') {
    const fx = cy * 7;                                             // jacket seams sit on the front of the body
    ctx.beginPath(); ctx.moveTo(chest.x + fx - 10, chest.y + 24); ctx.lineTo(chest.x + fx - 2, chest.y + 24); ctx.stroke();   // pocket
    ctx.beginPath(); ctx.moveTo(wl.x + 4, wl.y + 2); ctx.quadraticCurveTo((wl.x + wr.x) / 2, wl.y + 7, wr.x - 4, wr.y + 2); ctx.stroke();  // hem fold
  } else {
    ctx.beginPath(); ctx.moveTo(wl.x + 3, wl.y - 6); ctx.quadraticCurveTo((wl.x + wr.x) / 2, wl.y - 1, wr.x - 3, wr.y - 6); ctx.stroke();   // fold at the waist
    ctx.beginPath(); ctx.moveTo(chest.x - 8, chest.y + 6); ctx.quadraticCurveTo(chest.x + 2, chest.y + 13, chest.x + 10, chest.y + 4); ctx.stroke();  // bust line
  }
  ctx.restore();
  // trim: a V-neck for the hero, a sash for the challenger
  ctx.lineCap = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = st.topTrim;
  ctx.beginPath();
  if (st.hairStyle === 'short') {
    // blue tee showing in the open collar, then the jacket zip and collar
    ctx.lineWidth = 9; ctx.strokeStyle = st.topTrim;
    ctx.moveTo(lerp(topMid.x, tl.x, 0.3), lerp(topMid.y, tl.y, 0.3) + 4); ctx.lineTo(topMid.x + 1, topMid.y + 16); ctx.lineTo(lerp(topMid.x, tr.x, 0.3), lerp(topMid.y, tr.y, 0.3) + 4);
    ctx.stroke();
    ctx.beginPath(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#8a9099';
    ctx.moveTo(topMid.x + 1, topMid.y + 16); ctx.lineTo((bl.x + br.x) / 2 + 1, bl.y - 4);                         // zip
    ctx.moveTo(lerp(topMid.x, tl.x, 0.3), lerp(topMid.y, tl.y, 0.3) + 4); ctx.lineTo(lerp(topMid.x, tl.x, 0.55), lerp(topMid.y, tl.y, 0.55) - 7);   // collar
    ctx.moveTo(lerp(topMid.x, tr.x, 0.3), lerp(topMid.y, tr.y, 0.3) + 4); ctx.lineTo(lerp(topMid.x, tr.x, 0.55), lerp(topMid.y, tr.y, 0.55) - 7);
  } else {
    ctx.stroke();
    ctx.fillStyle = st.topTrim; ctx.strokeStyle = st.ink; ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {                                   // a column of gold buttons
      const by = lerp(topMid.y + 14, -6, i / 2.5), bx = lerp(topMid.x, (bl.x + br.x) / 2, i / 2.5) + cy * 6;
      ctx.beginPath(); ctx.arc(bx, by, 2.6, 0, TAU); ctx.fill(); ctx.stroke();
    }
    ctx.beginPath();
  }
  ctx.stroke();
  // belt across the hips
  const belt = [];
  for (const x of [-hw - 2, hw + 2]) for (const z of [-hipZ, hipZ]) belt.push(P(x, 0, sk.sway + z));
  const [bel, ber] = extremes(belt);
  strokePath(ctx, [bel, ber], 8, st.ink);
  strokePath(ctx, [bel, ber], 5, st.belt);
}

/** Hair is drawn behind the face so an uploaded photo is never covered. */
function drawHair(ctx, st, R, f) {
  const t = f.animT || 0;
  ctx.lineJoin = 'round'; ctx.fillStyle = st.hair; ctx.strokeStyle = st.ink; ctx.lineWidth = 2;
  if (st.hairStyle === 'short') {
    // headband tails flutter behind the head
    const wob = Math.sin(t * 9) * 4 - (f.vx || 0) * 0.02;
    for (let i = 0; i < 2; i++) {
      const y0 = -R * 0.5 + i * 7;
      ctx.lineCap = 'round'; ctx.lineWidth = 8; ctx.strokeStyle = st.ink;
      ctx.beginPath(); ctx.moveTo(-R + 4, y0); ctx.quadraticCurveTo(-R - 14, y0 + 8 + wob, -R - 30 - i * 5, y0 + 2 - wob + i * 9); ctx.stroke();
      ctx.lineWidth = 4; ctx.strokeStyle = st.band; ctx.stroke();
    }
    // short hair swept back: a mass above and behind the head with a few tufts
    ctx.strokeStyle = st.ink; ctx.lineWidth = 2; ctx.fillStyle = st.hair;
    ctx.beginPath(); ctx.ellipse(-3, -6, R + 6, R * 1.02, -0.15, 0, TAU); ctx.fill(); ctx.stroke();
    for (let i = 0; i < (f.photoFace ? 0 : 7); i++) {              // tousled tufts across the top (a photo brings its own hair)
      const a = Math.PI * 1.02 + i * 0.16, len = R + 5 + (i % 3) * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - 0.08) * (R + 3), Math.sin(a - 0.08) * (R + 3));
      ctx.lineTo(Math.cos(a + 0.03) * len - 2, Math.sin(a + 0.03) * len - 1);
      ctx.lineTo(Math.cos(a + 0.14) * (R + 3), Math.sin(a + 0.14) * (R + 3));
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  } else {
    // long hair falling behind the shoulders, swinging a little
    const sw = Math.sin(t * 4) * 3 - (f.vx || 0) * 0.03;
    ctx.beginPath();
    ctx.moveTo(-R * 0.2, -R - 2);
    ctx.quadraticCurveTo(-R - 10, -R * 0.6, -R - 8 + sw, R * 0.3);
    ctx.quadraticCurveTo(-R - 16 + sw, R * 0.9, -R - 9 + sw, R * 1.3);
    ctx.quadraticCurveTo(-R - 15 + sw * 1.5, R * 1.9, -R * 0.4 + sw, R * 2.25);
    ctx.quadraticCurveTo(R * 0.5 + sw, R * 2.35, R * 1.0 + sw * 0.5, R * 1.7);
    ctx.quadraticCurveTo(R * 1.3, R * 1.1, R * 1.05, R * 0.5);
    ctx.quadraticCurveTo(R + 8, -R * 0.3, R * 0.6, -R * 0.95);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // strands
    ctx.lineCap = 'round'; ctx.lineWidth = 2; ctx.strokeStyle = st.ink; ctx.globalAlpha = 0.45;
    for (let i = 0; i < 3; i++) { const x0 = -R + 6 + i * 8; ctx.beginPath(); ctx.moveTo(x0, R * 0.5); ctx.quadraticCurveTo(x0 - 4 + sw, R * 1.3, x0 - 2 + sw, R * 1.9); ctx.stroke(); }
    ctx.globalAlpha = 1;
    // top of the head
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, -2, R + 4, R * 1.12, 0, Math.PI * 0.9, TAU + Math.PI * 0.1); ctx.fill(); ctx.stroke();
  }
}

/** The head outline: an egg, wider at the brow and narrowing to the chin. R is the half width. */
function headPath(ctx, R) {
  const top = -R * 1.12, bottom = R * 1.08;
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.bezierCurveTo(R * 1.06, top, R * 1.06, R * 0.25, R * 0.72, bottom - R * 0.2);
  ctx.bezierCurveTo(R * 0.45, bottom + R * 0.05, -R * 0.45, bottom + R * 0.05, -R * 0.72, bottom - R * 0.2);
  ctx.bezierCurveTo(-R * 1.06, R * 0.25, -R * 1.06, top, 0, top);
  ctx.closePath();
}

function drawHead(ctx, st, sk, f, cy, sy) {
  const h = project(sk.head, cy, sy), sh = project(sk.shoulder, cy, sy), R = st.headR;
  // neck
  strokePath(ctx, [sh, h], 15, st.ink);
  strokePath(ctx, [sh, h], 12, st.skin);
  ctx.save(); ctx.globalAlpha = 0.35; strokePath(ctx, [{ x: sh.x + 2, y: sh.y }, { x: h.x + 2, y: h.y }], 4, st.skinShade); ctx.restore();
  ctx.save();
  ctx.translate(h.x, h.y);
  ctx.rotate(sk.headAngle * cy);
  // hair behind the head; the side-view shapes foreshorten with the turn
  ctx.save(); ctx.scale(Math.abs(cy) < 0.08 ? 0.08 : cy, 1); drawHair(ctx, st, R, f); ctx.restore();
  // the face: fully visible from the side or the front, sliding away (and the back of
  // the head showing) when the body turns away from the viewer
  const turn = Math.abs(Math.atan2(sy, cy));
  const v = turn <= Math.PI / 2 ? 1 : Math.max(0, Math.cos(turn - Math.PI / 2));
  const fwd = cy >= 0 ? 1 : -1;
  const W = R * 2.12, Hh = R * 2.2, top = -R * 1.12;             // the egg's bounding box
  ctx.fillStyle = st.skin; headPath(ctx, R); ctx.fill();
  ctx.save();
  headPath(ctx, R); ctx.clip();
  if (v > 0.01) {
    ctx.save(); ctx.translate(fwd * R * (1 - v), 0); ctx.scale(v, 1);
    ctx.drawImage(f.face, -W / 2, top, W, Hh);
    ctx.restore();
  }
  if (v < 0.99) { ctx.fillStyle = st.hair; ctx.beginPath(); ctx.ellipse(-fwd * R * v, 0, R * (1 - v) + 0.5, R * 1.2, 0, 0, TAU); ctx.fill(); }
  // soft shadow under the jaw and on the far side
  const jg = ctx.createLinearGradient(0, R * 0.3, 0, R * 1.1);
  jg.addColorStop(0, 'rgba(0,0,0,0)'); jg.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = jg; ctx.fillRect(-W, 0, W * 2, Hh);
  ctx.restore();
  ctx.lineWidth = 2.5; ctx.strokeStyle = st.ink; headPath(ctx, R); ctx.stroke();
  // accessories in front of the face
  if (st.hairStyle === 'short') {
    ctx.lineCap = 'butt';
    ctx.lineWidth = 8; ctx.strokeStyle = st.ink;
    ctx.beginPath(); ctx.ellipse(0, -2, R - 2, R * 1.08, 0, Math.PI + 0.35, TAU - 0.35); ctx.stroke();
    ctx.lineWidth = 5; ctx.strokeStyle = st.band; ctx.stroke();
  } else {
    ctx.fillStyle = st.band; ctx.strokeStyle = st.ink; ctx.lineWidth = 1.5;
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(sx * (R - 1), R * 0.45, 3.5, 0, TAU); ctx.fill(); ctx.stroke(); }
  }
  ctx.restore();
}

/**
 * Draws a fighter-like view object at the current origin (its feet).
 * view = { style, pose, skel, facing, face, animT, vx }
 * Body parts are projected for the pose's yaw and drawn far-to-near.
 */
function renderFighter(ctx, v) {
  const st = v.style, pose = v.pose, sk = v.skel;
  const yaw = pose.yaw || 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
  const P = (p) => project(p, cy, sy);
  const arm = (a) => ({ shoulder: P(a.shoulder), elbow: P(a.elbow), fist: P(a.fist) });
  const leg = (l) => ({ hip: P(l.hip), knee: P(l.knee), foot: P(l.foot) });
  const armF = arm(sk.armF), armB = arm(sk.armB), legF = leg(sk.legF), legB = leg(sk.legB);
  const headP = P(sk.head), shoulderP = P(sk.shoulder);
  // a punching rear arm crosses in front of the body (side view only)
  const rearArmInFront = Math.abs(sy) < 0.3 && sk.armB.fist.x > 16 && sk.armB.elbow.x > 2;
  const parts = [
    { d: rearArmInFront ? 15 : armB.elbow.d, draw: () => drawArm(ctx, st, armB) },
    { d: legB.knee.d, draw: () => drawLeg(ctx, st, legB, cy) },
    { d: shoulderP.d, draw: () => drawTorso(ctx, st, sk, cy, sy) },
    { d: headP.d + 0.5, draw: () => drawHead(ctx, st, sk, v, cy, sy) },
    { d: legF.knee.d, draw: () => drawLeg(ctx, st, legF, cy) },
    { d: armF.elbow.d, draw: () => drawArm(ctx, st, armF) },
  ];
  parts.sort((a, b) => a.d - b.d);
  ctx.save();
  ctx.translate(0, -pose.hipH);
  ctx.scale(v.facing, 1);
  ctx.rotate(pose.bodyAngle);
  for (const part of parts) part.draw();
  ctx.restore();
}

function drawStar(ctx, x, y, r, color, ink) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  if (ink) { ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.lineJoin = 'round'; ctx.stroke(); }
}

/* ==========================================================================
   6b. PHOTO SPRITES - optional real-photo figures configured in
       assets/sprites/sprites.js (window.AWF_SPRITES). When a fighter has a
       standing sprite, it is drawn with the photo instead of the skeleton:
       the whole figure moves (lean, lunge, fall, hop) and the victory dance
       plays real frames when they exist.
   ========================================================================== */
const Sprites = (() => {
  const data = { hero: null, challenger: null };
  function loadFrame(base, f, scale) {
    const img = new Image();
    const frame = { img, w: f.w, h: f.h, ax: f.ax, ay: f.ay, scale, ready: false };
    img.onload = () => { frame.ready = true; };
    img.onerror = () => console.warn('Always Win Fighter: could not load sprite ' + f.src);
    img.src = base + f.src;
    return frame;
  }
  function init() {
    const cfg = window.AWF_SPRITES;
    if (!cfg) return;
    const base = cfg.base || 'assets/sprites/', height = cfg.height || 215;
    for (const who of ['hero', 'challenger']) {
      const c = cfg[who];
      if (!c || !c.stand) continue;
      const scale = height / c.stand.h;
      const d = { faceDir: c.faceDir || 1, height, stand: loadFrame(base, c.stand, scale), dance: [], frames: {}, rig: c.rig || null };
      if (d.rig) {
        // cut the striking fist (and the kicking boot) out of the photo once it has loaded
        d.stand.img.addEventListener('load', () => {
          const cut = (pt) => {
            const cv = makeCanvas(pt.r * 2, pt.r * 2), cx = cv.getContext('2d');
            cx.beginPath(); cx.arc(pt.r, pt.r, pt.r - 1, 0, TAU); cx.clip();
            cx.drawImage(d.stand.img, pt.x - pt.r, pt.y - pt.r, pt.r * 2, pt.r * 2, 0, 0, pt.r * 2, pt.r * 2);
            return cv;
          };
          d.rig.fistImg = cut(d.rig.fist);
          if (d.rig.boot) d.rig.bootImg = cut(d.rig.boot);
        });
      }
      if (c.dance && c.dance.length) {
        const ds = height / c.dance[0].h;                  // the first dance frame is a standing pose
        d.dance = c.dance.map((f) => loadFrame(base, f, ds));
      }
      for (const key of ['jab', 'power', 'block', 'jump', 'hurt', 'down', 'kick', 'walk']) {
        if (c[key]) d.frames[key] = loadFrame(base, c[key], height / (c[key].ref || c[key].h));
      }
      // the move poses cut from an action grid (all share the grid's standing height as scale)
      d.act = {};
      if (c.act) for (const key in c.act) d.act[key] = loadFrame(base, c.act[key], height / (c.act[key].ref || c.act[key].h));
      data[who] = d;
    }
  }
  return {
    init,
    /** The sprite set for a fighter, once its standing frame has loaded. */
    get(who) { const d = data[who]; return d && d.stand.ready ? d : null; },
  };
})();

/**
 * Draws an animated punch or kick on top of a photo figure: the fist (or boot)
 * cut from the photo travels from the guard position, pulls back, snaps out
 * to full reach and returns, on a two-bone limb (upper arm + forearm, or
 * thigh + shin) in the sleeve / trouser colour that bends at the elbow or
 * knee and straightens on impact. Coordinates are the sprite's own (feet at
 * the origin, the figure facing `faceDir`).
 */
function drawStrikeOverlay(ctx, sp, f) {
  const rig = sp.rig, a = f.attack, t = f.stateTime;
  if (!rig || !rig.fistImg) return;
  const kick = a.name === 'kick' && rig.boot && rig.bootImg;
  const sc = sp.stand.scale, dir = sp.faceDir, H = sp.height;
  const L = (pt) => ({ x: (pt.x - sp.stand.ax) * sc, y: (pt.y - sp.stand.ay) * sc });
  const root = L(kick ? rig.hip : rig.shoulder);
  const rest = L(kick ? rig.boot : rig.fist);
  const seg = kick ? H * 0.235 : H * 0.165;                       // bone lengths from the body height
  const back = { x: root.x - dir * (kick ? 6 : 12), y: root.y + (kick ? seg * 1.1 : seg * 0.9) };
  const reach = (kick ? 2 : 2) * seg - 2 + (a.name === 'power' ? 4 : 0);
  const out = { x: root.x + dir * reach, y: root.y + (kick ? -4 : 6) };
  const lerpP = (p, q, k) => ({ x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k) });
  let pos, snap = 0;
  if (t < a.startup) pos = lerpP(rest, back, smooth(t / a.startup));
  else if (t < a.startup + a.active) { const k = (t - a.startup) / a.active; snap = Math.max(0, 1 - k * 2); pos = lerpP(back, out, easeOut(Math.min(1, k * 2.2))); }
  else pos = lerpP(out, rest, smooth((t - a.startup - a.active) / a.recovery));
  // the joint: two-bone IK, elbow hanging down / knee pointing forward-up
  const joint = solveIK(root, pos, seg, seg);
  const ddx = pos.x - root.x, ddy = pos.y - root.y, dl = Math.hypot(ddx, ddy) || 1;
  const px = -ddy / dl, py = ddx / dl;                               // perpendicular to root->pos
  const side = kick ? -1 : 1;                                        // +y side for the elbow, -y side for the knee
  const offs = Math.sqrt(Math.max(0, seg * seg - Math.min(dl / 2, seg - 0.1) ** 2));
  const mid = { x: (root.x + pos.x) / 2, y: (root.y + pos.y) / 2 };
  const j1 = { x: mid.x + px * offs, y: mid.y + py * offs }, j2 = { x: mid.x - px * offs, y: mid.y - py * offs };
  const jt = (side > 0 ? (j1.y > j2.y ? j1 : j2) : (j1.y < j2.y ? j1 : j2));
  void joint;
  const w0 = H * (kick ? 0.085 : 0.062), w1 = H * (kick ? 0.07 : 0.052), w2 = H * (kick ? 0.06 : 0.044);
  const color = kick ? rig.trouser : rig.sleeve, light = kick ? rig.trouserLight : rig.sleeveLight;
  // motion blur: ghost limbs while snapping out
  if (snap > 0) {
    for (let g = 1; g <= 3; g++) {
      const gp = lerpP(back, pos, 1 - g * 0.2);
      ctx.save(); ctx.globalAlpha = 0.2 * snap / g; ctx.lineCap = 'round'; ctx.lineWidth = w1; ctx.strokeStyle = light;
      ctx.beginPath(); ctx.moveTo(root.x, root.y); ctx.lineTo(gp.x, gp.y); ctx.stroke(); ctx.restore();
    }
  }
  drawLimb(ctx, [root, jt, pos], [w0, w1, w2], color, tint(color, -0.45), 'rgba(0,0,0,0.6)');
  // the fist or boot from the photo
  const img = kick ? rig.bootImg : rig.fistImg, r = (kick ? rig.boot.r : rig.fist.r) * sc * (kick ? 0.95 : 0.9);
  ctx.save(); ctx.translate(pos.x, pos.y);
  if (kick) ctx.rotate(dir * Math.atan2(pos.y - jt.y, Math.abs(pos.x - jt.x)) * 0.5 - dir * 0.9);
  ctx.drawImage(img, -r, -r, r * 2, r * 2);
  ctx.restore();
}

/**
 * Draws one sprite frame with its feet at the origin, facing +x, with an
 * optional rotation about the feet, squash/stretch and a forward offset.
 */
function drawSpriteFrame(ctx, frame, o = {}) {
  if (!frame.ready) return;
  ctx.save();
  ctx.translate(o.dx || 0, o.dy || 0);
  ctx.rotate(o.rot || 0);
  ctx.scale(o.sx || 1, o.sy || 1);
  const sc = frame.scale * (o.scale || 1);
  ctx.drawImage(frame.img, -frame.ax * sc, -frame.ay * sc, frame.w * sc, frame.h * sc);
  ctx.restore();
}

/* ==========================================================================
   7. FIGHTER - physics, state machine, attacks, player and AI control
      States: idle, walk, jump, land, block, attack, hurt, down, getup, ko,
              victory, defeat, taunt, trip, tired, whiff, sneeze
   ========================================================================== */
const MISFORTUNE_DURATION = { trip: 2.6, tired: 2.4, whiff: 2.2, sneeze: 1.4 };

class Fighter {
  constructor(id, game) {
    this.id = id;
    this.game = game;
    this.isHero = id === 'hero';
    this.name = this.isHero ? 'THE HERO' : 'THE CHALLENGER';
    this.style = STYLES[id];
    this.maxHp = 100;
    this.speed = this.isHero ? 270 : 180;
    this.animT = Math.random() * 10;
    this.smugT = 0;
    this.reset(this.isHero ? 320 : 640, this.isHero ? 1 : -1);
  }

  /** Puts the fighter back at a start position with full health. */
  reset(x, facing) {
    this.hp = this.maxHp; this.displayHp = this.maxHp;
    this.x = x; this.y = FLOOR_Y; this.vx = 0; this.vy = 0;
    this.facing = facing; this.onGround = true;
    this.attack = null; this.walkDir = 1; this.lie = 'back'; this.flags = {};
    this.state = 'idle'; this.stateTime = 0; this.stateDur = 0;
    this.rawPose = CLIPS.idle(0, this); this.prevPose = this.rawPose; this.blendT = BLEND_TIME;
    this.pose = scaleLegs(this.rawPose);
    this.skel = computeSkeleton(this.pose, this.style);
    this.face = FaceStore.get(this.id, 'normal');
    this.ai = { timer: 0, intent: 'wait', misfortune: rand(3, 5) };
  }

  setState(name, dur = 0) {
    this.prevPose = this.rawPose;
    this.blendT = 0;
    this.state = name; this.stateTime = 0; this.stateDur = dur; this.flags = {};
  }

  canAct() {
    return this.onGround && (this.state === 'idle' || this.state === 'walk' || this.state === 'block' || this.state === 'taunt');
  }
  isBlocking() { return this.state === 'block'; }
  isLying() {
    return this.state === 'down' || this.state === 'ko' || this.state === 'getup' ||
      (this.state === 'trip' && this.stateTime > 0.75) || (this.state === 'defeat' && this.stateTime > 0.9);
  }
  isInvulnerable() { return this.isLying() || this.state === 'victory' || this.state === 'defeat'; }
  isDizzy() {
    return this.state === 'ko' || this.state === 'down' || (this.state === 'whiff' && this.stateTime > 0.65);
  }

  /** The photo sprite set for this fighter, or null when it draws the skeleton. */
  sprite() { return Sprites.get(this.id); }

  /** Converts a skeleton point (hip-relative, body frame) into world coordinates. */
  worldPoint(p) {
    const A = this.pose.bodyAngle, c = Math.cos(A), s = Math.sin(A);
    const rx = p.x * c - p.y * s, ry = p.x * s + p.y * c;
    return { x: this.x + this.facing * rx, y: this.y - this.pose.hipH + ry };
  }
  headWorld() {
    const sp = this.sprite();
    if (sp) {
      const lying = this.isLying() || this.state === 'ko';
      const front = this.state === 'trip' || this.state === 'defeat' || (this.lie || '').startsWith('front');
      const realFallen = sp.act.fallen && sp.act.fallen.ready;
      return { x: this.x + (lying ? this.facing * sp.height * (realFallen ? -0.3 : front ? 0.42 : -0.42) : 0), y: this.y - (lying ? (realFallen ? 55 : 30) : sp.height * 0.86) };
    }
    return this.worldPoint(this.skel.head);
  }

  /** Axis-aligned box that attacks can hit, or null when the fighter cannot be hit. */
  getHurtbox() {
    if (this.isInvulnerable()) return null;
    const sp = this.sprite();
    if (sp) return { x: this.x - 28, y: this.y - sp.height * 0.97, w: 56, h: sp.height * 0.97 };
    const h = this.headWorld();
    const top = Math.min(h.y - this.style.headR, this.y - this.pose.hipH - 20);
    return { x: this.x - 24, y: top, w: 48, h: this.y - top };
  }

  currentClip() {
    switch (this.state) {
      case 'attack': return this.attack.clip;
      case 'ko':
        if (this.lie === 'front-hold') return CLIPS.lieFront;
        if (this.lie === 'back-hold') return CLIPS.lieBack;
        return this.lie === 'front' ? CLIPS.fallFront : CLIPS.fall;
      case 'down': return CLIPS.fall;
      default: return CLIPS[this.state] || CLIPS.idle;
    }
  }

  currentExpression() {
    const s = this.state, t = this.stateTime;
    if (this.smugT > 0) return 'happy';
    if (s === 'victory') return 'happy';
    if (s === 'hurt' || (s === 'sneeze' && t > 0.55) || (s === 'trip' && t > 0.5)) return 'hurt';
    if (this.isDizzy()) return 'dizzy';
    if (s === 'tired' || s === 'defeat' || s === 'getup') return 'tired';
    if (s === 'attack') return (this.isHero && this.attack.name === 'jab') ? 'normal' : 'angry';
    return 'normal';
  }

  /* ---------------------------------------------------------------- update */
  update(dt, opp) {
    this.stateTime += dt;
    this.animT += dt;
    this.smugT = Math.max(0, this.smugT - dt);

    switch (this.state) {
      case 'attack': this.updateAttack(opp); break;
      case 'hurt': if (this.stateTime >= this.stateDur) this.setState('idle'); break;
      case 'land': if (this.stateTime >= 0.1) this.setState('idle'); break;
      case 'taunt': if (this.stateTime >= this.stateDur) this.setState('idle'); break;
      case 'down': if (this.stateTime >= this.stateDur) this.setState('getup', 0.55); break;
      case 'getup': if (this.stateTime >= this.stateDur) this.setState('idle'); break;
      case 'defeat': if (this.stateTime >= 1.6) { this.lie = 'front-hold'; this.setState('ko'); } break;
      case 'trip': this.updateTrip(); break;
      case 'tired': this.updateTired(dt); break;
      case 'whiff': this.updateWhiff(); break;
      case 'sneeze': this.updateSneeze(); break;
      case 'victory': this.updateVictoryDance(); break;
      default: break;
    }

    // Face the opponent whenever we are free to act.
    if (this.canAct() || this.state === 'hurt') this.facing = opp.x >= this.x ? 1 : -1;

    // ---- physics ----
    if (this.state !== 'walk' && this.onGround) this.vx *= Math.max(0, 1 - 10 * dt);   // ground friction
    if (!this.onGround) {
      this.vy += GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y >= FLOOR_Y) { this.y = FLOOR_Y; this.vy = 0; this.onGround = true; this.onLand(); }
    }
    this.x = clamp(this.x + this.vx * dt, ARENA_LEFT, ARENA_RIGHT);

    // ---- animation ----
    const target = this.currentClip()(this.stateTime, this);
    this.blendT = Math.min(BLEND_TIME, this.blendT + dt);
    this.rawPose = this.blendT < BLEND_TIME ? lerpPose(this.prevPose, target, smooth(this.blendT / BLEND_TIME)) : target;
    this.pose = scaleLegs(this.rawPose);
    this.skel = computeSkeleton(this.pose, this.style);
    this.face = FaceStore.get(this.id, this.currentExpression());
    this.photoFace = FaceStore.hasCustom(this.id);

    // the white "damage just taken" part of the health bar catches up slowly
    this.displayHp += (this.hp - this.displayHp) * Math.min(1, dt * 3);
  }

  onLand() {
    if (this.state === 'jump') { this.setState('land'); Sound.play('land'); this.game.dust(this.x, FLOOR_Y, 4); }
    if (this.state !== 'walk') this.vx *= 0.3;
  }

  jump() {
    if (!this.onGround) return;
    this.vy = -640; this.onGround = false;
    this.setState('jump');
    Sound.play('jump');
  }

  startAttack(key) {
    const def = ATTACKS[key];
    this.attack = Object.assign({ hasHit: false }, def);
    this.setState('attack', def.startup + def.active + def.recovery);
    this.vx = 0;
    if (def.windupSound) Sound.play(def.windupSound);
    if (this.isHero) this.game.notePlayerAction();
  }

  hitPoint(name) {
    const sk = this.skel;
    if (name === 'fistB') return sk.armB.fist;
    if (name === 'footF') return sk.legF.foot;
    return sk.armF.fist;
  }

  updateAttack(opp) {
    const a = this.attack, t = this.stateTime;
    // step into the punch during the active frames
    if (a.lunge && t >= a.startup * 0.5 && t < a.startup + a.active) this.vx = this.facing * a.lunge;
    if (!a.hasHit && t >= a.startup && t <= a.startup + a.active) {
      const sp = this.sprite();
      const p = sp
        ? { x: this.x + this.facing * (a.name === 'power' ? 112 : a.name === 'kick' ? 108 : 92), y: this.y - sp.height * (a.name === 'kick' ? 0.55 : 0.78) }
        : this.worldPoint(this.hitPoint(a.hitPoint));
      const box = opp.getHurtbox();
      if (box && circleRectHit(p.x, p.y, a.radius, box)) {
        a.hasHit = true;
        this.game.resolveHit(this, opp, a, p);
      }
    }
    if (t >= this.stateDur) {
      if (!a.hasHit && !this.isHero && Math.abs(opp.x - this.x) < 170 && Math.random() < 0.5) {
        const h = this.headWorld();
        this.game.popup('miss', h.x + this.facing * 30, h.y - 20, { color: '#cfc6ff', size: 18, life: 0.7 });
      }
      this.setState(this.onGround ? 'idle' : 'jump');
    }
  }

  /** Reaction to being hit. The Hero flinches; the Challenger can be knocked down or out. */
  hurtBy(atk, dir) {
    if (this.isHero) {
      // super armor: a Hero mid-punch does not even flinch
      if (this.state === 'attack') { this.vx = dir * 40; return; }
      if (!this.onGround) return;
      this.vx = dir * 70;
      this.setState('hurt', 0.15);
      return;
    }
    this.vx = dir * atk.knockback;
    if (this.hp <= 0) { this.knockOut(); return; }
    if (atk.knockdown && (Math.random() < atk.knockdownChance || this.hp < 30)) {
      this.setState('down', 1.3);
    } else {
      this.setState('hurt', atk.hitstun);
    }
  }

  knockOut() {
    const A = this.pose.bodyAngle;
    if (A > 1.0) this.lie = 'front-hold';
    else if (A < -1.0) this.lie = 'back-hold';
    else this.lie = (this.state === 'trip' || this.state === 'defeat') ? 'front' : 'back';
    this.setState('ko');
  }

  /* ------------------------------------------------------- player control */
  updatePlayer(dt, input) {
    const s = this.state;
    if (s === 'attack' || s === 'hurt' || s === 'land' || s === 'victory') return;
    const dir = (input.held('right') ? 1 : 0) - (input.held('left') ? 1 : 0);

    if (!this.onGround) {                       // airborne: steer a little and air-jab
      if (dir) this.vx = dir * 200;
      if (input.pressed('jab')) this.startAttack('hero_jab');
      return;
    }
    if (input.pressed('jab')) return this.startAttack('hero_jab');
    if (input.pressed('power')) return this.startAttack('hero_power');
    if (input.pressed('jump')) { this.vx = dir * 200; return this.jump(); }
    if (input.held('block')) {
      if (s !== 'block') this.setState('block');
      this.vx = 0;
      return;
    }
    if (dir) {
      if (s !== 'walk') this.setState('walk');
      this.vx = dir * this.speed;
      this.walkDir = dir === this.facing ? 1 : -1;
      return;
    }
    if (s !== 'idle') { this.setState('idle'); this.vx = 0; }
  }

  /* ----------------------------------------------------------- AI control */
  updateAI(dt, opp) {
    if (!this.canAct()) return;
    const ai = this.ai;
    ai.misfortune -= dt;
    if (ai.misfortune <= 0) { this.doMisfortune(); return; }
    ai.timer -= dt;
    if (ai.timer <= 0) this.decide(opp);
    if (this.state === 'attack') return;         // decide() may have started an attack
    switch (ai.intent) {
      case 'approach': this.moveToward(opp, 1); break;
      case 'retreat': this.moveToward(opp, -1); break;
      case 'block':
        if (this.state !== 'block') this.setState('block');
        this.vx = 0;
        break;
      default:
        if (this.state !== 'idle' && this.state !== 'taunt') { this.setState('idle'); }
        if (this.state === 'idle') this.vx = 0;
    }
  }

  moveToward(opp, sign) {
    const dir = (opp.x >= this.x ? 1 : -1) * sign;
    if (this.state !== 'walk') this.setState('walk');
    this.vx = dir * this.speed;
    this.walkDir = dir === this.facing ? 1 : -1;
  }

  /** Picks a new intention. She is a competent-looking fighter who never quite lands anything. */
  decide(opp) {
    const ai = this.ai, d = Math.abs(opp.x - this.x), r = Math.random();
    if (d > 170) {
      if (r < 0.7) { ai.intent = 'approach'; ai.timer = rand(0.3, 0.8); }
      else if (r < 0.82) { ai.intent = 'wait'; ai.timer = 0.6; this.vx = (opp.x >= this.x ? 1 : -1) * 160; this.jump(); }
      else if (r < 0.92) { ai.intent = 'wait'; ai.timer = 1.1; this.setState('taunt', 1.1); }
      else { ai.intent = 'wait'; ai.timer = rand(0.3, 0.6); }
    } else if (d > 100) {
      if (r < 0.45) { ai.intent = 'approach'; ai.timer = rand(0.2, 0.4); }
      else if (r < 0.7) { ai.intent = 'wait'; ai.timer = 0.4; this.startAttack(Math.random() < 0.5 ? 'ch_jab' : 'ch_kick'); }   // misjudged range
      else if (r < 0.85) { ai.intent = 'block'; ai.timer = rand(0.4, 0.8); }
      else { ai.intent = 'retreat'; ai.timer = rand(0.2, 0.4); }
    } else {
      if (r < 0.5) { ai.intent = 'wait'; ai.timer = 0.3; this.startAttack(Math.random() < 0.6 ? 'ch_jab' : 'ch_kick'); }
      else if (r < 0.7) { ai.intent = 'block'; ai.timer = rand(0.4, 0.9); }
      else if (r < 0.88) { ai.intent = 'retreat'; ai.timer = rand(0.25, 0.5); }
      else { ai.intent = 'wait'; ai.timer = rand(0.2, 0.4); }
    }
  }

  /* --------------------------------------------------- misfortunes (the rig) */
  /** Every few seconds the Challenger hurts herself. More often if the player is idle. */
  doMisfortune() {
    const r = Math.random();
    const type = r < 0.35 ? 'trip' : r < 0.6 ? 'tired' : r < 0.85 ? 'whiff' : 'sneeze';
    this.ai.intent = 'wait'; this.ai.timer = 0.3;
    this.ai.misfortune = this.game.playerIdle() ? rand(2.5, 4) : rand(8, 13);
    this.setState(type, MISFORTUNE_DURATION[type]);
    this.game.stats.misfortunes++;
  }

  updateTrip() {
    const t = this.stateTime, f = this.flags;
    if (t < 0.5) this.vx = this.facing * 230;                  // the run-up
    else if (t < 0.75) this.vx = this.facing * 130;            // the stumble
    else if (t < 1.05) {                                       // the fall
      this.vx = this.facing * 60;
      if (!f.whistle) { f.whistle = true; Sound.play('trip'); }
    } else {
      this.vx = 0;
      if (!f.landed) {
        f.landed = true;
        Sound.play('thud'); this.game.shake(6); this.game.dust(this.x + this.facing * 40, FLOOR_Y, 10);
        this.game.selfOwn(this, 16, 'OOPS!', '#ffb703');
        if (this.state !== 'trip') return;
      }
    }
    if (t >= this.stateDur) this.setState('idle');
  }

  updateTired(dt) {
    const t = this.stateTime, f = this.flags, h = this.headWorld();
    this.vx = 0;
    if (t > 0.3 && !f.d1) {
      f.d1 = true; Sound.play('tired');
      this.game.selfOwn(this, 12, 'TIRED!', '#9bf6ff');
      if (this.state !== 'tired') return;
    }
    if (t > 1.0 && !f.h1) { f.h1 = true; Sound.play('tired'); this.game.popup('huff...', h.x + this.facing * 30, h.y - 10, { color: '#dff6ff', size: 20, life: 0.9 }); }
    if (t > 1.7 && !f.h2) { f.h2 = true; Sound.play('tired'); this.game.popup('puff...', h.x + this.facing * 30, h.y - 10, { color: '#dff6ff', size: 20, life: 0.9 }); }
    if (Math.random() < dt * 4) this.game.sweat(h.x - this.facing * 10, h.y - 20);
    if (t >= this.stateDur) this.setState('idle');
  }

  updateWhiff() {
    const t = this.stateTime, f = this.flags;
    if (t < 0.45) this.vx = 0;
    else if (t < 0.65) {
      this.vx = this.facing * 180;                              // a huge haymaker that hits only air
      if (!f.swing) { f.swing = true; Sound.play('whoosh'); }
    } else if (!f.miss) {
      f.miss = true; Sound.play('dizzy');
      this.game.selfOwn(this, 13, 'WHIFF!', '#ff9ecd');
      if (this.state !== 'whiff') return;
    }
    if (t >= this.stateDur) this.setState('idle');
  }

  updateSneeze() {
    const t = this.stateTime, f = this.flags;
    this.vx = 0;
    if (t > 0.2 && !f.ah) { f.ah = true; const h = this.headWorld(); this.game.popup('ah... ah...', h.x, h.y - 50, { color: '#caffbf', size: 20, life: 0.5 }); }
    if (t > 0.55 && !f.achoo) {
      f.achoo = true; Sound.play('sneeze'); this.vx = -this.facing * 90;
      const h = this.headWorld();
      this.game.sparks(h.x + this.facing * 30, h.y + 10, 8, ['#caffbf', '#ffffff'], 140);
      this.game.selfOwn(this, 9, 'ACHOO!', '#caffbf');
      if (this.state !== 'sneeze') return;
    }
    if (t >= this.stateDur) this.setState('idle');
  }

  /** A hop on the fist pump, then the dance's beat and music notes. */
  updateVictoryDance() {
    const f = this.flags, t = this.stateTime;
    const dance = DANCES[this.game.dance] || DANCES.showoff;
    this.vx = 0;
    if (f.baseFacing === undefined) f.baseFacing = this.facing;
    if (!f.hopped && this.onGround) { f.hopped = true; this.vy = -260; this.onGround = false; }
    this.facing = (dance.faceAway && t >= 0.8) ? -f.baseFacing : f.baseFacing;
    if (f.baseX === undefined) f.baseX = this.x;
    if (t >= 0.8) {
      this.x = clamp(f.baseX + this.facing * (this.pose.dx || 0), ARENA_LEFT, ARENA_RIGHT);   // dances can travel
      if (dance.hops) {                                                                       // timed hops in the routine
        const u = (t - 0.8) % 9.6, loopN = Math.floor((t - 0.8) / 9.6);
        for (const h of dance.hops) {
          const key = 'hop' + loopN + '_' + h;
          if (u >= h && u < h + 0.3 && !f[key] && this.onGround) { f[key] = true; this.vy = -420; this.onGround = false; }
        }
      }
    }
    const bar = t < 0.8 ? -1 : Math.floor((t - 0.8) / dance.bar);
    if (bar !== f.bar) { f.bar = bar; if (bar >= 0) Sound.play(dance.sound); }
    if (t >= 0.8 && t - (f.lastNote || 0) > 0.5) {
      f.lastNote = t;
      const h = this.headWorld();
      this.game.popup(pick(['\u266a', '\u266b', '\u266a']), h.x + rand(-50, 50), h.y - rand(20, 50),
        { color: pick(['#ffd166', '#ff9ecd', '#9bf6ff', '#caffbf']), size: rand(20, 30), rot: rand(-0.4, 0.4), life: 1.1 });
    }
  }

  /* ---------------------------------------------------------------- draw */
  /**
   * Picks a photo frame and whole-body motion for the current state. Moves
   * without a dedicated frame reuse the standing photo with lean, lunge,
   * squash and stretch so the figure still reads as moving.
   */
  spriteView() {
    const sp = this.sprite(), s = this.state, t = this.stateTime;
    const v = { frame: sp.stand, rot: 0, sx: 1, sy: 1, dx: 0, dy: 0, real: false };
    // a real pose frame if it exists, else the standing photo (drawn with motion instead)
    const act = (key) => (sp.act[key] && sp.act[key].ready ? sp.act[key] : null);
    const use = (key, fallback) => { const f = act(key); if (f) { v.frame = f; v.real = true; } else if (fallback) fallback(); };
    const lieRot = (frontDown) => (frontDown ? Math.PI / 2 : -Math.PI / 2);
    const lieDy = (rot) => -(rot > 0 ? sp.stand.ax : sp.stand.w - sp.stand.ax) * sp.stand.scale * Math.abs(Math.sin(rot)) * 0.92;
    const lieDx = (rot) => -Math.sin(rot) * sp.height * 0.42;
    const lieFallback = (front, k) => { const r = lieRot(front) * k; v.rot = r; v.dy = lieDy(r); v.dx = lieDx(r); };
    // the fallen photo pose, settling with a small bounce
    const fallen = (k) => use('fallen', () => lieFallback(false, k)) || (v.real && (v.sy = 1 - 0.08 * Math.sin(Math.min(1, k) * Math.PI)));
    switch (s) {
      case 'idle': v.sy = 1 + 0.012 * Math.sin(this.animT * 3.2); v.sx = 1 - 0.006 * Math.sin(this.animT * 3.2); break;
      case 'walk': { const ph = t * TAU / 0.5; v.sy = 1 + 0.025 * Math.abs(Math.sin(ph)); v.rot = 0.035 * Math.sin(ph) * (this.walkDir || 1); break; }
      case 'jump': use('jump', () => { v.sy = 1.06; v.sx = 0.96; }); v.rot = 0.04; break;
      case 'land': use('floor', () => { v.sy = 0.92; v.sx = 1.07; }); break;
      case 'block': use('palms', () => { v.rot = -0.07; v.dx = -4; v.sy = 0.97; }); break;
      case 'taunt': use('fistup', () => { v.sx = 1 + 0.03 * Math.sin(t * 8); }); v.rot = 0.03 * Math.sin(t * 8); break;
      case 'attack': {
        const a = this.attack, big = a.name === 'power', kick = a.name === 'kick';
        const windKey = big ? 'cross' : kick ? 'knee' : 'stand2', hitKey = big ? 'uppercut' : kick ? 'sidekick' : 'jab';
        if (t < a.startup) {
          const k = smooth(t / a.startup);
          use(windKey, () => { v.rot = -(big ? 0.16 : 0.05) * k; v.sx = 1 - (big ? 0.05 : 0.02) * k; });
          v.dx = -(big ? 8 : 2) * k;
        } else if (t < a.startup + a.active) {
          use(hitKey, () => { v.rot = big ? 0.12 : 0.06; v.sx = big ? 1.05 : 1.02; });
          v.dx = big ? 16 : 8;
        } else {
          const k = 1 - smooth((t - a.startup - a.active) / a.recovery);
          use(hitKey, () => { v.rot = (big ? 0.12 : 0.06) * k; v.sx = 1 + (big ? 0.05 : 0.02) * k; });
          v.dx = (big ? 16 : 8) * k;
          if (v.real && k < 0.35) { v.frame = sp.stand; }       // settle back into the stance
        }
        break;
      }
      case 'hurt': { const k = 1 - t / Math.max(0.05, this.stateDur); use('leanback', () => { v.rot = -0.26 * k; v.sx = 1 - 0.04 * k; }); v.dx = -8 * k + 2 * Math.sin(t * 70) * k; break; }
      case 'down': fallen(t / 0.3); break;
      case 'getup': { if (t < 0.3) use('floor', () => lieFallback(false, 1 - smooth(t / 0.5))); else use('squat', () => lieFallback(false, 1 - smooth(t / 0.5))); break; }
      case 'ko': {
        const front = this.lie === 'front' || this.lie === 'front-hold';
        const k = this.lie.endsWith('hold') ? 1 : Math.min(1, t / 0.35);
        use('fallen', () => lieFallback(front, smooth(k)));
        if (v.real && k < 1) v.sy = 1 - 0.1 * Math.sin(k * Math.PI);
        break;
      }
      case 'defeat': {
        if (t < 0.6) use('leanback', () => { v.rot = 0.3 * smooth(t / 0.5); });
        else if (t < 1.1) use('floor', () => lieFallback(true, smooth((t - 0.6) / 0.8)));
        else use('fallen', () => lieFallback(true, 1));
        break;
      }
      case 'trip': {
        if (t < 0.5) { v.rot = 0.14 + 0.05 * Math.sin(t * 30); v.sy = 1 + 0.03 * Math.abs(Math.sin(t * 15)); }
        else if (t < 0.75) use('lunge', () => { v.rot = 0.14 + 0.3 * smooth((t - 0.5) / 0.25); });
        else if (t < 2.1) use('fallen', () => { const r = lieRot(true) * smooth(clamp((t - 0.75) / 0.3, 0, 1)); v.rot = r < 0.44 ? 0.44 : r; v.dy = lieDy(v.rot); v.dx = lieDx(v.rot); });
        else if (t < 2.4) use('floor', () => lieFallback(true, 1 - smooth((t - 2.1) / 0.5)));
        else use('squat', () => lieFallback(true, 1 - smooth((t - 2.1) / 0.5)));
        break;
      }
      case 'tired': use('squat', () => { v.rot = 0.32 + 0.05 * Math.sin(t * 9); v.sy = 0.95; }); v.sy *= 1 + 0.02 * Math.sin(t * 9); break;
      case 'whiff':
        if (t < 0.45) use('cross', () => { v.rot = -0.25 * smooth(t / 0.4); });
        else if (t < 0.65) { use('punchfront', () => { v.rot = 0.4; v.sx = 1.1; }); v.dx = 14; }
        else { use('leanback', () => {}); v.rot = 0.16 * Math.sin(t * 8); }
        break;
      case 'sneeze':
        if (t < 0.55) use('leanback', () => { v.rot = -0.12 - 0.12 * smooth(t / 0.55); });
        else if (t < 0.7) { use('palm', () => { v.rot = 0.35; }); v.dx = 6; }
        else { use('stand2', () => { v.rot = 0.35 * (1 - smooth((t - 0.7) / 0.5)); }); }
        break;
      case 'victory':
        if (sp.dance.length && t >= 0.8) { v.frame = sp.dance[Math.floor((t - 0.8) * 8) % sp.dance.length]; v.real = true; }
        else use('fistup', () => { v.sy = 1 + 0.04 * Math.max(0, Math.sin(t * 7)); });
        break;
      default: break;
    }
    return v;
  }

  draw(ctx) {
    const sp = this.sprite();
    if (sp) {
      ctx.save();
      ctx.translate(this.x, this.y);
      if (this.state === 'attack' && this.attack.name === 'power' && this.stateTime < this.attack.startup) {
        const k = this.stateTime / this.attack.startup, gx = this.facing * 26, gy = -sp.height * 0.58;
        const g = ctx.createRadialGradient(gx, gy, 2, gx, gy, 18 + k * 26);
        g.addColorStop(0, 'rgba(255,230,120,0.9)'); g.addColorStop(1, 'rgba(255,120,40,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, 18 + k * 26, 0, TAU); ctx.fill();
      }
      ctx.scale(this.facing * sp.faceDir, 1);
      const view = this.spriteView();
      drawSpriteFrame(ctx, view.frame, view);
      if (this.state === 'attack' && !view.real) {
        ctx.save(); ctx.translate(view.dx || 0, 0); ctx.rotate(view.rot || 0); drawStrikeOverlay(ctx, sp, this); ctx.restore();
      }
      ctx.restore();
      if (this.isDizzy()) {
        const h = this.headWorld();
        for (let i = 0; i < 3; i++) {
          const a = this.animT * 5 + i * TAU / 3;
          drawStar(ctx, h.x + Math.cos(a) * 30, h.y - 12 + Math.sin(a) * 10, 7, '#ffd166', this.style.ink);
        }
      }
      return;
    }
    ctx.save();
    ctx.translate(this.x, this.y);
    // charging glow on the rear fist during the power punch wind-up
    if (this.state === 'attack' && this.attack.name === 'power' && this.stateTime < this.attack.startup) {
      const fist = this.skel.armB.fist, A = this.pose.bodyAngle;
      const rx = fist.x * Math.cos(A) - fist.y * Math.sin(A), ry = fist.x * Math.sin(A) + fist.y * Math.cos(A);
      const gx = this.facing * rx, gy = -this.pose.hipH + ry;
      const k = this.stateTime / this.attack.startup;
      const g = ctx.createRadialGradient(gx, gy, 2, gx, gy, 18 + k * 26);
      g.addColorStop(0, 'rgba(255,230,120,0.9)'); g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, 18 + k * 26, 0, TAU); ctx.fill();
    }
    renderFighter(ctx, this);
    ctx.restore();
    // dizzy stars circling the head
    if (this.isDizzy()) {
      const h = this.headWorld();
      for (let i = 0; i < 3; i++) {
        const a = this.animT * 5 + i * TAU / 3;
        drawStar(ctx, h.x + Math.cos(a) * 30, h.y - 12 + Math.sin(a) * 10, 7, '#ffd166', this.style.ink);
      }
    }
  }

  drawShadow(ctx) {
    const air = clamp((FLOOR_Y - this.y) / 400, 0, 0.8);
    ctx.fillStyle = `rgba(0,0,0,${0.35 - air * 0.3})`;
    const lying = Math.abs(this.pose.bodyAngle) > 1 || (this.sprite() && (this.isLying() || this.state === 'ko' || this.state === 'tired'));
    ctx.beginPath(); ctx.ellipse(this.x, FLOOR_Y + 5, (lying ? 80 : 42) * (1 - air), 8, 0, 0, TAU); ctx.fill();
  }
}

/* ==========================================================================
   8. BACKGROUND - a sunset rooftop arena drawn at 1/3 resolution and scaled
      up without smoothing, which gives the chunky pixel-art look.
   ========================================================================== */
class Background {
  constructor() {
    this.w = W / BG_SCALE; this.h = H / BG_SCALE;          // 320 x 180
    this.low = makeCanvas(this.w, this.h);
    this.lctx = this.low.getContext('2d');
    this.sky = this.prerender((c) => this.drawSky(c));
    this.city = this.prerender((c) => this.drawCity(c));
    this.front = this.prerender((c) => this.drawFront(c));
    const rng = mulberry32(7);
    this.clouds = [];
    for (let i = 0; i < 5; i++) this.clouds.push({ x: rng() * this.w, y: 14 + rng() * 44, w: 22 + rng() * 26, speed: 3 + rng() * 5 });
    this.crowd = [];
    const palette = [['#1b1333', '#231a44', '#2a1f4f'], ['#140c26', '#1d1538', '#181030']];
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 40; i++) {
        this.crowd.push({ x: -6 + i * 8.4 + rng() * 4 + row * 4, row, ph: rng() * TAU, color: palette[row][Math.floor(rng() * 3)], arms: rng() < 0.4 });
      }
    }
  }

  prerender(fn) { const c = makeCanvas(this.w, this.h); fn(c.getContext('2d')); return c; }

  drawSky(c) {
    const g = c.createLinearGradient(0, 0, 0, 110);
    g.addColorStop(0, '#1a0b3d'); g.addColorStop(0.45, '#5b2a86'); g.addColorStop(0.75, '#e85d75'); g.addColorStop(1, '#ffb86b');
    c.fillStyle = g; c.fillRect(0, 0, this.w, 110);
    const rng = mulberry32(3);
    c.fillStyle = '#fff';
    for (let i = 0; i < 40; i++) { c.globalAlpha = 0.3 + rng() * 0.7; c.fillRect(Math.floor(rng() * this.w), Math.floor(rng() * 50), 1, 1); }
    c.globalAlpha = 1;
    // a retro striped sun
    c.fillStyle = '#ffe08a'; c.beginPath(); c.arc(236, 80, 22, 0, TAU); c.fill();
    c.fillStyle = '#ff9f1c'; c.beginPath(); c.arc(236, 80, 22, 0, Math.PI); c.fill();
    c.fillStyle = '#e85d75';
    for (let y = 84; y < 102; y += 5) c.fillRect(214, y, 44, 2);
  }

  drawCity(c) {
    const rng = mulberry32(42);
    let x = 0;
    while (x < this.w) {
      const w = 10 + Math.floor(rng() * 22), h = 20 + Math.floor(rng() * 55), top = 110 - h;
      c.fillStyle = rng() < 0.5 ? '#24143f' : '#2d1a4d';
      c.fillRect(x, top, w, h + 2);
      for (let wy = top + 3; wy < 108; wy += 5) {
        for (let wx = x + 2; wx < x + w - 2; wx += 4) {
          if (rng() < 0.45) { c.fillStyle = rng() < 0.8 ? '#ffd166' : '#ff9f1c'; c.fillRect(wx, wy, 2, 2); }
        }
      }
      if (rng() < 0.3) {
        c.fillStyle = '#24143f'; c.fillRect(x + Math.floor(w / 2), top - 8, 1, 8);
        c.fillStyle = '#ff4d4d'; c.fillRect(x + Math.floor(w / 2), top - 9, 1, 1);
      }
      x += w + 1 + Math.floor(rng() * 3);
    }
    // the back wall of the arena, with a banner
    c.fillStyle = '#3b2a5a'; c.fillRect(0, 108, this.w, 42);
    c.fillStyle = '#4a3870'; c.fillRect(0, 108, this.w, 3);
    c.fillStyle = '#34244f';
    for (let px = 4; px < this.w; px += 32) c.fillRect(px, 114, 26, 14);
    c.fillStyle = '#b3002d'; c.fillRect(92, 112, 136, 16);
    c.fillStyle = '#ffd166'; c.fillRect(92, 112, 136, 2); c.fillRect(92, 126, 136, 2);
    c.fillStyle = '#fff'; c.font = 'bold 9px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('ALWAYS WIN FIGHTER', 160, 120);
  }

  drawFront(c) {
    // railing in front of the crowd
    c.fillStyle = '#6b5a8e'; c.fillRect(0, 144, this.w, 2);
    c.fillStyle = '#4a3870'; c.fillRect(0, 146, this.w, 4);
    c.fillStyle = '#6b5a8e';
    for (let px = 6; px < this.w; px += 20) c.fillRect(px, 144, 2, 6);
    // the mat
    c.fillStyle = '#2d6a9f'; c.fillRect(0, 150, this.w, 30);
    c.fillStyle = '#3a7fb8'; c.fillRect(0, 150, this.w, 2);
    c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 1;
    for (let lx = -40; lx <= this.w + 40; lx += 40) { c.beginPath(); c.moveTo(lx, 150); c.lineTo(160 + (lx - 160) * 1.6, 180); c.stroke(); }
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(0, 160, this.w, 1); c.fillRect(0, 170, this.w, 1);
    c.strokeStyle = 'rgba(255,209,102,0.5)'; c.lineWidth = 2;
    c.beginPath(); c.ellipse(160, 165, 50, 9, 0, 0, TAU); c.stroke();
    c.fillStyle = '#1d3f63'; c.fillRect(0, 176, this.w, 4);
  }

  draw(ctx, t) {
    const l = this.lctx;
    l.clearRect(0, 0, this.w, this.h);
    l.drawImage(this.sky, 0, 0);
    l.fillStyle = 'rgba(255,214,230,0.75)';
    for (const cl of this.clouds) {
      const x = ((cl.x + t * cl.speed) % (this.w + 60)) - 30;
      l.fillRect(Math.floor(x), cl.y, cl.w, 5);
      l.fillRect(Math.floor(x + 5), cl.y - 3, cl.w - 12, 3);
      l.fillRect(Math.floor(x + 3), cl.y + 5, cl.w - 6, 2);
    }
    l.drawImage(this.city, 0, 0);
    // a bobbing, cheering crowd
    for (const p of this.crowd) {
      const bob = Math.sin(t * 3 + p.ph);
      const y = (p.row === 0 ? 134 : 141) - Math.max(0, bob) * 2;
      l.fillStyle = p.color;
      l.fillRect(Math.floor(p.x), Math.floor(y), 6, 10);
      l.beginPath(); l.arc(p.x + 3, y - 2, 3, 0, TAU); l.fill();
      if (p.arms && bob > 0.3) { l.fillRect(Math.floor(p.x) - 2, Math.floor(y) - 6, 1, 7); l.fillRect(Math.floor(p.x) + 7, Math.floor(y) - 6, 1, 7); }
    }
    l.drawImage(this.front, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.low, 0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
  }
}

/* ==========================================================================
   9. GAME - rounds, HUD, hit resolution, effects and the main loop
      Modes: menu -> intro (VS screen) -> round_intro -> fight -> round_end
             -> (next round | match_end)
   ========================================================================== */
class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.hero = new Fighter('hero', this);
    this.challenger = new Fighter('challenger', this);
    this.bg = new Background();
    this.mode = 'menu'; this.modeT = 0; this.paused = false;
    this.debugSpeed = 1;                        // >1 runs several updates per frame (used by tests)
    this.round = 1; this.heroWins = 0; this.challengerWins = 0; this.timer = ROUND_TIME;
    this.timeScale = 1; this.hitstop = 0; this.time = 0; this.lastNow = 0;
    this.lastPlayerAction = -100; this.introTap = false;
    this.particles = []; this.popups = []; this.banners = [];
    this.shakeP = 0; this.flashA = 0;
    this.roundEnd = null;
    this.stats = this.freshStats();
    this.dance = 'showoff';                     // key into DANCES; set from the preview screen
    this.frame = this.frame.bind(this);
  }

  freshStats() { return { punches: 0, power: 0, blocked: 0, damageTaken: 0, misfortunes: 0, rounds: 0, time: 0, plot: 0 }; }
  start() { this.lastNow = performance.now(); requestAnimationFrame(this.frame); }
  setMode(m) { this.mode = m; this.modeT = 0; Screens.onMode(m); }
  notePlayerAction() { this.lastPlayerAction = this.time; }
  playerIdle() { return this.time - this.lastPlayerAction > IDLE_PLAYER_SECONDS; }

  /* ------------------------------------------------------------ main loop */
  frame(now) {
    const rawDt = Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    Input.update();
    if (Input.pressed('pause')) this.togglePause();
    if (!this.paused) for (let i = 0; i < this.debugSpeed; i++) this.update(rawDt);
    this.render();
    requestAnimationFrame(this.frame);
  }

  update(rawDt) {
    this.time += rawDt; this.modeT += rawDt;
    let dt = rawDt * this.timeScale;
    if (this.hitstop > 0) { this.hitstop -= rawDt; dt = 0; }     // freeze the fighters on impact
    switch (this.mode) {
      case 'menu':
        this.updateFighters(dt, false);
        break;
      case 'intro':
        this.updateFighters(dt, false);
        if ((this.modeT > 0.5 && (Input.pressed('start') || Input.pressed('jab') || Input.pressed('power') || this.introTap)) || this.modeT > 6) {
          this.introTap = false;
          this.startMatch();
        }
        break;
      case 'round_intro':
        this.updateFighters(dt, false);
        if (this.modeT >= 1.3) {
          this.setMode('fight');
          this.banner('FIGHT!', { color: '#ff4d4d', dur: 0.9, size: 110 });
          Sound.play('fight');
        }
        break;
      case 'fight': this.updateFight(dt); break;
      case 'round_end': this.updateRoundEnd(dt, rawDt); break;
      case 'match_end':
        this.updateFighters(dt, false);
        if (Math.random() < rawDt * 6) this.confetti();
        break;
      case 'dance':                                    // victory dance preview from the start screen
        this.updateFighters(dt, false);
        if (Math.random() < rawDt * 6) this.confetti();
        if ((this.modeT > 0.5 && Input.pressed('start')) || Input.pressed('pause')) this.goMenu();
        break;
      default: break;
    }
    this.updateEffects(rawDt);
  }

  updateFighters(dt, control) {
    if (control) { this.hero.updatePlayer(dt, Input); this.challenger.updateAI(dt, this.hero); }
    this.hero.update(dt, this.challenger);
    this.challenger.update(dt, this.hero);
    this.separate();
  }

  updateFight(dt) {
    this.updateFighters(dt, true);
    if (this.mode !== 'fight') return;              // a KO may just have ended the round
    this.stats.time += dt;
    this.timer = Math.max(0, this.timer - dt);
    if (this.timer <= 0) this.startRoundEnd('time');
  }

  /** Keeps the two fighters from overlapping (unless one jumps over the other). */
  separate() {
    const a = this.hero, b = this.challenger;
    if (a.isLying() || b.isLying() || Math.abs(a.y - b.y) > 90) return;
    const dx = b.x - a.x, d = Math.abs(dx);
    if (d >= PUSH_DISTANCE) return;
    const s = dx > 0 ? 1 : dx < 0 ? -1 : a.facing;
    const push = (PUSH_DISTANCE - d) / 2;
    a.x -= s * push; b.x += s * push;
    if (a.x < ARENA_LEFT) { a.x = ARENA_LEFT; b.x = a.x + PUSH_DISTANCE; }
    if (a.x > ARENA_RIGHT) { a.x = ARENA_RIGHT; b.x = a.x - PUSH_DISTANCE; }
    if (b.x < ARENA_LEFT) { b.x = ARENA_LEFT; a.x = b.x + PUSH_DISTANCE; }
    if (b.x > ARENA_RIGHT) { b.x = ARENA_RIGHT; a.x = b.x - PUSH_DISTANCE; }
  }

  /* ------------------------------------------------------- match flow */
  startIntro() {
    if (this.mode === 'intro') return;
    this.paused = false;
    this.hero.reset(320, 1); this.challenger.reset(640, -1);
    this.introTap = false;
    this.setMode('intro');
    Sound.play('round');
  }

  /** Shows the victory dance without playing a match (start screen button, or ?dance in the URL). */
  startDancePreview() {
    this.paused = false;
    this.hero.reset(430, 1); this.challenger.reset(700, -1);
    this.challenger.knockOut();
    this.hero.setState('victory');
    this.particles.length = 0; this.popups.length = 0; this.banners.length = 0;
    this.introTap = false;
    this.setMode('dance');
    this.banner('HERO WINS!', { color: '#ffd166', dur: 4.2, size: 96, sub: 'victory dance preview' });
    Sound.play('victory');
  }

  startMatch() {
    this.round = 1; this.heroWins = 0; this.challengerWins = 0;
    this.stats = this.freshStats();
    this.startRound();
  }

  startRound() {
    this.hero.reset(320, 1); this.challenger.reset(640, -1);
    this.timer = ROUND_TIME; this.timeScale = 1; this.hitstop = 0; this.roundEnd = null;
    this.particles.length = 0; this.popups.length = 0; this.banners.length = 0;
    this.lastPlayerAction = this.time;
    this.setMode('round_intro');
    this.banner(this.round >= 3 ? 'FINAL ROUND' : `ROUND ${this.round}`, { color: '#ffffff', dur: 1.25, size: 84 });
    Sound.play('round');
  }

  startRoundEnd(reason) {
    if (this.mode === 'round_end') return;
    this.setMode('round_end');
    this.roundEnd = { reason, phase: reason === 'ko' ? 'ko' : 'timeup', t: 0 };
    this.hero.vx = 0;
    if (this.hero.canAct()) this.hero.setState('idle');
    if (reason === 'ko') {
      this.timeScale = 0.25; this.flashA = 1; this.shake(18);
      Sound.play('ko');
      this.banner('K.O.!', { color: '#ffd166', stroke: '#7a0000', dur: 1.6, size: 130 });
    } else {
      Sound.play('timeup');
      this.banner('TIME UP!', { color: '#9bf6ff', dur: 1.4, size: 90 });
      this.challenger.vx = 0;
      if (this.challenger.isLying()) this.challenger.knockOut();   // already on the floor: stay there
      else this.challenger.setState('defeat', 1.6);                 // she collapses from exhaustion anyway
    }
  }

  updateRoundEnd(dt, rawDt) {
    const re = this.roundEnd;
    re.t += rawDt;
    this.updateFighters(dt, false);
    if (re.phase === 'ko') {
      if (re.t > 0.9) this.timeScale = 1;
      if (re.t > 1.7) this.heroWinsRound();
    } else if (re.phase === 'timeup') {
      if (re.t > 1.9) this.heroWinsRound();
    } else if (re.phase === 'wins') {
      if (Math.random() < rawDt * 10) this.confetti();
      if (re.t > 4.6) this.nextRound();
    }
  }

  heroWinsRound() {
    const re = this.roundEnd;
    re.phase = 'wins'; re.t = 0;
    this.heroWins++; this.stats.rounds++;
    this.hero.setState('victory');
    const sub = re.reason === 'time'
      ? 'the Challenger ran out of steam'
      : pick(['FLAWLESS!', 'as expected', 'what a surprise', 'rigged? never.', 'the script said so']);
    this.banner('HERO WINS!', { color: '#ffd166', dur: 4.2, size: 96, sub });
    Sound.play('victory');
  }

  nextRound() {
    if (this.heroWins >= ROUNDS_TO_WIN) this.endMatch();
    else { this.round++; this.startRound(); }
  }

  endMatch() {
    this.setMode('match_end');
    Screens.showVictory(this);
  }

  goMenu() {
    this.paused = false;
    this.hero.reset(320, 1); this.challenger.reset(640, -1);
    this.particles.length = 0; this.popups.length = 0; this.banners.length = 0;
    this.timeScale = 1; this.hitstop = 0;
    this.setMode('menu');
  }

  togglePause() {
    if (this.mode !== 'fight' && this.mode !== 'round_intro' && this.mode !== 'round_end') return;
    this.paused = !this.paused;
    Screens.onPause(this.paused);
  }

  /* --------------------------------------------------- hits and damage */
  /** Applies damage. The Hero's health is clamped to HERO_MIN_HP. Returns damage dealt. */
  damage(f, amount) {
    const before = f.hp;
    f.hp = f.isHero ? Math.max(HERO_MIN_HP, f.hp - amount) : Math.max(0, f.hp - amount);
    return before - f.hp;
  }

  resolveHit(att, def, atk, p) {
    const dir = att.facing;
    if (def.isBlocking() && !atk.guardBreak) {
      this.sparks(p.x, p.y, 8, ['#ffffff', '#9bf6ff', '#a0c4ff'], 220);
      this.popup('BLOCK', p.x, p.y - 30, { color: '#9bf6ff', size: 26 });
      Sound.play('block');
      def.vx = dir * 140; this.shake(3); this.hitstop = 0.04;
      this.stats.blocked++;
      if (!def.isHero) {                                  // chip damage through her guard
        this.damage(def, 2);
        if (def.hp <= 0) { def.knockOut(); this.startRoundEnd('ko'); }
      }
      return;
    }
    if (def.isBlocking() && atk.guardBreak) this.popup('GUARD BREAK!', p.x, p.y - 75, { color: '#ff9f1c', size: 30 });
    const dealt = this.damage(def, atk.damage);
    const big = att.isHero;
    this.sparks(p.x, p.y, big ? (atk.guardBreak ? 26 : 14) : 5,
      big ? ['#ffd166', '#ff9f1c', '#ffffff', '#ff4d4d'] : ['#ffc6ff', '#ffffff'], big ? 340 : 160);
    this.popup(pick(atk.words), p.x + dir * 10, p.y - 45, {
      color: big ? pick(['#ffd166', '#ff4d4d', '#ff9f1c']) : '#ffc6ff',
      size: big ? (atk.guardBreak ? 58 : 42) : 20, rot: rand(-0.25, 0.25),
    });
    if (dealt > 0) {
      const h = def.headWorld();
      this.popup('-' + dealt, def.x - dir * 10, h.y - 60, { color: '#ffffff', size: big ? 24 : 16, life: 0.8 });
    }
    Sound.play(atk.sound);
    this.shake(atk.shake);
    this.hitstop = big ? (atk.guardBreak ? 0.1 : 0.05) : 0.02;
    if (def.isHero) {
      this.stats.damageTaken += dealt;
      if (dealt === 0) {
        const h = def.headWorld();
        this.popup('PLOT ARMOR!', def.x, h.y - 70, { color: '#ffd166', size: 30, life: 1.2 });
        Sound.play('plot');
        def.smugT = 1.2; this.stats.plot++;
      }
      def.hurtBy(atk, dir);
    } else {
      this.stats.punches++;
      if (atk.guardBreak) this.stats.power++;
      def.hurtBy(atk, dir);
      if (def.hp <= 0) this.startRoundEnd('ko');
    }
  }

  /** The Challenger hurting herself (trip, exhaustion, whiff, sneeze). */
  selfOwn(f, amount, word, color) {
    const dealt = this.damage(f, amount);
    const h = f.headWorld();
    this.popup(word, h.x, h.y - 55, { color, size: 42, rot: rand(-0.2, 0.2) });
    if (dealt > 0) this.popup('-' + dealt, f.x, h.y - 20, { color: '#fff', size: 20, life: 0.8 });
    if (f.hp <= 0) { f.knockOut(); this.startRoundEnd('ko'); }
  }

  /* -------------------------------------------------------------- effects */
  shake(p) { this.shakeP = Math.max(this.shakeP, p); }

  sparks(x, y, n, colors, speed = 300) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), v = rand(speed * 0.4, speed);
      this.particles.push({ type: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.25, 0.5), max: 0.5, size: rand(5, 11), color: pick(colors), rot: rand(0, TAU), spin: rand(-12, 12), g: 500 });
    }
  }
  dust(x, y, n) {
    for (let i = 0; i < n; i++) this.particles.push({ type: 'dot', x: x + rand(-20, 20), y, vx: rand(-60, 60), vy: rand(-90, -30), life: rand(0.4, 0.8), max: 0.8, size: rand(4, 9), color: 'rgba(220,210,240,0.7)', g: 60 });
  }
  sweat(x, y) {
    this.particles.push({ type: 'dot', x, y, vx: rand(-40, 40), vy: rand(-120, -60), life: 0.7, max: 0.7, size: 5, color: '#8fd3ff', g: 500 });
  }
  confetti() {
    this.particles.push({ type: 'confetti', x: rand(0, W), y: -10, vx: rand(-40, 40), vy: rand(80, 160), life: 4, max: 4, size: rand(6, 10), color: pick(['#ffd166', '#ff4d4d', '#9bf6ff', '#caffbf', '#ffc6ff', '#ffffff']), rot: rand(0, TAU), spin: rand(-6, 6), g: 40 });
  }
  popup(text, x, y, o = {}) {
    this.popups.push({ text, x, y, vy: -70, life: o.life || 1, max: o.life || 1, color: o.color || '#fff', size: o.size || 32, rot: o.rot || 0 });
  }
  banner(text, o = {}) {
    this.banners.push({ text, sub: o.sub, color: o.color || '#fff', stroke: o.stroke || '#1d1530', size: o.size || 80, dur: o.dur || 1.5, t: 0 });
  }

  updateEffects(dt) {
    for (const p of this.particles) {
      p.life -= dt; p.vy += (p.g || 0) * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.spin) p.rot += p.spin * dt;
      if (p.type === 'confetti') p.vx += Math.sin(p.rot) * 30 * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0 && p.y < H + 20);
    for (const p of this.popups) { p.life -= dt; p.y += p.vy * dt; p.vy *= 1 - 2 * dt; }
    this.popups = this.popups.filter((p) => p.life > 0);
    for (const b of this.banners) b.t += dt;
    this.banners = this.banners.filter((b) => b.t < b.dur);
    this.shakeP = Math.max(0, this.shakeP - 45 * dt);
    this.flashA = Math.max(0, this.flashA - 2.5 * dt);
  }

  /* ------------------------------------------------------------ rendering */
  render() {
    const ctx = this.ctx, s = this.scale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const sx = (Math.random() * 2 - 1) * this.shakeP, sy = (Math.random() * 2 - 1) * this.shakeP;
    ctx.save();
    ctx.translate(sx, sy);
    this.bg.draw(ctx, this.time);
    if (this.mode === 'intro') { this.renderIntro(ctx); ctx.restore(); return; }
    // the attacker is drawn on top
    const order = (this.challenger.state === 'attack' && this.hero.state !== 'attack') ? [this.hero, this.challenger] : [this.challenger, this.hero];
    for (const f of order) f.drawShadow(ctx);
    for (const f of order) f.draw(ctx);
    this.renderParticles(ctx);
    this.renderPopups(ctx);
    ctx.restore();
    if (this.mode !== 'menu' && this.mode !== 'dance') this.renderHUD(ctx);
    if (this.mode === 'dance') arcadeText(ctx, (DANCES[this.dance] || DANCES.showoff).label.toUpperCase(), W / 2, 40, 34, '#ffd166', '#1d1530');
    this.renderBanners(ctx);
    if (this.flashA > 0) { ctx.fillStyle = `rgba(255,255,255,${this.flashA.toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  }

  renderParticles(ctx) {
    for (const p of this.particles) {
      const a = clamp(p.life / p.max, 0, 1);
      if (p.type === 'spark') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        drawStar(ctx, 0, 0, p.size * (0.4 + 0.6 * a), p.color, null);
        ctx.restore();
      } else if (p.type === 'confetti') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      } else {
        ctx.globalAlpha = a; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  renderPopups(ctx) {
    for (const p of this.popups) {
      const u = 1 - p.life / p.max;
      const scale = u < 0.15 ? lerp(0.3, 1.15, u / 0.15) : u < 0.3 ? lerp(1.15, 1, (u - 0.15) / 0.15) : 1;
      ctx.save();
      ctx.globalAlpha = u > 0.7 ? clamp((1 - u) / 0.3, 0, 1) : 1;
      ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(scale, scale);
      arcadeText(ctx, p.text, 0, 0, p.size, p.color, '#1d1530');
      ctx.restore();
    }
  }

  renderBanners(ctx) {
    for (const b of this.banners) {
      let scale = 1, alpha = 1;
      if (b.t < 0.25) scale = lerp(2.4, 1, easeOut(b.t / 0.25));
      if (b.t > b.dur - 0.3) alpha = clamp((b.dur - b.t) / 0.3, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(W / 2, H / 2 - 50);
      ctx.scale(scale, scale);
      arcadeText(ctx, b.text, 0, 0, b.size, b.color, b.stroke);
      if (b.sub) arcadeText(ctx, b.sub, 0, b.size * 0.62, Math.max(18, b.size * 0.28), '#ffffff', b.stroke);
      ctx.restore();
    }
  }

  renderHUD(ctx) {
    const barW = 360, barH = 24, y = 24;
    this.drawHealthBar(ctx, this.hero, 70, y, barW, barH, 'left');
    this.drawHealthBar(ctx, this.challenger, W - 70 - barW, y, barW, barH, 'right');
    this.drawPortrait(ctx, this.hero, 40, 40, 26);
    this.drawPortrait(ctx, this.challenger, W - 40, 40, 26);
    arcadeText(ctx, this.hero.name, 74, y + barH + 18, 20, '#fff', '#1d1530', 'left');
    arcadeText(ctx, this.challenger.name, W - 74, y + barH + 18, 20, '#fff', '#1d1530', 'right');
    arcadeText(ctx, 'P1', 70 + barW, y + barH + 18, 15, '#ffd166', '#1d1530', 'right', false);
    arcadeText(ctx, 'CPU', W - 70 - barW, y + barH + 18, 15, '#ffc6ff', '#1d1530', 'left', false);
    // round win markers
    for (let i = 0; i < ROUNDS_TO_WIN; i++) {
      this.drawPip(ctx, 84 + i * 24, y + barH + 44, i < this.heroWins);
      this.drawPip(ctx, W - 84 - i * 24, y + barH + 44, i < this.challengerWins);
    }
    // timer
    const tx = W / 2;
    ctx.fillStyle = '#1d1530'; ctx.fillRect(tx - 44, 8, 88, 56);
    ctx.fillStyle = '#2a1b4a'; ctx.fillRect(tx - 40, 12, 80, 48);
    const secs = Math.ceil(this.timer);
    const urgent = secs <= 10 && this.mode === 'fight' && Math.floor(this.time * 4) % 2 === 0;
    arcadeText(ctx, String(secs).padStart(2, '0'), tx, 37, 40, urgent ? '#ff4d4d' : '#ffd166', '#1d1530', 'center', false);
  }

  drawPip(ctx, x, y, filled) {
    ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU);
    ctx.fillStyle = filled ? '#ffd166' : '#2a1b4a'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#1d1530'; ctx.stroke();
  }

  drawHealthBar(ctx, f, x, y, w, h, side) {
    ctx.fillStyle = '#1d1530'; ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.fillStyle = '#5a1a1a'; ctx.fillRect(x, y, w, h);
    const hpW = w * clamp(f.hp / f.maxHp, 0, 1), ghostW = w * clamp(f.displayHp / f.maxHp, 0, 1);
    // bars drain toward the centre of the screen
    const bx = side === 'left' ? x : x + w - hpW, gx = side === 'left' ? x : x + w - ghostW;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(gx, y, ghostW, h);
    const low = f.hp / f.maxHp < 0.3;
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, low ? '#ff9f1c' : '#ffe066'); grad.addColorStop(1, low ? '#e63946' : '#52b788');
    ctx.fillStyle = grad; ctx.fillRect(bx, y, hpW, h);
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(bx, y, hpW, h * 0.35);
    if (f.isHero && f.hp <= HERO_MIN_HP) {
      ctx.lineWidth = 3; ctx.strokeStyle = `rgba(255,209,102,${(0.5 + 0.5 * Math.sin(this.time * 10)).toFixed(3)})`;
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      arcadeText(ctx, 'PLOT ARMOR', x + w - 8, y + h / 2, 14, '#ffd166', '#1d1530', 'right');
    }
  }

  drawPortrait(ctx, f, cx, cy, r) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    if (!f.isHero) { ctx.translate(cx, cy); ctx.scale(-1, 1); ctx.translate(-cx, -cy); }   // look toward the centre
    ctx.drawImage(f.face, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    ctx.lineWidth = 4; ctx.strokeStyle = '#1d1530'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffd166'; ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, TAU); ctx.stroke();
  }

  /** The "VS" character introduction screen. */
  renderIntro(ctx) {
    const t = this.modeT;
    ctx.fillStyle = 'rgba(10,5,30,0.8)'; ctx.fillRect(-40, -40, W + 80, H + 80);
    const slide = easeOut(clamp(t / 0.6, 0, 1));
    fillPoly(ctx, [{ x: -40, y: -40 }, { x: W / 2 + 60, y: -40 }, { x: W / 2 - 60, y: H + 40 }, { x: -40, y: H + 40 }], 'rgba(47,85,255,0.28)');
    fillPoly(ctx, [{ x: W / 2 + 60, y: -40 }, { x: W + 40, y: -40 }, { x: W + 40, y: H + 40 }, { x: W / 2 - 60, y: H + 40 }], 'rgba(142,45,226,0.28)');
    const hx = lerp(-250, 230, slide), cx = lerp(W + 250, W - 230, slide);
    this.drawFighterPreview(ctx, this.hero, hx, 500, 1.55, CLIPS.idle(t), 1);
    this.drawFighterPreview(ctx, this.challenger, cx, 500, 1.55, CLIPS.taunt(t), -1);
    ctx.save();
    ctx.globalAlpha = slide;
    arcadeText(ctx, 'THE HERO', 230, 80, 52, '#ffd166', '#1d1530');
    arcadeText(ctx, 'Record: 999 - 0', 230, 122, 22, '#fff', '#1d1530');
    arcadeText(ctx, 'Undefeated. Unbothered. Lucky.', 230, 150, 18, '#cfc6ff', '#1d1530', 'center', false);
    arcadeText(ctx, 'THE CHALLENGER', W - 230, 80, 52, '#ffc6ff', '#1d1530');
    arcadeText(ctx, 'Record: 0 - 999', W - 230, 122, 22, '#fff', '#1d1530');
    arcadeText(ctx, 'Trained for years. Trips a lot.', W - 230, 150, 18, '#cfc6ff', '#1d1530', 'center', false);
    ctx.restore();
    const pulse = 1 + 0.08 * Math.sin(t * 6);
    ctx.save();
    ctx.translate(W / 2, H / 2 - 20); ctx.scale(pulse, pulse); ctx.rotate(-0.1);
    arcadeText(ctx, 'VS', 0, 0, 120, '#ff4d4d', '#ffffff');
    ctx.restore();
    if (t > 0.8 && Math.floor(t * 2) % 2 === 0) arcadeText(ctx, 'PRESS ENTER OR TAP TO FIGHT', W / 2, H - 36, 24, '#fff', '#1d1530');
  }

  drawFighterPreview(ctx, f, x, feetY, scale, pose, facing) {
    const spr = f.sprite();
    if (spr) {
      ctx.save(); ctx.translate(x, feetY); ctx.scale(facing * spr.faceDir * scale, scale);
      drawSpriteFrame(ctx, spr.stand, { sy: 1 + 0.012 * Math.sin(this.time * 3.2) });
      ctx.restore();
      return;
    }
    const sp = scaleLegs(pose);
    const view = { style: f.style, pose: sp, skel: computeSkeleton(sp, f.style), facing, face: FaceStore.get(f.id, 'normal'), photoFace: FaceStore.hasCustom(f.id), animT: this.time, vx: 0 };
    ctx.save(); ctx.translate(x, feetY); ctx.scale(scale, scale);
    renderFighter(ctx, view);
    ctx.restore();
  }
}

/* ==========================================================================
   10. SCREENS - the DOM overlays and settings
   ========================================================================== */
const $ = (id) => document.getElementById(id);

const Screens = (() => {
  let game = null;
  const settings = (() => {
    try { return Object.assign({ sound: true, touch: 'auto' }, JSON.parse(localStorage.getItem('awf_settings') || '{}')); }
    catch (e) { return { sound: true, touch: 'auto' }; }
  })();

  function saveSettings() { try { localStorage.setItem('awf_settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== id));
    fitTitles();
  }

  /** Shrinks the big one-line titles when the available font is wider than expected. */
  function fitTitles() {
    const stageW = $('stage').clientWidth;
    document.querySelectorAll('.title-main, .title-sub, .victory-title').forEach((el) => {
      el.style.fontSize = '';
      if (!el.offsetParent) return;                         // hidden
      const max = stageW * 0.92;
      if (el.scrollWidth > max) el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * max / el.scrollWidth) + 'px';
    });
  }
  function hideAll() { document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden')); }

  function applySettings() {
    Sound.setMuted(!settings.sound);
    const touchDevice = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0;
    const on = settings.touch === 'on' || (settings.touch === 'auto' && touchDevice);
    document.body.classList.toggle('touch', on);
    const soundLabel = `\u{1F50A} Sound: ${settings.sound ? 'On' : 'Off'}`;
    const touchLabel = `\u{1F4F1} Touch controls: ${{ auto: 'Auto', on: 'On', off: 'Off' }[settings.touch]}`;
    for (const id of ['btn-sound', 'btn-sound-2']) $(id).textContent = soundLabel;
    for (const id of ['btn-touch', 'btn-touch-2']) $(id).textContent = touchLabel;
  }

  function setDance(key) {
    if (!DANCES[key]) key = 'showoff';
    game.dance = key; settings.dance = key; saveSettings();
    document.querySelectorAll('#dance-bar [data-dance]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.dance === key));
  }

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    } catch (e) { /* not supported (e.g. iPhone Safari) */ }
  }

  function init(g) {
    game = g;
    $('btn-start').addEventListener('click', () => { Sound.unlock(); Sound.play('ui'); game.startIntro(); });
    $('btn-play-again').addEventListener('click', () => { Sound.play('ui'); game.startMatch(); });
    $('btn-victory-menu').addEventListener('click', () => { Sound.play('ui'); game.goMenu(); });
    $('btn-pause').addEventListener('click', () => { Sound.play('ui'); game.togglePause(); });
    $('btn-resume').addEventListener('click', () => { Sound.play('ui'); game.togglePause(); });
    $('btn-pause-menu').addEventListener('click', () => { Sound.play('ui'); game.goMenu(); });
    for (const id of ['btn-sound', 'btn-sound-2']) $(id).addEventListener('click', () => { settings.sound = !settings.sound; saveSettings(); applySettings(); Sound.play('ui'); });
    for (const id of ['btn-touch', 'btn-touch-2']) $(id).addEventListener('click', () => {
      settings.touch = { auto: 'on', on: 'off', off: 'auto' }[settings.touch]; saveSettings(); applySettings(); Sound.play('ui');
    });
    for (const id of ['btn-fullscreen', 'btn-fullscreen-2']) $(id).addEventListener('click', () => { Sound.play('ui'); toggleFullscreen(); });

    // Enter / Space start the game from the start screen and replay from the victory screen.
    Input.onPress((action) => {
      if (action !== 'start') return;
      if (game.mode === 'menu' && !$('screen-start').classList.contains('hidden')) game.startIntro();
      else if (game.mode === 'match_end' && !$('screen-victory').classList.contains('hidden')) game.startMatch();
    });
    // Tapping the arena skips the VS screen.
    game.canvas.addEventListener('pointerdown', () => { if (game.mode === 'intro') game.introTap = true; });
    $('btn-dance').addEventListener('click', () => { Sound.unlock(); Sound.play('ui'); game.startDancePreview(); });
    // dance picker shown on the preview screen
    const bar = $('dance-bar');
    for (const key in DANCES) {
      const b = document.createElement('button');
      b.className = 'btn btn-small'; b.dataset.dance = key; b.textContent = DANCES[key].label;
      b.addEventListener('click', () => { Sound.play('ui'); setDance(key); game.startDancePreview(); });
      bar.appendChild(b);
    }
    const back = document.createElement('button');
    back.className = 'btn btn-small btn-ghost'; back.textContent = '\u25c0 Back';
    back.addEventListener('click', () => { Sound.play('ui'); game.goMenu(); });
    bar.appendChild(back);
    window.addEventListener('keydown', (e) => {               // number keys switch dances in the preview
      if (game.mode !== 'dance') return;
      const keys = Object.keys(DANCES), n = parseInt(e.key, 10);
      if (n >= 1 && n <= keys.length) { setDance(keys[n - 1]); game.startDancePreview(); }
    });
    setDance(settings.dance || 'showoff');
    applySettings();
  }

  function onMode(m) {
    if (m === 'menu') show('screen-start');
    else if (m !== 'match_end') hideAll();
    $('btn-pause').classList.toggle('hidden', !(m === 'fight' || m === 'round_intro' || m === 'round_end'));
    $('dance-bar').classList.toggle('hidden', m !== 'dance');
  }

  function onPause(paused) { if (paused) show('screen-pause'); else hideAll(); }

  function showVictory(g) {
    const s = g.stats;
    $('victory-sub').textContent = pick([
      'A flawless 2 to 0. Nobody is surprised.',
      'The Challenger has requested a rematch. It will go the same way.',
      'Judges score it 10-10-10 for the Hero. The judges are also the Hero.',
      'Experts call it the least surprising result in sports history.',
    ]);
    const rows = [
      ['Rounds', `${g.heroWins} - ${g.challengerWins}`],
      ['Punches landed', s.punches],
      ['Power punches landed', s.power],
      ['Blocks', s.blocked],
      ['Damage taken', `${s.damageTaken} (floor: ${HERO_MIN_HP}%)`],
      ['Plot armor saves', s.plot],
      ['Challenger misfortunes', s.misfortunes],
      ['Fight time', `${s.time.toFixed(1)} s`],
    ];
    $('victory-stats').innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join('');
    show('screen-victory');
  }

  return { init, onMode, onPause, showVictory, show, hideAll, fitTitles, setDance };
})();

// CUSTOM-FACES:START
/* ==========================================================================
   10b. CUSTOM FACES (feature) - upload a photo from the device, crop it to a
        circle (zoom + drag to reposition) and map it onto the fighter's head.
        Images are kept in this browser only (localStorage); nothing is sent
        to any server. Optional drop-in defaults can be configured in
        assets/faces/faces.js.
   ========================================================================== */
const FaceCustomizer = (() => {
  const STORAGE_KEY = 'awf_faces_v1';
  const SOURCE_MAX = 512;                      // uploaded photos are downscaled before being kept
  const cards = {};
  let game = null, returnTo = 'start';

  function makeCard(el) {
    const card = {
      who: el.dataset.who, el, img: null, fromAsset: false, zoom: 1, ox: 0, oy: 0,
      preview: el.querySelector('.face-preview'), zoomInput: el.querySelector('.face-zoom'),
      fileInput: el.querySelector('.face-file'), resetBtn: el.querySelector('.face-reset'),
    };
    card.fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadFile(card, file);
      e.target.value = '';
    });
    card.resetBtn.addEventListener('click', () => {
      card.img = null; card.fromAsset = false; card.zoom = 1; card.ox = card.oy = 0; card.zoomInput.value = 1;
      apply(card); Sound.play('ui');
    });
    card.zoomInput.addEventListener('input', () => { card.zoom = parseFloat(card.zoomInput.value) || 1; apply(card); });
    // drag the preview to reposition the photo inside the circle
    let drag = null;
    card.preview.addEventListener('pointerdown', (e) => {
      if (!card.img) return;
      drag = { x: e.clientX, y: e.clientY, ox: card.ox, oy: card.oy };
      try { card.preview.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    card.preview.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = FACE_SIZE / card.preview.getBoundingClientRect().width;     // pan is stored in face-canvas units
      card.ox = drag.ox + (e.clientX - drag.x) * k;
      card.oy = drag.oy + (e.clientY - drag.y) * k;
      apply(card, true);
    });
    const endDrag = () => { if (drag) { drag = null; apply(card); } };
    card.preview.addEventListener('pointerup', endDrag);
    card.preview.addEventListener('pointercancel', endDrag);
    return card;
  }

  /** Reads an image file picked on the device. It never leaves the browser. */
  function loadFile(card, file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      card.img = downscale(img); card.fromAsset = false;
      card.zoom = 1; card.ox = card.oy = 0; card.zoomInput.value = 1;
      apply(card); Sound.play('ui');
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('Sorry, that image could not be read. Try a JPG or PNG.'); };
    img.src = url;
  }

  function downscale(img) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.min(1, SOURCE_MAX / Math.max(iw, ih));
    const c = makeCanvas(Math.max(1, Math.round(iw * s)), Math.max(1, Math.round(ih * s)));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /** Draws the source image cover-fitted into a circle, with zoom and pan. */
  function renderFace(card, target) {
    const ctx = target.getContext('2d'), S = target.width, img = card.img;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, TAU); ctx.clip();
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const base = (S / Math.min(iw, ih)) * card.zoom;
    const dw = iw * base, dh = ih * base, k = S / FACE_SIZE;
    ctx.drawImage(img, S / 2 - dw / 2 + card.ox * k, S / 2 - dh / 2 + card.oy * k, dw, dh);
    ctx.restore();
  }

  function apply(card, skipSave) {
    if (card.img) {
      const face = makeCanvas(FACE_SIZE, FACE_SIZE);
      renderFace(card, face);
      FaceStore.setCustom(card.who, face);
    } else {
      FaceStore.setCustom(card.who, null);
    }
    drawPreview(card);
    if (!skipSave) save();
  }

  function drawPreview(card) {
    const c = card.preview, ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(FaceStore.get(card.who, 'normal'), 0, 0, c.width, c.height);
  }

  /** Remembers uploaded faces in this browser so they survive a reload. */
  function save() {
    const out = {};
    for (const who in cards) {
      const c = cards[who];
      if (!c.img || c.fromAsset) continue;
      try { out[who] = { src: c.img.toDataURL('image/jpeg', 0.85), zoom: c.zoom, ox: c.ox, oy: c.oy }; } catch (e) { /* skip */ }
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch (e) { /* storage full or disabled: fine for this session */ }
  }

  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved) return;
    for (const who in saved) {
      const c = cards[who], d = saved[who];
      if (!c || !d || !d.src) continue;
      const img = new Image();
      img.onload = () => {
        c.img = downscale(img); c.fromAsset = false;
        c.zoom = d.zoom || 1; c.ox = d.ox || 0; c.oy = d.oy || 0; c.zoomInput.value = c.zoom;
        apply(c, true);
      };
      img.src = d.src;
    }
  }

  /** Optional drop-in defaults configured in assets/faces/faces.js (window.AWF_FACES). */
  function loadAssetFaces() {
    const cfg = window.AWF_FACES || {};
    for (const who of ['hero', 'challenger']) {
      if (!cfg[who]) continue;
      const img = new Image();
      img.onload = () => {
        const c = cards[who];
        if (c.img) return;                       // a face saved by the player wins
        c.img = img; c.fromAsset = true;
        apply(c, true);
      };
      img.onerror = () => console.warn(`Always Win Fighter: could not load the face image "${cfg[who]}" for ${who}.`);
      img.src = cfg[who];
    }
  }

  function open(from) {
    returnTo = from;
    for (const who in cards) drawPreview(cards[who]);
    Screens.show('screen-customize');
  }
  function close() { Screens.show(returnTo === 'victory' ? 'screen-victory' : 'screen-start'); }

  function init(g) {
    game = g;
    document.querySelectorAll('.face-card').forEach((el) => { cards[el.dataset.who] = makeCard(el); });
    $('btn-customize').addEventListener('click', () => { Sound.unlock(); Sound.play('ui'); open('start'); });
    $('btn-victory-customize').addEventListener('click', () => { Sound.play('ui'); open('victory'); });
    $('btn-customize-back').addEventListener('click', () => { Sound.play('ui'); close(); });
    $('btn-customize-fight').addEventListener('click', () => {
      Sound.unlock(); Sound.play('ui');
      if (game.mode === 'match_end') game.startMatch(); else game.startIntro();
    });
    load();
    loadAssetFaces();
    for (const who in cards) drawPreview(cards[who]);
  }

  return { init, open };
})();
// CUSTOM-FACES:END

/* ==========================================================================
   11. BOOT
   ========================================================================== */
function fitStage(game) {
  const stage = $('stage');
  const vw = window.innerWidth, vh = window.innerHeight;
  let w = vw, h = vw * 9 / 16;
  if (h > vh) { h = vh; w = h * 16 / 9; }
  w = Math.floor(w); h = Math.floor(h);
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  stage.style.setProperty('--unit', (w / 100) + 'px');   // 1em = 1% of the stage width (see style.css)
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  game.canvas.width = Math.round(w * dpr);
  game.canvas.height = Math.round(h * dpr);
  game.scale = game.canvas.width / W;
}

function boot() {
  FaceStore.init();
  Sprites.init();
  const game = new Game($('game'));
  Screens.init(game);
  Input.bindTouch($('touch-controls'));
  Input.onPress(() => Sound.unlock());                   // audio can only start after a user gesture
  window.addEventListener('pointerdown', () => Sound.unlock());
  const refit = () => { fitStage(game); Screens.fitTitles(); };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  refit();
  // CUSTOM-FACES:START
  FaceCustomizer.init(game);
  // CUSTOM-FACES:END
  game.start();
  const m = /[?&]dance(?:=([a-z]+))?/.exec(location.search);     // ?dance or ?dance=wiggle
  if (m) { if (m[1] && DANCES[m[1]]) Screens.setDance(m[1]); game.startDancePreview(); }
  window.AWF = game;                                      // handy for poking at the game from the console
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
