'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
// 규칙·물리는 브라우저와 같은 코드를 쓴다
const L = require('./public/logic.js');

// ---------- Config ----------
const PORT = process.env.PORT || 3014;
const MATCH_MS = Number(process.env.MATCH_MS) || 300000;   // 한 판 제한 시간. 넘기면 점수가 높은 쪽 승. 시험에서는 환경변수로 줄인다
const GOAL_LIMIT = Number(process.env.GOAL_LIMIT) || L.GOAL_LIMIT;   // 이기는 점수. 시험에서는 줄인다
const TICK_MS = 1000 / 60;      // 서버가 판을 계산하는 간격 (한 번에 DT 두 칸)
const SEND_EVERY = 2;           // 계산 두 번에 한 번(초당 30번) 위치를 보낸다
const GRACE_MS = 30000;         // 대국 중 연결이 끊겨도 이 시간 안에 돌아오면 이어서 둔다
// 프록시가 WebSocket ping 을 대신 받아버리는 환경이 있어, 클라이언트가 보내는 pulse 로 살아있는지 본다
const HEARTBEAT_MS = 25000;
const SILENCE_TIMEOUT_MS = 90000;
// 헷갈리는 글자(0/O, 1/I)는 빼서 코드를 불러주기 쉽게 한다
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- Static file server ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
// 주소 해석·파일 경로 검사: 잘못된 % 표기나 널 문자는 null, 점으로 시작하는 파일과 폴더 밖 경로는 내보내지 않는다
function safeDecode(s) {
  try {
    const d = decodeURIComponent(s);
    return d.includes('\0') ? null : d;
  } catch { return null; }
}
function isServable(filePath, baseDir) {
  const inside = filePath === baseDir || filePath.startsWith(baseDir + path.sep);
  return inside && !filePath.slice(baseDir.length).split(path.sep).some((seg) => seg.startsWith('.'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let reqPath = safeDecode(req.url.split('?')[0]);
  if (reqPath === null) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad request'); return; }
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!isServable(filePath, PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// 메시지 크기 제한: 기본값(100MB)이면 큰 메시지 하나로 서버 메모리를 먹일 수 있다. 이 게임의 메시지는 모두 이보다 훨씬 작다
const wss = new WebSocketServer({ server, maxPayload: 1024 });

// ---------- 방 코드 무차별 대입 방지 ----------
// 없는 방 코드를 짧은 시간에 여러 번 대면 잠깐 막는다 (손님 주소 기준: 로비 프록시가 붙여 주는 x-forwarded-for 의 첫 값)
const JOIN_FAIL_MAX = 8, JOIN_WINDOW_MS = 60000, JOIN_BLOCK_MS = 60000;
const joinFails = new Map();   // 주소 -> { n, since, until }
const clientIp = (req) => String((req && req.headers['x-forwarded-for']) || (req && req.socket.remoteAddress) || '').split(',')[0].trim();
function joinBlocked(ip) {
  const f = joinFails.get(ip);
  return !!f && f.until > Date.now();
}
function noteJoinFail(ip) {
  const now = Date.now();
  let f = joinFails.get(ip);
  if (!f || now - f.since > JOIN_WINDOW_MS) f = { n: 0, since: now, until: 0 };
  f.n++;
  if (f.n >= JOIN_FAIL_MAX) { f.until = now + JOIN_BLOCK_MS; f.n = 0; f.since = now; }
  joinFails.set(ip, f);
  if (joinFails.size > 2000) for (const [k, v] of joinFails) if (v.until < now && now - v.since > JOIN_WINDOW_MS) joinFails.delete(k);
}

// ---------- State ----------
const rooms = new Map();     // code -> room
const clients = new Map();   // ws -> client
let queue = null;            // 빠른 대전을 기다리는 client 하나
let nextId = 1;

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ t: type, ...payload }));
}

function makeCode() {
  for (let k = 0; k < 50; k++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

const makeToken = () => crypto.randomBytes(18).toString('base64url');   // 자리를 되찾는 열쇠: 예측할 수 없는 난수로

function sanitizeName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10);
  return name || `손님${Math.floor(100 + Math.random() * 900)}`;
}


