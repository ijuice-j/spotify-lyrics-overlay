/* Lyric overlay — runtime.
 *
 * Python pushes discrete state (track, lyrics, a position sync every poll).
 * This layer runs its own clock between syncs, so the highlight moves at true
 * frame rate rather than stepping a few times a second.
 *
 * Two designs render the same state:
 *
 *   Focus  five slots -- two lines either side of the sung one, blurred by
 *          distance. A line change rebuilds the slots and replays a short
 *          "rack focus" animation.
 *   Tape   every line laid end to end on one strip. Each word's measured x
 *          position is pinned to its start and end time, and the strip is
 *          translated so the playhead sits at the current time. Between those
 *          knots it moves linearly, so pauses and breaks show up as distance.
 *
 * The sweep is *scrubbed*, not animated: its position is derived from the
 * playhead every frame, so seeking, pausing and drift correct themselves.
 */

'use strict';

const el = {
  card: document.getElementById('card'),
  stack: document.getElementById('stack'),
  active: document.getElementById('active'),
  slots: {
    '-2': document.querySelector('[data-slot="-2"]'),
    '-1': document.querySelector('[data-slot="-1"]'),
    '1': document.querySelector('[data-slot="1"]'),
    '2': document.querySelector('[data-slot="2"]'),
  },
  progressFill: document.getElementById('progressFill'),
  viewport: document.getElementById('viewport'),
  track: document.getElementById('track'),
  tapeMessage: document.getElementById('tapeMessage'),
  covers: document.querySelectorAll('.cover'),
  binds: {
    title: document.querySelectorAll('[data-bind="title"]'),
    artist: document.querySelectorAll('[data-bind="artist"]'),
    time: document.querySelectorAll('[data-bind="time"]'),
  },
};

const state = {
  design: 'focus',
  // idle | loading | ready | unsynced | nolyrics
  status: 'idle',
  title: '',
  artist: '',
  lines: [],
  durationMs: 0,

  // Playhead, kept as an anchor plus a local clock reading.
  anchorMs: 0,
  anchorAt: performance.now(),
  playing: false,

  textScale: 1.0,
  lastClock: '',

  focus: {
    index: null,  // line shown in the active slot; null forces a rebuild
    words: [],    // [{ span, s, e, p, live }]
  },

  tape: {
    items: [],    // timed tokens in time order: [{ span, s, e, p }]
    knots: [],    // [[ms, x], ...] ascending in ms
    cursor: -1,   // index of the item currently being sung
    built: false,
  },
};

/* ------------------------------------------------------------------ bridge */

function send(message) {
  // Picked up by BridgePage.javaScriptConsoleMessage on the Python side.
  console.log('LYRICBRIDGE' + JSON.stringify(message));
}

/* ---------------------------------------------------------------- helpers */

