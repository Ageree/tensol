import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/api': process.env.VITE_API_URL ?? 'http://localhost:3000',
      '/auth': process.env.VITE_API_URL ?? 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
});
