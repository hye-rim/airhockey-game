'use strict';
// 오락실 튜토리얼이 '진짜로 일어난 일'을 알아채는 신호 (arcade/public/tutorial.js 가 듣는다. 튜토리얼이 아니면 아무도 안 듣는다)
const tutorialSignal = (type) => window.dispatchEvent(new CustomEvent('arcade:tutorial', { detail: { type } }));

// 에어하키: 화면·입력·소리·온라인. 규칙·물리·컴퓨터는 logic.js (LOGIC_HOCKEY), 방·매칭·실제 계산은 server.js
(() => {
const L = LOGIC_HOCKEY;
const { W, H } = L;
const $ = (id) => document.getElementById(id);
const COLORS = ['#ff5a4f', '#3d8bff'];
const CPU_MATCH = 180;                                      // 컴퓨터 대전 제한 시간(초)
const T = { over: 1100 };                                   // 시간(ms). 시험용으로 줄일 수 있다

// ---------- 저장소 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
let wins = Number(store.get('airhockeyWins')) || 0;
const ONLINE_KEY = 'airhockeyOnline', SESSION_KEY = 'airhockeySession';
const loadJson = (k) => { try { return JSON.parse(store.get(k)) || {}; } catch (_) { return {}; } };
function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) { return null; } }
function saveSession(s) { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const myName = () => store.get('airhockeyName') || '';

// ---------- 소리 ----------
let audio = null;
let muted = store.get('airhockeyMuted') === '1';
function tone(freq, dur, type = 'sine', vol = 0.09, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur);
  } catch (_) {}
}
const seq = (notes, step, type = 'triangle', vol = 0.09) => notes.forEach((f, i) => setTimeout(() => tone(f, step * 0.0009, type, vol), i * step));
let lastHitSound = 0;
const sfx = {
  hit: (speed) => { const n = performance.now(); if (n - lastHitSound < 60) return; lastHitSound = n; tone(300 + Math.min(500, speed * 0.4), 0.06, 'triangle', 0.1); },
  wall: (speed) => { const n = performance.now(); if (n - lastHitSound < 60) return; lastHitSound = n; tone(200 + Math.min(150, speed * 0.1), 0.04, 'square', 0.04); },
  goal: () => seq([523, 659, 784], 90, 'triangle', 0.1),
  conceded: () => seq([330, 262, 196], 120, 'sawtooth', 0.06),
  serve: () => tone(700, 0.06, 'triangle', 0.06),
  found: () => seq([392, 523], 90, 'triangle', 0.08),
  win: () => seq([523, 659, 784, 1047], 110, 'triangle', 0.1),
  lose: () => seq([392, 330, 262, 196], 150, 'sawtooth', 0.06),
};
function toggleMute() { muted = !muted; store.set('airhockeyMuted', muted ? '1' : '0'); $('muteBtn').textContent = muted ? '🔇' : '🔊'; }
$('muteBtn').onclick = (e) => { e.currentTarget.blur(); toggleMute(); };
$('muteBtn').textContent = muted ? '🔇' : '🔊';

// ---------- 상태 ----------
let mode = 'easy';                  // 'easy' · 'hard' (컴퓨터) · 'online'
let phase = 'title';                // title · play · over
let sim = null;                     // 화면이 그릴 판. 컴퓨터 대전: 진짜 판 / 온라인: 서버 위치를 따라가는 예측 판
let ai = null;
let me = 0;                         // 내 편 (0 아래 · 1 위쪽). 화면에서는 늘 내가 아래에 오게 뒤집어 그린다
let room = null, netDown = false, recorded = '';
let score = [0, 0], endAt = 0, banner = '', bannerUntil = 0, goalFlash = 0;
let overTimer = 0, lastFrame = 0, moved = false;
const online = () => mode === 'online';

