import { defineConfig } from 'vite'

export default defineConfig({
  base: '/CardLogy/',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      // In dev, proxy auth + card API calls to local relay (port 8080)
      '/login':    { target: 'http://localhost:8080' },
      '/register': { target: 'http://localhost:8080' },
      '/cards':    { target: 'http://localhost:8080' },
    },
  },
})