// ---------- Rooms ----------
function createRoom(isPrivate) {
  const room = {
    code: makeCode(),
    isPrivate,
    seats: [],               // { client, name, color, token, online, graceTimer } — color 는 판 위치 (0 아래쪽 · 1 위쪽, 서로 바뀐다)
    game: L.newGame({ goalLimit: GOAL_LIMIT }),
    state: 'waiting',        // waiting | playing | over
    winner: -1,              // 0 · 1 (color) · 2 무승부
    reason: '',              // goals | time | resign | left
    endAt: 0,
    loop: null,
    lastTick: 0,
    acc: 0,
    n: 0,
    evSeq: 0,
    rematch: new Set(),
    games: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function seatOf(room, client) {
  return room.seats.find((s) => s.client === client);
}

function snapshot(room, seat) {
  return {
    code: room.code,
    isPrivate: room.isPrivate,
    token: seat.token,
    you: seat.color,
    players: room.seats.map((s) => ({ name: s.name, color: s.color, online: s.online })),
    score: room.game.score.slice(),
    goalLimit: room.game.goalLimit,
    games: room.games,
    state: room.state,
    winner: room.winner,
    reason: room.reason,
    remain: room.state === 'playing' ? Math.max(0, room.endAt - Date.now()) : 0,
    rematch: [...room.rematch],
    ...frame(room),
  };
}

// 움직임: 퍽·패들 위치와 속도, 서브 대기 시간. 화면이 이걸 받아 그린다
function frame(room) {
  const g = room.game, p = g.puck;
  const r = (v) => Math.round(v * 10) / 10;
  return {
    puck: [r(p.x), r(p.y), r(p.vx), r(p.vy)],
    pads: g.pad.map((q) => [r(q.x), r(q.y)]),
    serve: g.serve.wait > 0 ? { to: g.serve.to, wait: Math.round(g.serve.wait * 100) / 100 } : null,
  };
}

function pushRoom(room) {
  for (const s of room.seats) if (s.online) send(s.client.ws, 'room', snapshot(room, s));
}

function broadcast(room, type, payload) {
  for (const s of room.seats) if (s.online) send(s.client.ws, type, payload);
}

function sitDown(room, client) {
  const seat = { client, name: client.name, color: -1, token: makeToken(), online: true, graceTimer: null };
  room.seats.push(seat);
  client.roomCode = room.code;
  if (room.seats.length === 2) startGame(room, true);
  else pushRoom(room);
}

function startGame(room, first) {
  if (first) {
    const r = crypto.randomInt(2);
    room.seats[r].color = 0;
    room.seats[1 - r].color = 1;
  } else {
    for (const s of room.seats) s.color = 1 - s.color;
  }
  room.game = L.newGame({ goalLimit: GOAL_LIMIT, first: crypto.randomInt(2) });
  room.state = 'playing';
  room.winner = -1;
  room.reason = '';
  room.rematch.clear();
  room.games++;
  room.endAt = Date.now() + MATCH_MS;
  room.lastTick = Date.now();
  room.acc = 0;
  room.n = 0;
  clearInterval(room.loop);
  room.loop = setInterval(() => tick(room), TICK_MS);
  pushRoom(room);
}

// 실제로 흐른 시간만큼 DT 단위로 계산한다 (너무 오래 멈췄다 와도 한 번에 따라잡는 양은 제한)
function tick(room) {
  const now = Date.now();
  room.acc = Math.min(0.25, room.acc + (now - room.lastTick) / 1000);
  room.lastTick = now;
  const g = room.game;
  while (room.acc >= L.DT && g.winner < 0) { L.step(g); room.acc -= L.DT; }
  for (const e of g.events) {
    if (e.type === 'goal') broadcast(room, 'ev', { e: 'goal', who: e.who, score: g.score.slice() });
    else if (e.type === 'hit') broadcast(room, 'ev', { e: 'hit', who: e.who, speed: Math.round(e.speed) });
    else if (e.type === 'wall') broadcast(room, 'ev', { e: 'wall', speed: Math.round(e.speed) });
    else if (e.type === 'serve') broadcast(room, 'ev', { e: 'serve' });
  }
  g.events.length = 0;
  if (g.winner >= 0) return endGame(room, g.winner, 'goals');
  if (now >= room.endAt) return endGame(room, L.finishByTime(g), 'time');
  if (++room.n % SEND_EVERY === 0) broadcast(room, 's', { ...frame(room), score: g.score.slice(), remain: Math.max(0, room.endAt - now) });
}

function endGame(room, winner, reason) {
  if (room.state !== 'playing') return;
  clearInterval(room.loop);
  room.state = 'over';
  room.winner = winner;
  room.reason = reason;
  room.game.winner = winner;
  pushRoom(room);
}

function closeRoom(room) {
  clearInterval(room.loop);
  for (const s of room.seats) {
    clearTimeout(s.graceTimer);
    if (s.client) s.client.roomCode = null;
  }
  rooms.delete(room.code);
}

function vacate(room, seat) {
  clearTimeout(seat.graceTimer);
  if (room.state === 'playing') endGame(room, 1 - seat.color, 'left');
  room.seats = room.seats.filter((s) => s !== seat);
  if (seat.client) seat.client.roomCode = null;
  if (!room.seats.length || room.state === 'waiting') { closeRoom(room); return; }
  room.rematch.clear();
  pushRoom(room);
}

function dropFromQueue(client) {
  if (queue === client) queue = null;
}

// ---------- Handlers ----------
const handlers = {
  hello(client, msg) {
    client.name = sanitizeName(msg.name);
  },

  quick(client) {
    if (client.roomCode) return;
    if (queue && queue !== client && queue.ws.readyState === queue.ws.OPEN) {
      const other = queue;
      queue = null;
      const room = createRoom(false);
      sitDown(room, other);
      sitDown(room, client);
    } else {
      queue = client;
      send(client.ws, 'queued');
    }
  },

  create(client) {
    if (client.roomCode) return;
    dropFromQueue(client);
    sitDown(createRoom(true), client);
  },

  join(client, msg) {
    if (client.roomCode) return;
    dropFromQueue(client);
    if (joinBlocked(client.ip)) return send(client.ws, 'error', { msg: '방 코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요.' });
    const room = rooms.get(String(msg.code || '').trim().toUpperCase());
    if (!room) { noteJoinFail(client.ip); return send(client.ws, 'error', { msg: '그런 방이 없어요. 코드를 확인해 주세요.' }); }
    if (room.seats.length >= 2) return send(client.ws, 'error', { msg: '이미 두 사람이 하고 있는 방이에요.' });
    sitDown(room, client);
  },

  resume(client, msg) {
    const room = rooms.get(String(msg.code || ''));
    const seat = room && room.seats.find((s) => s.token === msg.token);
    if (!seat) return send(client.ws, 'resumeFailed');
    if (seat.client && seat.client !== client && seat.client.ws.readyState === seat.client.ws.OPEN) {
      seat.client.roomCode = null;
      send(seat.client.ws, 'error', { msg: '다른 창에서 이 대국에 다시 들어왔어요.' });
    }
    clearTimeout(seat.graceTimer);
    seat.client = client;
    seat.online = true;
    client.name = seat.name;
    client.roomCode = room.code;
    pushRoom(room);
  },

  cancel(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat && room.state === 'waiting') vacate(room, seat);
  },

  // 패들을 움직일 목표 위치 (판 좌표). 내 쪽 절반으로 잘라 넣고, 최고 속도는 규칙이 지킨다
  pad(client, msg) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'playing') return;
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    L.setTarget(room.game, seat.color, msg.x, msg.y);
  },

  resign(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat && room.state === 'playing') endGame(room, 1 - seat.color, 'resign');
  },

  rematch(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'over' || room.seats.length < 2) return;
    room.rematch.add(seat.color);
    if (room.rematch.size === 2) startGame(room, false);
    else pushRoom(room);
  },

  leave(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat) vacate(room, seat);
  },

  pulse() {},
};