// ---------- 그리기 ----------
const canvas = $('table'), ctx = canvas.getContext('2d');
let cw = 0, chh = 0, dpr = 1;
function fit() {
  const r = canvas.getBoundingClientRect();
  dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
  cw = w; chh = h;
}
const flipped = () => me === 1;
function draw() {
  fit();
  const k = cw / W;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, chh);
  // 판 (내가 1 번 편이면 180도 돌려 그린다)
  ctx.save();
  if (flipped()) { ctx.translate(cw, chh); ctx.rotate(Math.PI); }
  ctx.scale(k, k);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#c9efff'); bg.addColorStop(1, '#a9defa');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(43,29,82,.35)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 44, 0, Math.PI * 2); ctx.stroke();
  for (const y of [0, H]) { ctx.beginPath(); ctx.arc(W / 2, y, L.GOAL_W / 2 + 14, y ? Math.PI : 0, y ? Math.PI * 2 : Math.PI); ctx.stroke(); }
  // 골대 (양 끝 가운데 구멍). 방금 골이 들어갔으면 번쩍
  const flash = goalFlash > performance.now();
  for (const y of [0, H]) {
    ctx.fillStyle = flash ? '#ffd23f' : '#2b1d52';
    ctx.fillRect(W / 2 - L.GOAL_W / 2, y ? H - 8 : 0, L.GOAL_W, 8);
  }
  if (sim) {
    const p = sim.puck;
    // 퍽
    ctx.fillStyle = 'rgba(43,29,82,.2)'; ctx.beginPath(); ctx.arc(p.x + 2, p.y + 4, L.PUCK_R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2b1d52'; ctx.beginPath(); ctx.arc(p.x, p.y, L.PUCK_R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, L.PUCK_R - 5, 0, Math.PI * 2); ctx.stroke();
    // 패들
    for (let w = 0; w < 2; w++) {
      const q = sim.pad[w];
      ctx.fillStyle = 'rgba(43,29,82,.2)'; ctx.beginPath(); ctx.arc(q.x + 2, q.y + 5, L.PAD_R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS[w === me ? 0 : 1]; ctx.strokeStyle = '#2b1d52'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(q.x, q.y, L.PAD_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(q.x - 6, q.y - 6, L.PAD_R * 0.35, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.2)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(q.x, q.y, L.PAD_R * 0.55, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.restore();
  // 글자는 돌리지 않는다
  if (sim && phase === 'play') {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (banner && bannerUntil > performance.now()) text(banner, cw / 2, chh / 2, 34 * dpr);
    else if (sim.serve.wait > 0) { const n = Math.ceil(sim.serve.wait / 0.45); text(n > 1 ? String(Math.min(3, n)) : '시작!', cw / 2, chh / 2, 40 * dpr); }
  }
}
function text(s, x, y, size) {
  ctx.font = `${size}px Jua, sans-serif`;
  ctx.lineWidth = size * 0.2; ctx.strokeStyle = '#2b1d52'; ctx.lineJoin = 'round';
  ctx.strokeText(s, x, y); ctx.fillStyle = '#ffd23f'; ctx.fillText(s, x, y);
}

const nameOf = (side) => {
  if (!online()) return side === 0 ? '나' : '컴퓨터';
  if (!room) return side === me ? '나' : '상대';
  return side === me ? '나' : ((room.players.find((p) => p.color === side) || {}).name || '상대');
};
function renderBars() {
  const bar = (el, side) => {
    el.className = 'bar';
    el.innerHTML = `<span class="dot" style="--c:${COLORS[side === me ? 0 : 1]}"></span><span class="nm">${esc(nameOf(side))}</span><span class="sc">${score[side]}</span>`;
  };
  bar($('barOp'), 1 - me); bar($('barMe'), me);
}
function remainSec() {
  if (online()) return Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
  return sim ? Math.max(0, Math.ceil(CPU_MATCH - sim.time)) : CPU_MATCH;
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function renderHud() {
  $('wins').textContent = wins.toLocaleString('ko-KR');
  let t = '에어하키';
  if (phase === 'play') t = online() && netDown ? '연결 다시 붙이는 중…' : `${score[me]} : ${score[1 - me]} · ${fmt(remainSec())}`;
  $('turn').textContent = t;
  $('resignBtn').style.display = online() && room && room.state === 'playing' ? '' : 'none';
}
function say(t) { $('msg').textContent = t; }

// ---------- 창 ----------
const overlayOpen = () => !$('overlay').classList.contains('hidden');
function showOverlay(html) { $('overlay').innerHTML = html; $('overlay').classList.remove('hidden'); }
function hideOverlay() { $('overlay').classList.add('hidden'); }

// ---------- 내 패들 조작 ----------
let lastSent = 0, pending = null;
function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width * W, y = (e.clientY - r.top) / r.height * H;
  if (e.pointerType === 'touch') y -= 38 * (flipped() ? -1 : 1);       // 손가락에 가려지지 않게 패들을 손가락 조금 위에 둔다
  if (flipped()) { x = W - x; y = H - y; }
  return { x, y };
}
function aim(x, y) {
  if (!sim || phase !== 'play' || (online() && netDown)) return;
  L.setTarget(sim, me, x, y);
  if (!moved) { moved = true; tutorialSignal('move'); }
  if (online()) pending = { x: Math.round(x), y: Math.round(y) };
}
let dragging = false;
canvas.addEventListener('pointerdown', (e) => { dragging = true; try { canvas.setPointerCapture(e.pointerId); } catch (_) {} const p = toWorld(e); aim(p.x, p.y); e.preventDefault(); });
canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch' && !dragging) return; const p = toWorld(e); aim(p.x, p.y); });
const endDrag = () => { dragging = false; };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
function flushPad(now) {
  if (!pending || now - lastSent < 33) return;
  lastSent = now;
  net.send('pad', pending); pending = null;
}

// ---------- 매 프레임 ----------
// 컴퓨터 대전은 여기서 진짜로 계산하고, 온라인은 서버가 보낸 위치를 따라가며 사이를 같은 물리로 메운다
function frame(dt) {
  if (!sim) return;
  if (phase === 'play') {
    const n = Math.round(Math.min(dt, 0.05) / L.DT);
    for (let i = 0; i < n; i++) {
      if (!online()) L.aiStep(sim, 1, ai);
      L.step(sim);
      if (online()) { sim.score[0] = sim.score[1] = 0; sim.winner = -1; }
    }
    handleEvents();
    if (!online()) {
      score = sim.score.slice();
      if (sim.winner >= 0) finishCpu(sim.winner);
      else if (sim.time >= CPU_MATCH) { L.finishByTime(sim); finishCpu(sim.winner); }
    }
  } else sim.events.length = 0;
  renderBars(); renderHud(); draw();
}
function handleEvents() {
  if (online()) { sim.events.length = 0; return; }       // 온라인의 소리·알림은 서버 알림으로
  for (const e of sim.events) onEvent(e.type, e);
  sim.events.length = 0;
}
function onEvent(type, e) {
  if (type === 'hit') { sfx.hit(e.speed); if (e.who === me) tutorialSignal('hit'); }
  else if (type === 'wall') sfx.wall(e.speed);
  else if (type === 'serve') sfx.serve();
  else if (type === 'goal') {
    goalFlash = performance.now() + 500;
    const mine = e.who === me;
    banner = mine ? '골! ⚽' : '실점…'; bannerUntil = performance.now() + 1100;
    mine ? sfx.goal() : sfx.conceded();
    if (mine) tutorialSignal('goal');
  }
}
let raf = 0;
function loop(now) {
  raf = requestAnimationFrame(loop);
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  frame(dt);
  if (online()) flushPad(now);
}

// ---------- 컴퓨터 대전 ----------
function startCpu(level) {
  leaveOnline();
  clearTimeout(overTimer);
  mode = level; me = 0; phase = 'play'; moved = false; ai = L.makeAi(level === 'hard' ? 'hard' : 'easy');
  sim = L.newGame({ first: Math.random() < 0.5 ? 0 : 1 });
  score = [0, 0]; banner = ''; hideOverlay();
  say('마우스(손가락)를 움직여 퍽을 쳐서 상대 골대에 넣어요!\n먼저 7골을 넣으면 이겨요');
}
function finishCpu(winner) {
  if (phase !== 'play') return;
  phase = 'over';
  score = sim.score.slice();
  overTimer = setTimeout(showOver, T.over);
}
function showOver() {
  const w = sim.winner;
  const youWon = w === 0, draw = w === 2;
  if (youWon) { wins++; store.set('airhockeyWins', String(wins)); sfx.win(); } else if (draw) sfx.found(); else sfx.lose();
  const why = sim.score[0] >= sim.goalLimit || sim.score[1] >= sim.goalLimit ? (youWon ? `${sim.goalLimit}골을 먼저 넣었어요!` : `컴퓨터가 ${sim.goalLimit}골을 먼저 넣었어요`) : '시간이 끝났어요';
  showOverlay(`
    <h2>${draw ? '무승부! 🤝' : youWon ? '이겼어요! 🎉' : '아쉬워요! 😵'}</h2>
    <p>${esc(why)}</p>
    <div class="big">${sim.score[0]} : ${sim.score[1]}</div>
    <p>컴퓨터 상대 승리 <b>${wins}</b>번</p>
    <div class="col"><button data-act="again">다시 하기</button><button class="sub" data-act="home">처음으로</button></div>`);
}
function showTitle() {
  leaveOnline();
  clearTimeout(overTimer);
  mode = 'easy'; phase = 'title'; me = 0; sim = L.newGame(); sim.serve.wait = 99; score = [0, 0]; say('');
  const on = loadJson(ONLINE_KEY);
  showOverlay(`
    <h1>에어하키</h1>
    <p>퍽을 쳐서 <b>상대 골대</b>에 넣으면 1점!</p>
    <div class="card2" style="font-size:13px">내 패들(<b>빨강</b>)을 손가락·마우스로 움직여요<br>패들은 <b>내 쪽 절반</b>에서만 움직여요<br>먼저 <b>7골</b>을 넣으면 이겨요 (시간이 끝나면 점수가 높은 쪽)</div>
    <div class="col"><button data-act="cpu" data-lv="easy">🤖 컴퓨터랑 · 쉬움</button><button class="sub" data-act="cpu" data-lv="hard">🤖 컴퓨터랑 · 어려움</button><button class="sub" data-act="online">🌐 온라인 대전${on.w || on.l ? ` · ${on.w || 0}승 ${on.l || 0}패` : ''}</button></div>`);
}

// ---------- 온라인: 연결 ----------
const net = {
  ws: null, pulse: null, outbox: [], retry: 0,
  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${location.pathname}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw('hello', { name: myName() });
      const s = loadSession();
      if (s) this.raw('resume', s);
      for (const [t, p] of this.outbox.splice(0)) this.raw(t, p);
      clearInterval(this.pulse);
      this.pulse = setInterval(() => this.raw('pulse'), 10000);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onNet(m); };
    ws.onclose = () => {
      clearInterval(this.pulse);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!online()) return;
      if (room || loadSession()) {
        netDown = true;
        setTimeout(() => { if (online()) this.connect(); }, Math.min(4000, 500 * 2 ** this.retry++));
      } else showOnline('서버와 연결이 끊겼어요. 다시 시도해 주세요.');
    };
  },
  send(t, p = {}) {
    if (this.ws && this.ws.readyState === 1) this.raw(t, p);
    else if (t !== 'pad') { this.outbox.push([t, p]); this.connect(); }
  },
  raw(t, p = {}) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, ...p })); },
  close() {
    const ws = this.ws;
    this.ws = null; this.outbox = [];
    clearInterval(this.pulse);
    if (ws) ws.close();
  },
};

