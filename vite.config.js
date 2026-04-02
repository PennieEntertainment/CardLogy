import { defineConfig } from 'vite'

export default defineConfig({
  // Set this to your repo name when deploying to GitHub Pages
  // e.g. base: '/cardlogy/'
  base: './',
  build: {
    outDir: 'dist',
  },
  plugins: [
    {
      name: 'peerjs-server',
      async configureServer(server) {
        const { ExpressPeerServer } = await import('peer')
        // Embed PeerJS signaling directly into Vite's HTTP server.
        // No separate port, no proxy, no child process — restarts safely.
        const peerApp = ExpressPeerServer(server.httpServer, { path: '/peerjs' })
        server.middlewares.use(peerApp)
        peerApp.on('connection', c => console.log(`[peerjs] + ${c.getId()}`))
        peerApp.on('disconnect', c => console.log(`[peerjs] - ${c.getId()}`))
        console.log('[peerjs] Peer server embedded at /peerjs')
      },
    },
  ],
})
