import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// T081 — Dev proxy forwards API paths to the local Bun backend
// (default port 3000, override via VITE_DEV_API_TARGET). Cookies pass through
// transparently so session auth works against http://127.0.0.1:5175.
const apiTarget = process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
        secure: false,
      },
      '/v1': {
        target: apiTarget,
        changeOrigin: false,
        secure: false,
      },
      '/webhooks': {
        target: apiTarget,
        changeOrigin: false,
        secure: false,
      },
    },
  },
});