function onNet(m) {
  if (m.t === 'queued') showQueued();
  else if (m.t === 'room') applyRoom(m);
  else if (m.t === 's') applyFrame(m);
  else if (m.t === 'ev') { if (phase === 'play') onEvent(m.e, { who: m.who, speed: m.speed }); if (m.e === 'goal') score = m.score.slice(); }
  else if (m.t === 'error') { room = null; saveSession(null); showOnline(m.msg); }
  else if (m.t === 'resumeFailed') {
    saveSession(null);
    if (room) { room = null; showOnline('대국이 끝나서 이어갈 수 없어요.'); }
    netDown = false;
  }
}

function leaveOnline() {
  if (!online()) return;
  net.send('leave'); net.close();
  saveSession(null);
  room = null; netDown = false; mode = 'easy'; phase = 'title';
}

// ---------- 온라인: 대국 ----------
// 서버 위치를 받으면 내가 그리는 판을 거기에 맞춘다 (조금 어긋난 건 서서히, 크게 어긋나면 바로)
function applyFrame(m) {
  if (!sim || !online() || phase !== 'play') return;
  const p = sim.puck, e = Math.hypot(m.puck[0] - p.x, m.puck[1] - p.y);
  if (e > 40) { p.x = m.puck[0]; p.y = m.puck[1]; } else { p.x += (m.puck[0] - p.x) * 0.5; p.y += (m.puck[1] - p.y) * 0.5; }
  p.vx = m.puck[2]; p.vy = m.puck[3];
  const opp = 1 - me;
  sim.pad[opp].x = m.pads[opp][0]; sim.pad[opp].y = m.pads[opp][1];
  sim.target[opp] = { x: m.pads[opp][0], y: m.pads[opp][1] };
  const mine = m.pads[me];
  if (Math.hypot(mine[0] - sim.pad[me].x, mine[1] - sim.pad[me].y) > 90) { sim.pad[me].x = mine[0]; sim.pad[me].y = mine[1]; }
  sim.serve = m.serve ? { to: m.serve.to, wait: m.serve.wait } : { to: sim.serve.to, wait: 0 };
  score = m.score.slice();
  endAt = performance.now() + m.remain;
}
function applyRoom(r) {
  const fresh = !room || room.code !== r.code;
  const newGame = fresh || room.games !== r.games;
  room = r; me = r.you;
  netDown = false;
  saveSession({ code: r.code, token: r.token });
  score = r.score.slice();
  endAt = performance.now() + r.remain;
  if (newGame || !sim) {
    sim = L.newGame({ goalLimit: 99 }); moved = false; banner = ''; say('');
  }
  if (r.state === 'waiting') { phase = 'title'; showWaiting(); return; }
  phase = r.state === 'playing' ? 'play' : 'over';
  // 서버 위치를 한 번 맞춘다
  const sp = r.puck;
  sim.puck.x = sp[0]; sim.puck.y = sp[1]; sim.puck.vx = sp[2]; sim.puck.vy = sp[3];
  for (let w = 0; w < 2; w++) { sim.pad[w].x = r.pads[w][0]; sim.pad[w].y = r.pads[w][1]; if (w !== me) sim.target[w] = { x: r.pads[w][0], y: r.pads[w][1] }; }
  sim.serve = r.serve ? { to: r.serve.to, wait: r.serve.wait } : { to: 0, wait: 0 };
  if (newGame && r.state === 'playing') { sfx.found(); say('마우스(손가락)로 패들을 움직여 퍽을 쳐요!\n먼저 ' + r.goalLimit + '골을 넣으면 이겨요'); L.setTarget(sim, me, sim.pad[me].x, sim.pad[me].y); }
  if (r.state !== 'over') hideOverlay();
  if (r.state === 'over') afterOver();
}
function afterOver() {
  const r = room;
  const key = `${r.code}:${r.games}:${r.reason}:${r.winner}`;
  if (recorded !== key) {
    recorded = key;
    const rec = loadJson(ONLINE_KEY);
    if (r.winner === r.you) { rec.w = (rec.w || 0) + 1; sfx.win(); } else if (r.winner === 2) { rec.d = (rec.d || 0) + 1; sfx.found(); } else { rec.l = (rec.l || 0) + 1; sfx.lose(); }
    store.set(ONLINE_KEY, JSON.stringify(rec));
    setTimeout(() => { if (room && room.state === 'over') showResult(); }, T.over);
  } else if (overlayOpen()) showResult();
}

