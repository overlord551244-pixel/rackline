'use strict';
// Minimal WebSocket server (RFC 6455), text messages only, no dependencies.
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 64 * 1024;

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragLen = 0;
    this.fragOp = null;
    this.alive = true;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', (c) => { try { this.feed(c); } catch (e) { this.terminate(); } });
    socket.on('close', () => this.finish());
    socket.on('end', () => this.finish());
    socket.on('error', () => this.finish());
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.closed || this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MSG)) return this.close(1009);
        len = Number(big); off = 10;
      }
      if (len > MAX_MSG) return this.close(1009);
      if (!masked) return this.close(1002);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.handle(fin, op, data);
    }
  }

  handle(fin, op, data) {
    if (op === 8) return this.close(1000);
    if (op === 9) { this.raw(frame(10, data.subarray(0, 125))); return; }
    if (op === 10) { this.alive = true; return; }
    if (op === 1 || op === 2) {
      this.fragOp = op; this.frags = []; this.fragLen = 0;
    } else if (op !== 0 || this.fragOp === null) {
      return this.close(1002);
    }
    this.frags.push(data);
    this.fragLen += data.length;
    if (this.fragLen > MAX_MSG) return this.close(1009);
    if (!fin) return;
    const msg = Buffer.concat(this.frags);
    const textual = this.fragOp === 1;
    this.fragOp = null; this.frags = []; this.fragLen = 0;
    this.alive = true;
    if (textual && this.onmessage) this.onmessage(msg.toString('utf8'));
  }

  raw(buf) { if (!this.closed && this.socket.writable) this.socket.write(buf); }
  send(str) { this.raw(frame(1, Buffer.from(str, 'utf8'))); }
  ping() { this.raw(frame(9, Buffer.alloc(0))); }

  close(code) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
    this.raw(frame(8, p));
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.finish();
  }
  terminate() { this.socket.destroy(); this.finish(); }
  finish() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
  }
}

// Attach to an http.Server. `onConnection(conn, req)` runs after the handshake.
function attach(server, onConnection) {
  const conns = new Set();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const up = String(req.headers.upgrade || '').toLowerCase();
    if (up !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const conn = new Conn(socket);
    conns.add(conn);
    conn.finish = function () {
      if (this.closed) return;
      this.closed = true;
      conns.delete(this);
      if (this.onclose) this.onclose();
    };
    onConnection(conn, req);
  });
  // Keep idle connections open through proxies and drop dead ones.
  const timer = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.terminate(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 25000);
  timer.unref();
}

module.exports = { attach };
