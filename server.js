// Citadel Legends II - online server (rooms + quick battle).
// No dependencies. Run:  node server.js     (needs Node.js 16+)
// Port: env PORT or 8080.  The server only relays messages between two players.

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SOLDIERS = new Set(['grunt', 'runner', 'tank', 'knight', 'healer', 'phantom', 'shielded', 'colossus']);

const rooms = new Map();   // room name -> { pass, host }
let queue = [];            // clients waiting for a quick battle
const clients = new Set();

// ------------------------------------------------------------ websocket plumbing
function frame(op, data) {
  const len = data.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, data]);
}

function send(c, obj) {
  if (c && !c.closed) {
    try { c.socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); } catch (e) { /* ignore */ }
  }
}

function onData(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  for (;;) {
    if (c.buf.length < 2) return;
    const b0 = c.buf[0], b1 = c.buf[1];
    const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 65536) { c.socket.destroy(); return; }
    const maskLen = masked ? 4 : 0;
    const need = off + maskLen + len;
    if (c.buf.length < need) return;
    let payload = Buffer.from(c.buf.subarray(off + maskLen, need));
    if (masked) {
      const mask = c.buf.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    c.buf = c.buf.subarray(need);
    if (op === 0x8) { c.socket.end(frame(0x8, Buffer.alloc(0))); return; }
    if (op === 0x9) { c.socket.write(frame(0xA, payload)); continue; }
    if (op === 0xA) continue;
    if (op === 0x1) c.frag = payload;
    else if (op === 0x0 && c.frag) c.frag = Buffer.concat([c.frag, payload]);
    else continue;
    if (fin) {
      const text = c.frag.toString('utf8');
      c.frag = null;
      let msg;
      try { msg = JSON.parse(text); } catch (e) { continue; }
      if (msg && typeof msg === 'object') handle(c, msg);
    }
  }
}

// ------------------------------------------------------------ game logic
function cleanName(s) {
  s = String(s || 'Player').trim().slice(0, 14);
  return s || 'Player';
}

function detach(c) {
  queue = queue.filter(q => q !== c);
  if (c.room && rooms.has(c.room) && rooms.get(c.room).host === c) rooms.delete(c.room);
  c.room = null;
}

function endMatch(c, reason) {
  // c leaves the match -> opponent wins
  const o = c.opp;
  c.opp = null;
  if (o) {
    o.opp = null;
    send(o, { t: 'opp_left' });
    send(o, { t: 'result', win: true, reason });
  }
}

function startMatch(a, b) {
  detach(a); detach(b);
  a.opp = b; b.opp = a;
  const seed = crypto.randomInt(0, 1000000);
  send(a, { t: 'matched', opp: b.name, seed, you: 1 });
  send(b, { t: 'matched', opp: a.name, seed, you: 2 });
  console.log(`match: ${a.name} vs ${b.name}`);
}

function handle(c, m) {
  switch (m.t) {
    case 'create': {
      if (c.opp) return;
      detach(c);
      c.name = cleanName(m.name);
      const room = String(m.room || '').trim().slice(0, 20).toLowerCase();
      const pass = String(m.pass || '').slice(0, 20);
      if (!room) return send(c, { t: 'error', msg: 'Enter a room name' });
      if (rooms.has(room)) return send(c, { t: 'error', msg: 'Room name already taken' });
      rooms.set(room, { pass, host: c });
      c.room = room;
      send(c, { t: 'waiting', room });
      break;
    }
    case 'join': {
      if (c.opp) return;
      detach(c);
      c.name = cleanName(m.name);
      const room = String(m.room || '').trim().slice(0, 20).toLowerCase();
      const pass = String(m.pass || '').slice(0, 20);
      const r = rooms.get(room);
      if (!r) return send(c, { t: 'error', msg: 'Room not found' });
      if (r.pass !== pass) return send(c, { t: 'error', msg: 'Wrong password' });
      startMatch(r.host, c);
      break;
    }
    case 'quick': {
      if (c.opp) return;
      detach(c);
      c.name = cleanName(m.name);
      const other = queue.find(q => q !== c && !q.closed);
      if (other) startMatch(other, c);
      else { queue.push(c); send(c, { t: 'waiting', quick: true }); }
      break;
    }
    case 'cancel':
      detach(c);
      break;
    case 'send':
      if (c.opp && SOLDIERS.has(m.type)) send(c.opp, { t: 'soldier', type: m.type });
      break;
    case 'hp':
      if (c.opp) send(c.opp, { t: 'opp_hp', v: Math.max(0, Math.min(999, Number(m.v) || 0)) });
      break;
    case 'lost':
      if (c.opp) {
        const o = c.opp;
        c.opp = null; o.opp = null;
        send(o, { t: 'result', win: true, reason: 'base' });
        send(c, { t: 'result', win: false, reason: 'base' });
      }
      break;
    case 'leave':
      endMatch(c, 'left');
      break;
  }
}

function onClose(c) {
  if (c.closed) return;
  c.closed = true;
  clients.delete(c);
  detach(c);
  endMatch(c, 'left');
}

// ------------------------------------------------------------ http server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Citadel Legends II server OK. Online: ${clients.size}, waiting: ${queue.length}, rooms: ${rooms.size}\n`);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), name: 'Player', opp: null, room: null, closed: false, frag: null };
  clients.add(c);
  socket.on('data', d => onData(c, d));
  socket.on('close', () => onClose(c));
  socket.on('error', () => onClose(c));
});

// keep connections alive on hosts that drop idle sockets
setInterval(() => {
  for (const c of clients) { try { c.socket.write(frame(0x9, Buffer.alloc(0))); } catch (e) { /* ignore */ } }
}, 25000);

server.listen(PORT, () => console.log(`Citadel Legends II server listening on port ${PORT}`));
