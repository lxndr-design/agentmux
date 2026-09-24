import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest runs unit/component tests (jsdom). Playwright owns the browser smoke
// test (e2e/ — its own config, own runner): CI runs the two suites with
// different lifecycle needs (vitest in-band, Playwright against live servers).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
    exclude: [...configDefaults.exclude, 'e2e/**', 'demo/**'],
  },
});