// ---------- Connections ----------
function onDisconnect(client) {
  dropFromQueue(client);
  const room = rooms.get(client.roomCode);
  const seat = room && seatOf(room, client);
  if (!seat) return;
  if (room.state !== 'playing') { vacate(room, seat); return; }
  // 대국 중이면 잠깐 기다려 준다
  seat.online = false;
  seat.client = null;
  seat.graceTimer = setTimeout(() => vacate(room, seat), GRACE_MS);
  pushRoom(room);
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) ws.ping();
}, HEARTBEAT_MS);

const silenceSweep = setInterval(() => {
  const now = Date.now();
  for (const [ws, client] of clients) {
    if (now - client.lastSeen > SILENCE_TIMEOUT_MS) ws.terminate();
  }
}, 5000);

wss.on('close', () => { clearInterval(heartbeat); clearInterval(silenceSweep); });

wss.on('connection', (ws, req) => {
  ws.on('error', () => {});   // 크기 제한 초과 같은 연결 오류는 그 손님의 연결만 끊고, 처리하지 않으면 서버 전체가 죽는다
  const client = { id: nextId++, ws, ip: clientIp(req), name: sanitizeName(''), roomCode: null, lastSeen: Date.now() };
  clients.set(ws, client);

  ws.on('message', (raw) => {
    client.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const handler = handlers[msg && msg.t];
    if (handler) handler(client, msg);
  });

  ws.on('close', () => {
    onDisconnect(client);
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`에어하키 서버 실행 중 → http://localhost:${PORT}`);
});