function positionMs() {
  if (!state.playing) return state.anchorMs;
  return state.anchorMs + (performance.now() - state.anchorAt);
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function progress(ms, s, e) {
  if (e <= s) return ms >= s ? 1 : 0;
  const p = (ms - s) / (e - s);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

function setText(nodes, text) {
  nodes.forEach((node) => { node.textContent = text; });
}

/** Index of the line containing `ms`, or -1 before the first line. */
function findLineIndex(ms) {
  const lines = state.lines;
  if (!lines.length || ms < lines[0].start) return -1;
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].start <= ms) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Three beats spread across a gap, so a break still visibly progresses. */
function beats(start, end) {
  const span = (end - start) / 3;
  return [0, 1, 2].map((k) => ({
    t: k < 2 ? '•  ' : '•',
    s: start + k * span,
    e: start + k * span + span * 0.8,
  }));
}

/** The timed words to sweep for line `index` (-1 is the lead-in). */
function wordsFor(index) {
  const lines = state.lines;
  if (index < 0) return lines.length ? beats(0, lines[0].start) : [];
  const line = lines[index];
  if (line.instrumental) return beats(line.start, line.end);
  return line.words.map((w, k) => ({
    t: k < line.words.length - 1 ? w.t + ' ' : w.t,
    s: w.s,
    e: w.e,
  }));
}

function lineLabel(index) {
  const line = state.lines[index];
  if (!line) return '';
  return line.instrumental ? '• • •' : line.text;
}

function setStatus(status) {
  state.status = status;
  el.card.dataset.state = status;
  state.focus.index = null;
  state.tape.built = false;
}

/* --------------------------------------------------------------- focus --- */

function showFocusMessage(kind, text) {
  el.active.dataset.kind = kind;
  el.active.textContent = text;
  Object.values(el.slots).forEach((slot) => { slot.textContent = ''; });
  state.focus.words = [];
}

function buildFocus(index) {
  const focus = state.focus;
  const previous = focus.index;
  focus.index = index;

  if (state.status === 'idle') return showFocusMessage('message', 'Waiting for Spotify');
  if (state.status === 'loading') return showFocusMessage('loading', '• • •');
  if (state.status === 'nolyrics') return showFocusMessage('message', 'No lyrics for this one');

  if (state.status === 'unsynced') {
    // No timing to follow: show the opening lines, bright and still.
    showFocusMessage('static', state.lines[0] ? state.lines[0].text : '');
    el.slots['1'].textContent = lineLabel(1);
    el.slots['2'].textContent = lineLabel(2);
    return;
  }

  el.slots['-2'].textContent = lineLabel(index - 2);
  el.slots['-1'].textContent = lineLabel(index - 1);
  el.slots['1'].textContent = lineLabel(index + 1);
  el.slots['2'].textContent = lineLabel(index + 2);

  el.active.dataset.kind = 'lyric';
  const frag = document.createDocumentFragment();
  focus.words = wordsFor(index).map((w) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = w.t;
    span.style.setProperty('--p', '0');
    frag.appendChild(span);
    return { span, s: w.s, e: w.e, p: 0, live: false };
  });
  el.active.replaceChildren(frag);

  // Replay the rack-focus only for a real line change, not a first paint.
  if (previous !== null && previous !== index) {
    el.stack.classList.remove('is-rolling');
    void el.stack.offsetWidth;  // restart the animation
    el.stack.classList.add('is-rolling');
  }
}

function tickFocus(ms) {
  const index = state.status === 'ready' ? findLineIndex(ms) : -1;
  if (state.focus.index === null || (state.status === 'ready' && index !== state.focus.index)) {
    buildFocus(index);
  }

  for (const w of state.focus.words) {
    const p = progress(ms, w.s, w.e);
    // Skip sub-perceptual updates; each write invalidates a paint.
    if (Math.abs(p - w.p) > 0.004 || (p !== w.p && (p === 0 || p === 1))) {
      w.span.style.setProperty('--p', p.toFixed(3));
      w.p = p;
    }
    const live = p > 0 && p < 1;
    if (live !== w.live) {
      if (live) w.span.dataset.live = '1';
      else w.span.removeAttribute('data-live');
      w.live = live;
    }
  }
}

/* ---------------------------------------------------------------- tape --- */

function tapeToken(text, className) {
  const span = document.createElement('span');
  span.className = 'tk' + (className ? ' ' + className : '');
  span.textContent = text;
  return span;
}

function buildTape() {
  const tape = state.tape;
  tape.built = true;
  tape.items = [];
  tape.knots = [];
  tape.cursor = -1;
  el.track.replaceChildren();
  el.track.style.transform = 'none';

  const messages = {
    idle: 'Waiting for Spotify',
    loading: 'Finding lyrics…',
    nolyrics: 'No lyrics for this one',
    unsynced: 'Lyrics found, but not time-synced',
  };
  el.tapeMessage.textContent = messages[state.status] || '';
  if (state.status !== 'ready') return;

  // Title first: at the start of a track it sits behind the playhead, in the
  // stretch of tape that has "already played".
  const frag = document.createDocumentFragment();
  frag.appendChild(tapeToken([state.title, state.artist].filter(Boolean).join(' · '), 'tk--meta'));

  const pending = [];
  state.lines.forEach((line) => {
    frag.appendChild(tapeToken('   /   ', 'tk--sep'));
    if (line.instrumental) {
      const span = tapeToken('~ ~ ~  instrumental  ~ ~ ~', 'tk--break');
      frag.appendChild(span);
      pending.push({ span, s: line.start + 200, e: Math.max(line.start + 200, line.end - 300) });
      return;
    }
    line.words.forEach((w, k) => {
      const span = tapeToken(w.t);
      frag.appendChild(span);
      pending.push({ span, s: w.s, e: w.e });
      if (k < line.words.length - 1) frag.appendChild(document.createTextNode(' '));
    });
  });
  frag.appendChild(tapeToken('        '));
  el.track.appendChild(frag);

  tape.items = pending.map((item) => ({ ...item, p: -1 }));
  measureTape();
}

