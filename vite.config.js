import { defineConfig } from 'vite'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Set this to your repo name when deploying to GitHub Pages
  // e.g. base: '/cardlogy/'
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/peerjs': {
        target: 'http://localhost:9000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  plugins: [
    {
      name: 'peerjs-server',
      configureServer() {
        const proc = spawn('node', [join(__dirname, 'peerserver.mjs')], { stdio: 'inherit' })
        process.on('exit', () => proc.kill())
      },
    },
  ],
})
