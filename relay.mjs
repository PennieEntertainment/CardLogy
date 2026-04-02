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
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';

// ── Card storage (in-memory) ───────────────────────────
// NOTE: Render's free tier has an ephemeral filesystem.
// Data persists as long as the service stays alive but is
// cleared on every redeploy or restart. For permanent storage
// connect a database (e.g. Render PostgreSQL, Supabase, etc.).
let cards = [];
function persistCards() { /* no-op on ephemeral host */ }

// ── User storage (in-memory) ───────────────────────────
let users = [];
function persistUsers() { /* no-op on ephemeral host */ }

function hashPassword(password, salt) {
  return pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

// Allowed origins: GitHub Pages site + local dev
const ALLOWED_ORIGINS = [
  'https://pennieentertainment.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
];

function setCORS(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
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
  setCORS(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const pathname = new URL(req.url, 'http://x').pathname;

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

  // POST /register
  if (req.method === 'POST' && pathname === '/register') {
    try {
      const body = await readBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || username.length < 3 || !password || password.length < 4) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username must be ≥ 3 characters and password ≥ 4 characters.' })); return;
      }
      if (!/^[a-z0-9_]+$/.test(username)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username may only contain letters, numbers, and underscores.' })); return;
      }
      if (users.find(u => u.username === username)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username already taken.' })); return;
      }
      const salt = randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      users.push({ username, hash, salt });
      persistUsers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, username }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /login
  if (req.method === 'POST' && pathname === '/login') {
    try {
      const body = await readBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = users.find(u => u.username === username);
      if (!user) {
        // Compute a dummy hash to prevent timing-based username enumeration
        const dummySalt = randomBytes(16).toString('hex');
        hashPassword(password, dummySalt);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid username or password.' })); return;
      }
      const hash = hashPassword(password, user.salt);
      const hashBuf   = Buffer.from(hash);
      const storedBuf = Buffer.from(user.hash);
      if (hashBuf.length !== storedBuf.length || !timingSafeEqual(hashBuf, storedBuf)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid username or password.' })); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, username }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Default
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CardLogy Relay OK');
});

const wss = new WebSocketServer({ server });
wss.on('connection', attachClient);

server.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));