function showResult() {
  const r = room;
  const draw = r.winner === 2, won = r.winner === r.you;
  const why = {
    goals: won ? `${r.goalLimit}골을 먼저 넣었어요!` : `상대가 ${r.goalLimit}골을 먼저 넣었어요`,
    time: draw ? '시간이 끝났는데 점수가 같아요' : won ? '시간이 끝났고 내가 더 많이 넣었어요' : '시간이 끝났고 상대가 더 많이 넣었어요',
    resign: won ? '상대가 기권했어요' : '기권했어요',
    left: won ? '상대가 나갔어요' : '연결이 끊겨 패배했어요',
  }[r.reason] || '';
  const rec = loadJson(ONLINE_KEY);
  const opp = r.players.find((p) => p.color !== r.you);
  const iVoted = r.rematch.includes(r.you), theyVoted = opp && r.rematch.includes(opp.color);
  let again;
  if (!opp) again = '<p>상대가 방을 나갔어요</p>';
  else if (iVoted) again = '<p>상대를 기다리는 중…</p>';
  else again = `${theyVoted ? '<p>상대가 한 판 더 하고 싶어해요!</p>' : ''}<button data-act="rematch">한 판 더</button>`;
  showOverlay(`
    <h2>${draw ? '🤝 무승부' : won ? '🎉 승리!' : '😵 패배'}</h2>
    ${why ? `<p>${why}</p>` : ''}
    <div class="big">${r.score[r.you]} : ${r.score[1 - r.you]}</div>
    <span class="tag">온라인 ${rec.w || 0}승 ${rec.l || 0}패${rec.d ? ` ${rec.d}무` : ''}</span>
    <div class="col">${again}
      <div class="row"><button class="sub" data-act="view">판 보기</button><button class="sub" data-act="leave">나가기</button></div>
    </div>`);
}

