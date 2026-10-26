'use strict';

// 에어하키: 규칙·물리·컴퓨터 상대만 모아 둔 파일 (그리기·입력 없음). 브라우저·서버·테스트(Node)가 같이 쓴다.
//
// - 세로로 긴 판 W x H (왼쪽 위가 0,0). 0 번 편(아래쪽)과 1 번 편(위쪽)이 각자 자기 쪽 절반에서 패들을 움직여 퍽을 친다
// - 퍽을 상대 골대(양 끝 가운데 구멍)에 넣으면 1점. 먼저 GOAL_LIMIT 점을 내면 이긴다. 골이 들어가면 점수를 잃은 쪽 앞에서 퍽을 다시 내놓는다
// - 모든 움직임은 고정된 짧은 시간 DT 단위로 계산한다. 같은 입력이면 같은 결과가 나온다(서버와 브라우저가 같은 코드를 쓰는 이유)
// - 패들은 목표 위치(손가락·마우스)를 향해 최고 속도 안에서만 움직이고, 내 쪽 절반 밖으로는 못 나간다
const LOGIC_HOCKEY = (() => {
const W = 300, H = 500, CX = W / 2;
const PUCK_R = 14, PAD_R = 27, GOAL_W = 112;            // 골대 구멍은 가운데 GOAL_W 만큼
const DT = 1 / 120;
const PAD_SPEED = 1000;                                  // 사람 패들의 최고 속도 (칸/초)
const MAX_PUCK = 1250;                                   // 퍽의 최고 속도
const FRICTION = 0.28;                                   // 초당 속도가 줄어드는 정도 (v *= exp(-FRICTION*dt))
const WALL_E = 0.93, PAD_E = 0.92;                       // 벽·패들에 튕길 때 남는 속도 비율
const GOAL_LIMIT = 7;
const SERVE_WAIT = 1.3;                                  // 골이 들어간 뒤 퍽을 다시 내놓기까지의 시간(초)

function rng(seed) {                                     // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const homeOf = (who) => ({ x: CX, y: who === 0 ? H - 70 : 70 });
const servePoint = (to) => ({ x: CX, y: to === 0 ? H * 0.7 : H * 0.3 });

function newGame(opts = {}) {
  const limit = opts.goalLimit || GOAL_LIMIT;
  const first = opts.first === 1 ? 1 : 0;
  const st = {
    score: [0, 0], goalLimit: limit, winner: -1, time: 0,
    puck: { x: CX, y: H / 2, vx: 0, vy: 0 },
    pad: [0, 1].map((w) => ({ ...homeOf(w), vx: 0, vy: 0 })),
    target: [0, 1].map((w) => homeOf(w)),
    speed: [PAD_SPEED, PAD_SPEED],                        // 패들 최고 속도 (컴퓨터는 낮출 수 있다)
    serve: { to: first, wait: SERVE_WAIT },
    events: [], ticks: 0,
  };
  placeServe(st);
  return st;
}
function placeServe(st) {
  const p = servePoint(st.serve.to);
  st.puck.x = p.x; st.puck.y = p.y; st.puck.vx = 0; st.puck.vy = 0;
}

// 패들 목표를 정한다 (내 쪽 절반 안으로 잘라 넣는다)
function clampPad(who, x, y) {
  const minY = who === 0 ? H / 2 + 4 : PAD_R, maxY = who === 0 ? H - PAD_R : H / 2 - 4;
  return { x: Math.min(W - PAD_R, Math.max(PAD_R, x)), y: Math.min(maxY, Math.max(minY, y)) };
}
function setTarget(st, who, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  st.target[who] = clampPad(who, x, y);
  return true;
}

// 원 (cx,cy,r) 와 선분 (ax,ay)-(bx,by) 의 충돌을 풀고 튕긴다. 부딪혔으면 true
function bounceSegment(p, ax, ay, bx, by, r, e) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - ax) * dx + (p.y - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + dx * t, qy = ay + dy * t;
  let nx = p.x - qx, ny = p.y - qy;
  let d = Math.hypot(nx, ny);
  if (d >= r) return false;
  if (d < 1e-6) { nx = dy; ny = -dx; d = Math.hypot(nx, ny) || 1; }
  nx /= d; ny /= d;
  p.x = qx + nx * r; p.y = qy + ny * r;
  const vn = p.vx * nx + p.vy * ny;
  if (vn < 0) { p.vx -= (1 + e) * vn * nx; p.vy -= (1 + e) * vn * ny; }
  return true;
}

const GL = CX - GOAL_W / 2, GR = CX + GOAL_W / 2;        // 골대 구멍의 왼쪽·오른쪽 끝
function step(st, dt = DT) {
  if (st.winner >= 0) return;
  st.ticks++; st.time += dt;
  // 패들: 목표를 향해 최고 속도 안에서
  for (let w = 0; w < 2; w++) {
    const pd = st.pad[w], tg = st.target[w];
    let dx = tg.x - pd.x, dy = tg.y - pd.y;
    const d = Math.hypot(dx, dy), max = st.speed[w] * dt;
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    pd.vx = dx / dt; pd.vy = dy / dt;
    pd.x += dx; pd.y += dy;
  }
  const p = st.puck;
  if (st.serve.wait > 0) {                                // 퍽을 내놓기 전: 가만히 있고 숫자를 센다
    st.serve.wait -= dt;
    if (st.serve.wait <= 0) { st.serve.wait = 0; st.events.push({ type: 'serve', to: st.serve.to }); }
    return;
  }
  p.x += p.vx * dt; p.y += p.vy * dt;
  const f = Math.exp(-FRICTION * dt);
  p.vx *= f; p.vy *= f;
  // 벽 (양옆은 통째로, 위아래는 골대 구멍만 비우고)
  let wall = false;
  wall = bounceSegment(p, 0, 0, 0, H, PUCK_R, WALL_E) || wall;
  wall = bounceSegment(p, W, 0, W, H, PUCK_R, WALL_E) || wall;
  wall = bounceSegment(p, 0, 0, GL, 0, PUCK_R, WALL_E) || wall;
  wall = bounceSegment(p, GR, 0, W, 0, PUCK_R, WALL_E) || wall;
  wall = bounceSegment(p, 0, H, GL, H, PUCK_R, WALL_E) || wall;
  wall = bounceSegment(p, GR, H, W, H, PUCK_R, WALL_E) || wall;
  if (wall) st.events.push({ type: 'wall', speed: Math.hypot(p.vx, p.vy) });
  // 패들
  for (let w = 0; w < 2; w++) {
    const pd = st.pad[w];
    let nx = p.x - pd.x, ny = p.y - pd.y;
    const d = Math.hypot(nx, ny), min = PUCK_R + PAD_R;
    if (d >= min) continue;
    if (d < 1e-6) { nx = 0; ny = w === 0 ? -1 : 1; } else { nx /= d; ny /= d; }
    p.x = pd.x + nx * min; p.y = pd.y + ny * min;
    const vn = (p.vx - pd.vx) * nx + (p.vy - pd.vy) * ny;
    if (vn < 0) {
      p.vx -= (1 + PAD_E) * vn * nx; p.vy -= (1 + PAD_E) * vn * ny;
      st.events.push({ type: 'hit', who: w, speed: Math.hypot(p.vx, p.vy) });
    }
    // 퍽이 패들과 벽 사이에 끼면 벽 쪽으로 더 밀리지 않게 한 번 더 벽을 푼다
    bounceSegment(p, 0, 0, 0, H, PUCK_R, 0); bounceSegment(p, W, 0, W, H, PUCK_R, 0);
  }
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > MAX_PUCK) { p.vx *= MAX_PUCK / sp; p.vy *= MAX_PUCK / sp; }
  // 골: 퍽 가운데가 끝 선을 넘어 구멍으로 들어갔다
  if (p.y < -PUCK_R * 0.6 || p.y > H + PUCK_R * 0.6) {
    const scorer = p.y < 0 ? 0 : 1;                       // 위쪽 골대(1 번 편 골대)에 들어가면 0 번이 득점
    st.score[scorer]++;
    st.events.push({ type: 'goal', who: scorer });
    st.serve = { to: 1 - scorer, wait: SERVE_WAIT };
    placeServe(st);
    if (st.score[scorer] >= st.goalLimit) { st.winner = scorer; st.events.push({ type: 'win', who: scorer }); }
  }
}

// 시간이 다 됐을 때: 점수가 높은 쪽이 이기고 같으면 무승부(2)
function finishByTime(st) {
  if (st.winner >= 0) return st.winner;
  st.winner = st.score[0] > st.score[1] ? 0 : st.score[1] > st.score[0] ? 1 : 2;
  return st.winner;
}

// ---------- 컴퓨터 ----------
// level: 'easy' 는 느리고 퍽의 지금 자리만 쫓아가며, 'hard' 는 퍽이 튕겨 올 자리를 미리 가늠해 막고 틈이 나면 골대를 향해 친다
// mem 은 컴퓨터가 들고 다니는 기억 ({ next: 다음에 다시 생각할 시각 }). 매 틱 호출해도 되고, 생각은 가끔만 한다
const LEVELS = { easy: { speed: 420, think: 0.22, noise: 28 }, hard: { speed: 880, think: 0.04, noise: 6 } };
function makeAi(level) { return { level, next: 0 }; }
function predictX(p, targetY) {                            // 퍽이 지금 속도로 계속 가며 양옆 벽에 튕긴다고 보고 targetY 에 닿을 때의 x
  if (Math.abs(p.vy) < 1e-6) return p.x;
  const t = (targetY - p.y) / p.vy;
  if (t < 0) return null;
  let x = p.x + p.vx * t;
  const span = W - 2 * PUCK_R;
  x = ((x - PUCK_R) % (2 * span) + 2 * span) % (2 * span);
  if (x > span) x = 2 * span - x;
  return x + PUCK_R;
}
function aiStep(st, who, ai, rand = Math.random) {
  const lv = LEVELS[ai.level] || LEVELS.hard;
  st.speed[who] = lv.speed;
  if (st.time < ai.next) return;
  ai.next = st.time + lv.think;
  const p = st.puck, me = st.pad[who], home = homeOf(who);
  const dir = who === 0 ? -1 : 1;                          // 상대 골대 쪽으로 가는 y 방향
  const oppGoalY = who === 0 ? 0 : H;
  const own = who === 0 ? p.y > H / 2 : p.y < H / 2;       // 퍽이 내 쪽에 있는가
  const jitter = () => (rand() - 0.5) * 2 * lv.noise;
  let tx = home.x, ty = home.y;
  if (st.serve.wait > 0) { tx = CX; ty = home.y; }
  else if (ai.level === 'easy') {
    if (own) { tx = p.x + jitter(); ty = p.y - dir * 0 + (who === 0 ? 24 : -24); }
    else { tx = CX + (p.x - CX) * 0.5 + jitter(); ty = home.y; }
  } else {
    const speed = Math.hypot(p.vx, p.vy);
    const towardMe = who === 0 ? p.vy > 20 : p.vy < -20;
    if (own && speed < 260) {                                  // 느리게 내 쪽에 있다: 뒤에 서서 골대를 향해 친다
      const gx = CX + (rand() - 0.5) * GOAL_W * 0.6, gy = oppGoalY;
      let ux = gx - p.x, uy = gy - p.y;
      const d = Math.hypot(ux, uy) || 1; ux /= d; uy /= d;
      const bx = p.x - ux * (PUCK_R + PAD_R + 22), by = p.y - uy * (PUCK_R + PAD_R + 22);
      const nearBehind = Math.hypot(me.x - bx, me.y - by) < 36;
      if (nearBehind) { tx = p.x + ux * 30; ty = p.y + uy * 30; } else { tx = bx; ty = by; }
    } else if (towardMe) {                                       // 내 골대로 온다: 도착할 자리를 미리 막는다
      const px = predictX(p, home.y);
      tx = px === null ? p.x : px + jitter();
      ty = home.y - dir * 0;
      if (own && Math.abs(p.y - me.y) < 120) { tx = p.x; ty = p.y + (who === 0 ? 20 : -20); }   // 가까우면 맞받아친다
    } else {                                                     // 멀어져 간다: 자리로 돌아가며 퍽의 x 쪽으로 조금 기운다
      tx = CX + (p.x - CX) * 0.35; ty = home.y;
    }
  }
  setTarget(st, who, tx, ty);
}

return { W, H, CX, PUCK_R, PAD_R, GOAL_W, DT, PAD_SPEED, MAX_PUCK, FRICTION, GOAL_LIMIT, SERVE_WAIT, LEVELS, rng, homeOf, servePoint, newGame, clampPad, setTarget, step, finishByTime, makeAi, aiStep, predictX };
})();
if (typeof module !== 'undefined') module.exports = LOGIC_HOCKEY;