/** Pin every timed token's x extent to its time. Re-run after any reflow. */
function measureTape() {
  const tape = state.tape;
  tape.knots = [];
  for (const item of tape.items) {
    const x0 = item.span.offsetLeft;
    tape.knots.push([item.s, x0], [item.e, x0 + item.span.offsetWidth]);
  }
}

function tapeX(ms) {
  const knots = state.tape.knots;
  if (!knots.length) return 0;
  if (ms <= knots[0][0]) return knots[0][1];
  let low = 1;
  let high = knots.length - 1;
  if (ms >= knots[high][0]) return knots[high][1];
  while (low < high) {
    const mid = (low + high) >> 1;
    if (knots[mid][0] < ms) low = mid + 1;
    else high = mid;
  }
  const a = knots[low - 1];
  const b = knots[low];
  const f = b[0] === a[0] ? 1 : (ms - a[0]) / (b[0] - a[0]);
  return a[1] + f * (b[1] - a[1]);
}

/** Mark items lo..hi as sung, live or ahead, relative to the cursor. */
function paintTape(lo, hi, cursor) {
  const items = state.tape.items;
  for (let k = Math.max(0, lo); k <= Math.min(items.length - 1, hi); k++) {
    items[k].span.dataset.s = k < cursor ? 'sung' : k === cursor ? 'live' : 'ahead';
    items[k].p = -1;
  }
}

function tickTape(ms) {
  const tape = state.tape;
  if (!tape.built) buildTape();
  if (state.status !== 'ready' || !tape.items.length) return;

  const playhead = el.viewport.clientWidth * 0.3;
  el.track.style.transform = `translate3d(${(playhead - tapeX(ms)).toFixed(2)}px, 0, 0)`;

  // Cursor: the last item that has started.
  const items = tape.items;
  let low = 0;
  let high = items.length - 1;
  let cursor = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (items[mid].s <= ms) {
      cursor = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (cursor !== tape.cursor) {
    const from = tape.cursor < 0 ? 0 : Math.min(tape.cursor, cursor);
    const to = tape.cursor < 0 ? items.length - 1 : Math.max(tape.cursor, cursor);
    paintTape(from, to, cursor);
    tape.cursor = cursor;
  }

  if (cursor >= 0) {
    const item = items[cursor];
    const p = progress(ms, item.s, item.e);
    if (Math.abs(p - item.p) > 0.004 || (p === 1 && item.p !== 1)) {
      item.span.style.setProperty('--p', p.toFixed(3));
      item.p = p;
    }
  }
}

/* ------------------------------------------------------------- frame loop */

function tick() {
  const ms = positionMs();

  const label = state.durationMs > 0 || state.status === 'ready' ? clock(ms) : '';
  if (label !== state.lastClock) {
    setText(el.binds.time, label);
    state.lastClock = label;
  }

  if (state.durationMs > 0) {
    const ratio = Math.max(0, Math.min(1, ms / state.durationMs));
    el.progressFill.style.width = (ratio * 100).toFixed(3) + '%';
  }

  if (state.design === 'tape') tickTape(ms);
  else tickFocus(ms);

  requestAnimationFrame(tick);
}

/* ---------------------------------------------------------- python → js --- */

window.overlaySetTrack = function (payload) {
  state.title = payload.title || '';
  state.artist = payload.artist || '';
  state.durationMs = payload.durationMs || 0;
  state.lines = [];
  setText(el.binds.title, state.title);
  setText(el.binds.artist, state.artist);
  // Clear immediately: the previous track's lyrics are worse than nothing
  // while the new track's fetch is in flight.
  setStatus('loading');
};

window.overlaySetLyrics = function (payload) {
  state.lines = payload.lines || [];
  if (!state.lines.length) setStatus('nolyrics');
  else if (!payload.synced) setStatus('unsynced');
  else setStatus('ready');
};

window.overlaySync = function (payload) {
  state.anchorMs = payload.positionMs || 0;
  state.anchorAt = performance.now();
  state.playing = !!payload.playing;
};

window.overlaySetTheme = function (payload) {
  const root = document.documentElement.style;
  if (payload.plate) root.setProperty('--plate-tint', payload.plate);
  if (payload.accent) root.setProperty('--accent', payload.accent);
  el.card.dataset.themed = payload.colorful ? '1' : '0';
};

window.overlaySetArt = function (payload) {
  const image = payload && payload.src ? `url("${payload.src}")` : '';
  el.covers.forEach((cover) => { cover.style.backgroundImage = image; });
};

window.overlaySetAppearance = function (payload) {
  const root = document.documentElement.style;
  if (typeof payload.plateCore === 'number') root.setProperty('--plate-core', payload.plateCore.toFixed(3));
  if (typeof payload.plateEdge === 'number') root.setProperty('--plate-edge', payload.plateEdge.toFixed(3));
  if (typeof payload.textScale === 'number') {
    state.textScale = payload.textScale;
    scaleType();
  }
};

window.overlaySetDesign = function (payload) {
  const design = payload.design === 'tape' ? 'tape' : 'focus';
  state.design = design;
  el.card.dataset.design = design;
  state.focus.index = null;
  state.tape.built = false;
  scaleType();
};

window.overlaySetIdle = function () {
  if (state.status === 'idle') return;
  state.title = '';
  state.artist = '';
  state.lines = [];
  state.playing = false;
  state.durationMs = 0;
  setText(el.binds.title, 'Lyric Overlay');
  setText(el.binds.artist, '');
  el.progressFill.style.width = '0%';
  window.overlaySetArt(null);
  setStatus('idle');
};

/* -------------------------------------------------------------- controls -- */

/* The window is frameless, so it has no OS resize border. The outer few pixels
   of the card stand in for one: pointing there switches the cursor and starts a
   resize instead of a move. */
const EDGE = 8;

const CURSORS = {
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  nw: 'nwse-resize', se: 'nwse-resize',
};

function edgeAt(event) {
  const r = el.card.getBoundingClientRect();
  let edge = '';
  if (event.clientY - r.top <= EDGE) edge += 'n';
  else if (r.bottom - event.clientY <= EDGE) edge += 's';
  if (event.clientX - r.left <= EDGE) edge += 'w';
  else if (r.right - event.clientX <= EDGE) edge += 'e';
  return edge;
}

let gesture = null; // 'move' | 'resize' | null

el.card.addEventListener('pointermove', (event) => {
  // While a gesture is running Python owns the window; leave the cursor alone
  // so it does not flicker as the edges move under the pointer.
  if (gesture) return;
  if (event.target.closest('[data-no-drag]')) {
    el.card.style.cursor = '';
    return;
  }
  const edge = edgeAt(event);
  el.card.style.cursor = edge ? CURSORS[edge] : '';
});

el.card.addEventListener('pointerleave', () => {
  if (!gesture) el.card.style.cursor = '';
});

el.card.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (event.target.closest('[data-no-drag]')) return;

  const edge = edgeAt(event);
  if (edge) {
    gesture = 'resize';
    send({ t: 'resizestart', edge: edge });
  } else {
    gesture = 'move';
    send({ t: 'dragstart' });
  }
});