function showOnline(error = '') {
  leaveOnline();
  clearTimeout(overTimer);
  mode = 'online'; phase = 'title'; room = null; me = 0; sim = L.newGame(); sim.serve.wait = 99; score = [0, 0]; say('');
  showOverlay(`
    <h2>🌐 온라인 대전</h2>
    <input id="nameInput" maxlength="10" placeholder="내 이름 (최대 10자)" value="${esc(myName())}" autocomplete="off">
    <div class="col">
      <button data-act="quick">⚡ 빠른 대전</button>
      <button class="sub" data-act="create">방 만들기</button>
      <div class="row join"><input id="codeInput" maxlength="4" placeholder="방 코드" autocomplete="off" autocapitalize="characters"><button class="sub" data-act="join">들어가기</button></div>
    </div>
    <span class="error">${esc(error)}</span>
    <button class="back" data-act="home">← 처음으로</button>
    <p style="font-size:12.5px">먼저 7골 · 5분 · 아래/위쪽 자리는 한 판마다 바뀌어요</p>`);
}
function showQueued() {
  showOverlay(`
    <h2>상대를 찾는 중…</h2>
    <div class="dots"><span></span><span></span><span></span></div>
    <p>누군가 빠른 대전을 누르면 바로 시작해요</p>
    <button class="sub" data-act="cancel">취소</button>`);
}
const inviteUrl = () => `${location.origin}${location.pathname}?room=${room.code}`;
function showWaiting() {
  showOverlay(`
    <h2>친구를 기다리는 중…</h2>
    <p>방 코드</p>
    <div class="code">${esc(room.code)}</div>
    <p>친구가 <b>온라인 대전 → 들어가기</b>에<br>이 코드를 넣으면 시작해요</p>
    <button data-act="copy">🔗 초대 링크 복사</button>
    <button class="sub" data-act="cancel">취소</button>`);
}
function saveName() {
  const input = $('nameInput');
  if (!input) return;
  const name = input.value.trim().slice(0, 10);
  store.set('airhockeyName', name);
  net.send('hello', { name });
}
function confirmResign() {
  showOverlay(`<h2>기권할까요?</h2><p>이번 판은 패배로 기록돼요</p>
    <div class="row"><button data-act="close">계속하기</button><button class="sub" data-act="resign">🏳 기권</button></div>`);
  $('overlay').dataset.screen = 'confirm';
}

