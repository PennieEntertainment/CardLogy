import { defineConfig } from 'vite'

export default defineConfig({
  // Set this to your repo name when deploying to GitHub Pages
  // e.g. base: '/CardLogy/'
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      // /api/cards → relay server (port 8080)
      '/api': {
        target: 'http://localhost:8080',
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
})
