import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client always calls relative `/api/...`. In development Vite proxies it
// to the API; in Docker, nginx does the same (see nginx.conf).
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
});
