'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { attach } = require('./lib/ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

// ---------- Static files ----------
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  let rel = url === '/' ? '/index.html' : url;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
});

// ---------- Rooms ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOBBY_GRACE = 60 * 1000;          // a seat in the lobby survives a reload
const GAME_GRACE = 10 * 60 * 1000;      // a disconnected player can come back for 10 minutes
const ROOM_IDLE = 30 * 60 * 1000;       // empty rooms are removed
const CHAT_MAX = 300;
const CHAT_KEEP = 50;
const EMOTES = 8;

const rooms = new Map();
const byConn = new Map();               // conn -> { room, seat }

const now = () => Date.now();
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanName = (s) => clean(s, 20) || 'Player';
const out = (conn, o) => { try { conn.send(JSON.stringify(o)); } catch (e) {} };

function newCode() {
  for (let n = 0; n < 200; n++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function seatOf(room, cid) { return room.seats.findIndex((s) => s && s.cid === cid); }
function connected(room) { return room.seats.filter((s) => s && s.conn).length; }

function info(room, seat) {
  return {
    t: 'room', code: room.code, size: room.size, status: room.status, you: seat, hostSeat: room.hostSeat,
    turn: room.turn, hasState: !!room.state,
    seats: room.seats.map((s) => (s ? { name: s.name, connected: !!s.conn } : null)),
  };
}
function broadcastInfo(room) {
  room.seats.forEach((s, i) => { if (s && s.conn) out(s.conn, info(room, i)); });
}
function broadcast(room, o, exceptSeat) {
  const str = JSON.stringify(o);
  room.seats.forEach((s, i) => { if (s && s.conn && i !== exceptSeat) { try { s.conn.send(str); } catch (e) {} } });
}
function closeRoom(room, reason) {
  broadcast(room, { t: 'closed', reason });
  room.seats.forEach((s) => { if (s && s.conn) byConn.delete(s.conn); });
  rooms.delete(room.code);
}
function attachSeat(room, seat, conn) {
  const s = room.seats[seat];
  if (s.conn && s.conn !== conn) { byConn.delete(s.conn); try { out(s.conn, { t: 'closed', reason: 'You opened this game somewhere else.' }); s.conn.close(1000); } catch (e) {} }
  s.conn = conn; s.lost = 0;
  byConn.set(conn, { room, seat });
  room.active = now();
}
function sync(room, conn, seat) {
  out(conn, info(room, seat));
  out(conn, { t: 'history', msgs: room.chat });
  if (room.pending) out(conn, { t: 'fire', from: room.turn, shot: room.pending.shot, state: room.pending.state });
  else if (room.state) out(conn, Object.assign({ t: 'sync' }, room.state));
}

function say(room, seat, text) {
  const s = room.seats[seat];
  const m = { t: 'chat', seat, name: s ? s.name : '', text, ts: now() };
  room.chat.push(m);
  if (room.chat.length > CHAT_KEEP) room.chat.shift();
  broadcast(room, m);
}

function dropSeat(room, seat, why) {
  const s = room.seats[seat];
  if (!s) return;
  if (s.conn) { byConn.delete(s.conn); }
  if (room.status !== 'lobby') { closeRoom(room, s.name + ' left the game.'); return; }
  room.seats[seat] = null;
  if (!room.seats.some(Boolean)) { rooms.delete(room.code); return; }
  if (room.hostSeat === seat) room.hostSeat = room.seats.findIndex(Boolean);
  broadcastInfo(room);
}

// ---------- Message handling ----------
function onMessage(conn, raw) {
  conn.msgs = (conn.msgs || 0) + 1;
  if (!conn.win || now() - conn.win > 2000) { conn.win = now(); conn.msgs = 1; }
  if (conn.msgs > 120) return;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  const ctx = byConn.get(conn);

  if (m.t === 'create') {
    if (ctx) return;
    const size = m.size === 4 ? 4 : 2;
    const code = newCode();
    if (!code) return out(conn, { t: 'err', msg: 'The server is busy. Try again in a moment.' });
    const cid = clean(m.cid, 64);
    if (!cid) return;
    const room = {
      code, size, status: 'lobby', hostSeat: 0, turn: 0, state: null, pending: null, over: false,
      seats: new Array(size).fill(null), chat: [], created: now(), active: now(),
    };
    room.seats[0] = { cid, name: cleanName(m.name), conn: null, lost: 0 };
    rooms.set(code, room);
    attachSeat(room, 0, conn);
    sync(room, conn, 0);
    return;
  }

  if (m.t === 'join' || m.t === 'resume') {
    if (ctx) return;
    const room = rooms.get(clean(m.code, 8).toUpperCase());
    const cid = clean(m.cid, 64);
    if (!room || !cid) return out(conn, { t: 'err', code: 'gone', msg: 'No room with that code. Check it and try again.' });
    let seat = seatOf(room, cid);
    if (seat >= 0) {
      if (m.t === 'join' && m.name) room.seats[seat].name = cleanName(m.name);
    } else {
      if (m.t === 'resume') return out(conn, { t: 'err', code: 'gone', msg: 'That game is no longer available.' });
      if (room.status !== 'lobby') return out(conn, { t: 'err', msg: 'That game has already started.' });
      seat = room.seats.findIndex((s) => !s);
      if (seat < 0) return out(conn, { t: 'err', msg: 'That room is full.' });
      room.seats[seat] = { cid, name: cleanName(m.name), conn: null, lost: 0 };
    }
    attachSeat(room, seat, conn);
    broadcastInfo(room);
    sync(room, conn, seat);
    return;
  }

  if (!ctx) return;
  const { room, seat } = ctx;
  room.active = now();

  switch (m.t) {
    case 'seat': {
      const to = m.seat | 0;
      if (room.status !== 'lobby' || to < 0 || to >= room.size || room.seats[to]) return;
      room.seats[to] = room.seats[seat]; room.seats[seat] = null;
      byConn.set(conn, { room, seat: to });
      if (room.hostSeat === seat) room.hostSeat = to;
      broadcastInfo(room);
      return;
    }
    case 'start': {
      if (room.status !== 'lobby' || seat !== room.hostSeat || room.seats.some((s) => !s)) return;
      room.status = 'playing'; room.turn = 0; room.state = null; room.pending = null; room.over = false;
      broadcastInfo(room);
      return;
    }
    case 'newgame': {
      const first = room.status === 'playing' && !room.state && seat === room.hostSeat;
      const again = room.status === 'playing' && room.over;
      if ((!first && !again) || !m.state || typeof m.state !== 'object') return;
      room.over = false; room.pending = null;
      room.turn = Math.min(room.size - 1, Math.max(0, m.state.turn | 0));
      room.state = { phase: 'aiming', winner: -1, reason: '', state: m.state };
      broadcast(room, Object.assign({ t: 'sync' }, room.state), seat);
      return;
    }
    case 'fire': {
      if (room.status !== 'playing' || room.over || room.pending || seat !== room.turn || !room.state) return;
      if (!m.shot || !m.state) return;
      room.pending = { shot: m.shot, state: m.state };
      broadcast(room, { t: 'fire', from: seat, shot: m.shot, state: m.state }, seat);
      return;
    }
    case 'result': {
      if (!room.pending || seat !== room.turn || !m.state) return;
      room.pending = null;
      const phase = m.phase === 'over' || m.phase === 'placing' ? m.phase : 'aiming';
      room.state = { phase, winner: m.winner | 0, reason: clean(m.reason, 200), state: m.state };
      room.turn = Math.min(room.size - 1, Math.max(0, m.state.turn | 0));
      if (phase === 'over') room.over = true;
      broadcast(room, Object.assign({ t: 'sync' }, room.state), seat);
      return;
    }
    case 'place': {
      if (!room.state || room.state.phase !== 'placing' || seat !== room.turn || !m.state) return;
      room.state = { phase: 'aiming', winner: -1, reason: '', state: m.state };
      broadcast(room, Object.assign({ t: 'sync' }, room.state), seat);
      return;
    }
    case 'aim': {
      if (room.status !== 'playing' || seat !== room.turn) return;
      broadcast(room, { t: 'aim', a: +m.a || 0, p: +m.p || 0 }, seat);
      return;
    }
    case 'chat': {
      const text = clean(m.text, CHAT_MAX);
      if (!text) return;
      const s = room.seats[seat];
      s.chatWin = (s.chatWin || []).filter((x) => now() - x < 10000);
      if (s.chatWin.length >= 12) return out(conn, { t: 'err', soft: true, msg: 'You are sending messages too fast.' });
      s.chatWin.push(now());
      say(room, seat, text);
      return;
    }
    case 'emote': {
      const id = m.id | 0;
      if (id < 0 || id >= EMOTES) return;
      const s = room.seats[seat];
      if (s.lastEmote && now() - s.lastEmote < 500) return;
      s.lastEmote = now();
      broadcast(room, { t: 'emote', seat, id });
      return;
    }
    case 'leave': {
      dropSeat(room, seat, 'left');
      return;
    }
  }
}

function onClose(conn) {
  const ctx = byConn.get(conn);
  byConn.delete(conn);
  if (!ctx) return;
  const { room, seat } = ctx;
  const s = room.seats[seat];
  if (!s || s.conn !== conn) return;
  s.conn = null; s.lost = now();
  room.active = now();
  broadcastInfo(room);
}

attach(server, (conn) => {
  conn.onmessage = (raw) => onMessage(conn, raw);
  conn.onclose = () => onClose(conn);
});

// Housekeeping: free abandoned seats and remove idle rooms.
setInterval(() => {
  const t = now();
  for (const room of Array.from(rooms.values())) {
    if (connected(room) === 0 && t - room.active > ROOM_IDLE) { rooms.delete(room.code); continue; }
    room.seats.forEach((s, i) => {
      if (!s || s.conn || !s.lost) return;
      const grace = room.status === 'lobby' ? LOBBY_GRACE : GAME_GRACE;
      if (t - s.lost > grace && rooms.has(room.code)) dropSeat(room, i, 'timeout');
    });
  }
}, 15000).unref();

server.listen(PORT, () => console.log('Rackline listening on port ' + PORT));
