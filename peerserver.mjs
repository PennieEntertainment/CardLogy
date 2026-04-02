import { PeerServer } from 'peer'

const server = PeerServer({ port: 9000, path: '/peerjs' })

console.log('[peerjs] Signaling server running on http://localhost:9000/peerjs')
server.on('connection',    c => console.log(`[peerjs] + ${c.getId()}`))
server.on('disconnect',    c => console.log(`[peerjs] - ${c.getId()}`))
