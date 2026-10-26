'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/logic.js');

function ready(st) { while (st.serve.wait > 0) L.step(st); st.events.length = 0; }

test('new game starts with serve wait and puck at serve point', () => {
  const st = L.newGame({ first: 0 });
  assert.deepStrictEqual(st.score, [0, 0]);
  assert.ok(st.serve.wait > 0);
  assert.strictEqual(st.puck.x, L.CX);
  ready(st);
  assert.strictEqual(st.serve.wait, 0);
});

test('pad stays in own half and respects max speed', () => {
  const st = L.newGame();
  ready(st);
  L.setTarget(st, 0, 150, 0);
  assert.ok(st.target[0].y >= L.H / 2);
  L.setTarget(st, 1, 150, 9999);
  assert.ok(st.target[1].y <= L.H / 2);
  const y0 = st.pad[0].y;
  L.step(st);
  assert.ok(Math.abs(st.pad[0].y - y0) <= L.PAD_SPEED * L.DT + 1e-9);
});

test('setTarget rejects non finite numbers', () => {
  const st = L.newGame();
  assert.strictEqual(L.setTarget(st, 0, NaN, 10), false);
  assert.strictEqual(L.setTarget(st, 0, 10, Infinity), false);
  assert.strictEqual(L.setTarget(st, 0, 10, 400), true);
});

test('puck bounces off side wall', () => {
  const st = L.newGame();
  ready(st);
  st.puck.x = L.W - L.PUCK_R - 1; st.puck.y = 250; st.puck.vx = 400; st.puck.vy = 0;
  for (let i = 0; i < 30; i++) L.step(st);
  assert.ok(st.puck.vx < 0);
  assert.ok(st.puck.x <= L.W - L.PUCK_R + 1e-6);
});

test('goal at top scores for seat 0 and serves toward seat 1', () => {
  const st = L.newGame();
  ready(st);
  st.puck.x = L.CX; st.puck.y = 40; st.puck.vx = 0; st.puck.vy = -600;
  for (let i = 0; i < 240 && st.score[0] === 0; i++) L.step(st);
  assert.strictEqual(st.score[0], 1);
  assert.strictEqual(st.serve.to, 1);
  assert.ok(st.serve.wait > 0);
});

test('goal at bottom scores for seat 1', () => {
  const st = L.newGame();
  ready(st);
  st.puck.x = L.CX; st.puck.y = L.H - 40; st.puck.vx = 0; st.puck.vy = 600;
  for (let i = 0; i < 240 && st.score[1] === 0; i++) L.step(st);
  assert.strictEqual(st.score[1], 1);
  assert.strictEqual(st.serve.to, 0);
});

test('puck off center hits the end wall not the goal', () => {
  const st = L.newGame();
  ready(st);
  st.puck.x = 30; st.puck.y = 40; st.puck.vx = 0; st.puck.vy = -600;
  for (let i = 0; i < 240; i++) L.step(st);
  assert.deepStrictEqual(st.score, [0, 0]);
});

test('first to goal limit wins and game stops', () => {
  const st = L.newGame({ goalLimit: 2 });
  ready(st);
  for (let k = 0; k < 2; k++) {
    ready(st);
    st.puck.x = L.CX; st.puck.y = 40; st.puck.vx = 0; st.puck.vy = -700;
    for (let i = 0; i < 240 && st.winner < 0 && st.score[0] === k; i++) L.step(st);
  }
  assert.strictEqual(st.winner, 0);
  const t = st.ticks;
  L.step(st);
  assert.strictEqual(st.ticks, t);
});

test('pad hit sends puck away and fires hit event', () => {
  const st = L.newGame();
  ready(st);
  const pd = st.pad[0];
  st.puck.x = pd.x; st.puck.y = pd.y - L.PUCK_R - L.PAD_R - 2; st.puck.vx = 0; st.puck.vy = 200;
  let hit = false;
  for (let i = 0; i < 20; i++) { L.step(st); if (st.events.some((e) => e.type === 'hit')) hit = true; }
  assert.ok(hit);
  assert.ok(st.puck.vy < 0);
});

test('puck speed is capped', () => {
  const st = L.newGame();
  ready(st);
  st.puck.vx = 5000; st.puck.vy = 5000;
  L.step(st);
  assert.ok(Math.hypot(st.puck.vx, st.puck.vy) <= L.MAX_PUCK + 1e-6);
});

test('same inputs give same result', () => {
  const run = () => {
    const st = L.newGame(); ready(st);
    st.puck.vx = 300; st.puck.vy = -400;
    for (let i = 0; i < 600; i++) { L.setTarget(st, 0, 100 + (i % 100), 400); L.step(st); }
    return [st.puck.x, st.puck.y, st.score.join()];
  };
  assert.deepStrictEqual(run(), run());
});

test('finishByTime picks higher score or draw', () => {
  const a = L.newGame(); a.score = [3, 2];
  assert.strictEqual(L.finishByTime(a), 0);
  const b = L.newGame(); b.score = [1, 4];
  assert.strictEqual(L.finishByTime(b), 1);
  const c = L.newGame(); c.score = [2, 2];
  assert.strictEqual(L.finishByTime(c), 2);
});

test('predictX folds off the walls and stays inside', () => {
  const p = { x: 150, y: 100, vx: 500, vy: 300 };
  const x = L.predictX(p, 430);
  assert.ok(x >= L.PUCK_R && x <= L.W - L.PUCK_R);
  assert.strictEqual(L.predictX({ x: 1, y: 1, vx: 0, vy: -5 }, 400), null);
});

test('hard computer beats easy computer', () => {
  let hard = 0, easy = 0;
  for (let s = 1; s <= 6; s++) {
    const st = L.newGame({ first: s % 2 }); const r = L.rng(s);
    const a = [L.makeAi('hard'), L.makeAi('easy')];
    for (let i = 0; i < 120 / L.DT && st.winner < 0; i++) { L.aiStep(st, 0, a[0], r); L.aiStep(st, 1, a[1], r); L.step(st); st.events.length = 0; }
    hard += st.score[0]; easy += st.score[1];
  }
  assert.ok(hard > easy * 3, `hard ${hard} easy ${easy}`);
});