let lastCpu = 'easy';
$('overlay').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  btn.blur();
  $('overlay').dataset.screen = '';
  const act = btn.dataset.act;
  if (act === 'cpu') { lastCpu = btn.dataset.lv; startCpu(lastCpu); }
  else if (act === 'again') startCpu(lastCpu);
  else if (act === 'home') showTitle();
  else if (act === 'online') showOnline();
  else if (act === 'quick') { saveName(); net.send('quick'); }
  else if (act === 'create') { saveName(); net.send('create'); }
  else if (act === 'join') {
    const code = ($('codeInput').value || '').trim().toUpperCase();
    if (code.length !== 4) { $('overlay').querySelector('.error').textContent = '방 코드 4자리를 넣어 주세요.'; return; }
    saveName();
    net.send('join', { code });
  } else if (act === 'cancel') { net.send('cancel'); showOnline(); }
  else if (act === 'copy') {
    const url = inviteUrl();
    const done = () => { btn.textContent = '✅ 복사했어요'; setTimeout(() => { btn.textContent = '🔗 초대 링크 복사'; }, 1500); };
    if (navigator.share && matchMedia('(pointer: coarse)').matches) navigator.share({ title: '에어하키 한 판 해요!', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('링크를 복사하세요', url));
    else prompt('링크를 복사하세요', url);
  } else if (act === 'rematch') { net.send('rematch'); }
  else if (act === 'view') hideOverlay();
  else if (act === 'leave') showOnline();
  else if (act === 'resign') { net.send('resign'); hideOverlay(); }
  else if (act === 'close') hideOverlay();
});
$('overlay').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'codeInput') $('overlay').querySelector('[data-act="join"]').click();
  if (e.target.id === 'nameInput') $('overlay').querySelector('[data-act="quick"]').click();
  e.stopPropagation();
});
$('resignBtn').onclick = (e) => { e.currentTarget.blur(); if (online() && room && room.state === 'playing') confirmResign(); };
addEventListener('keydown', (e) => { if (e.target.tagName !== 'INPUT' && e.code === 'KeyM') toggleMute(); });
addEventListener('resize', draw);

// ---------- 시작 ----------
const invite = new URLSearchParams(location.search).get('room');
if (invite) { try { window.history.replaceState(null, '', location.pathname); } catch (_) {} }
function joinInvite(code) { showOnline(); net.send('join', { code: code.toUpperCase() }); }
if (loadSession()) {
  mode = 'online';
  sim = L.newGame({ goalLimit: 99 });
  showOverlay('<h2>대국으로 돌아가는 중…</h2>');
  net.connect();
  const until = setInterval(() => {
    if (room || !loadSession()) { clearInterval(until); if (!room) invite ? joinInvite(invite) : showOnline(); }
  }, 100);
} else if (invite) joinInvite(invite);
else showTitle();
raf = requestAnimationFrame(loop);

/* @test-hooks:start */
window.__ah = { get sim() { return sim; }, get mode() { return mode; }, get phase() { return phase; }, get room() { return room; }, get score() { return score; }, get me() { return me; }, T, flushPad, frame, startCpu, aim, draw, applyFrame };
/* @test-hooks:end */
})();
