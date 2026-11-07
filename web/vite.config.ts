/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm start` in ../back listens on 3218 by default (back/.env PORT=3218); PLST_API lets you
// point the dev server at another host/port (e.g. PLST_API=http://127.0.0.1:8123 npm start).
// YAUM_API is the pre-rename name and is still honoured so an old shell profile keeps working.
const target = process.env.PLST_API || process.env.YAUM_API || 'http://localhost:3218';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: true, secure: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    restoreMocks: true,
  },
});
