/**
 * CardLogy WebSocket Relay Server
 *
 * Rooms: Map<code, { host: WebSocket, guest: WebSocket | null }>
 *
 * Client → Server messages:
 *   { type: 'create' }              → server responds { type: 'created', code }
 *   { type: 'join', code }          → server responds { type: 'joined' } or { type: 'error', reason }
 *   { type: 'msg', data }           → relayed as { type: 'msg', data } to the other player
 *   { type: 'ping' }                → server responds { type: 'pong' }
 *
 * Server → Client messages:
 *   { type: 'created', code }       → host: room created with this code
 *   { type: 'joined' }              → guest: successfully joined
 *   { type: 'peer-joined' }         → host: a guest connected
 *   { type: 'peer-left' }           → either: the other player disconnected
 *   { type: 'msg', data }           → relayed payload from the other player
 *   { type: 'error', reason }       → 'not-found' | 'full'
 *   { type: 'pong' }                → keep-alive reply
 *
 * Deploy to Railway / Fly.io / any Node.js host.
 * Set the PORT environment variable if needed (default: 8080).
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash, randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARDS_FILE = join(__dirname, 'cards.json');
const USERS_FILE = join(__dirname, 'users.json');

// ── Card storage ───────────────────────────────────────
let cards = [];
if (existsSync(CARDS_FILE)) {
  try { cards = JSON.parse(readFileSync(CARDS_FILE, 'utf8')); } catch { cards = []; }
}

function persistCards() {
  writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2), 'utf8');
}

// ── User storage ───────────────────────────────────────
let users = [];
if (existsSync(USERS_FILE)) {
  try { users = JSON.parse(readFileSync(USERS_FILE, 'utf8')); } catch { users = []; }
}

function persistUsers() {
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function hashPassword(salt, password) {
  return createHash('sha256').update(salt + ':' + password).digest('hex');
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // code -> { host, guest }

function genCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function attachClient(ws) {
  ws._code = null;
  ws._role = null; // 'host' | 'guest'

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        if (ws._code) break; // already in a room
        const code = genCode();
        rooms.set(code, { host: ws, guest: null });
        ws._code = code;
        ws._role = 'host';
        ws.send(JSON.stringify({ type: 'created', code }));
        break;
      }

      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', reason: 'not-found' }));
          break;
        }
        if (room.guest) {
          ws.send(JSON.stringify({ type: 'error', reason: 'full' }));
          break;
        }
        room.guest = ws;
        ws._code = code;
        ws._role = 'guest';
        ws.send(JSON.stringify({ type: 'joined' }));
        room.host.send(JSON.stringify({ type: 'peer-joined' }));
        break;
      }

      case 'msg': {
        const room = rooms.get(ws._code);
        if (!room) break;
        const other = ws._role === 'host' ? room.guest : room.host;
        if (other && other.readyState === ws.OPEN) {
          other.send(JSON.stringify({ type: 'msg', data: msg.data }));
        }
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => {
    if (!ws._code) return;
    const room = rooms.get(ws._code);
    if (!room) return;
    if (ws._role === 'host') {
      if (room.guest && room.guest.readyState === ws.OPEN) {
        room.guest.send(JSON.stringify({ type: 'peer-left' }));
      }
      rooms.delete(ws._code);
    } else if (ws._role === 'guest') {
      room.guest = null;
      if (room.host && room.host.readyState === ws.OPEN) {
        room.host.send(JSON.stringify({ type: 'peer-left' }));
      }
    }
  });
}

const server = createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const pathname = new URL(req.url, 'http://x').pathname;

  // POST /auth/login
  if (req.method === 'POST' && pathname === '/auth/login') {
    try {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing-fields' })); return;
      }
      const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
      if (!user || hashPassword(user.salt, password) !== user.hash) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad-credentials' })); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, username: user.username }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid-request' }));
    }
    return;
  }

  // POST /auth/register
  if (req.method === 'POST' && pathname === '/auth/register') {
    try {
      const body = await readBody(req);
      const username = String(body.username || '').trim().slice(0, 20);
      const password = String(body.password || '');
      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing-fields' })); return;
      }
      if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid-username' })); return;
      }
      if (password.length < 4) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'password-too-short' })); return;
      }
      if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'username-taken' })); return;
      }
      const salt = randomBytes(16).toString('hex');
      const hash = hashPassword(salt, password);
      users.push({ username, hash, salt });
      persistUsers();
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, username }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid-request' }));
    }
    return;
  }

  // GET /cards
  if (req.method === 'GET' && pathname === '/cards') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cards)); return;
  }

  // POST /cards — upsert a single card
  if (req.method === 'POST' && pathname === '/cards') {
    try {
      const card = await readBody(req);
      if (!card || typeof card !== 'object' || !card.id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid card' })); return;
      }
      const idx = cards.findIndex(c => c.id === card.id);
      if (idx !== -1) cards[idx] = card; else cards.push(card);
      persistCards();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(card));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // DELETE /cards/:id
  const delMatch = pathname.match(/^\/cards\/(.+)$/);
  if (req.method === 'DELETE' && delMatch) {
    const id = decodeURIComponent(delMatch[1]);
    const before = cards.length;
    cards = cards.filter(c => c.id !== id);
    persistCards();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted: before - cards.length })); return;
  }

  // Default
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CardLogy Relay OK');
});

const wss = new WebSocketServer({ server });
wss.on('connection', attachClient);

server.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));
