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

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('CardLogy Relay OK');
});

const wss = new WebSocketServer({ server });
wss.on('connection', attachClient);

server.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));