function endGesture() {
  if (!gesture) return;
  send({ t: gesture === 'resize' ? 'resizeend' : 'dragend' });
  gesture = null;
  el.card.style.cursor = '';
}

// Listen on window: the pointer routinely leaves the card mid-gesture, and a
// pointerup missed there would leave the window stuck to the cursor.
window.addEventListener('pointerup', endGesture);
window.addEventListener('blur', endGesture);

document.querySelectorAll('.close').forEach((button) => {
  button.addEventListener('click', () => send({ t: 'close' }));
});

/* Scale the type with the card, so resizing changes how much is shown rather
   than cropping a fixed layout. Focus follows the width; Tape the height. */
function scaleType() {
  const root = document.documentElement.style;
  const width = el.card.clientWidth;
  const height = el.card.clientHeight;

  const lyric = Math.max(16, Math.min(64, width * 0.05 * state.textScale));
  root.setProperty('--lyric-size', lyric.toFixed(1) + 'px');

  root.setProperty('--tape-h', height + 'px');
  const tape = Math.max(12, Math.min(40, height * 0.29 * state.textScale));
  root.setProperty('--tape-size', tape.toFixed(1) + 'px');

  // Tape positions are measured in pixels, so any change in type size moves
  // every knot.
  if (state.tape.built) measureTape();
}

window.addEventListener('resize', scaleType);

/* ----------------------------------------------------------------- start -- */

scaleType();
document.fonts.ready.then(() => {
  // Metrics change once the real fonts arrive.
  if (state.tape.built) measureTape();
});
buildFocus(-1);
requestAnimationFrame(tick);
