import { defineConfig } from 'vitest/config';

export default defineConfig({
  // './' lets the built game work from any sub-path (e.g. GitHub Pages).
  base: './',
  build: {
    chunkSizeWarningLimit: 2000, // Phaser alone is ~1.2 MB before gzip
  },
  test: {
    include: ['src/**/*.test.ts', 'server/src/**/*.test.ts'],
    environment: 'node', // core logic is pure TypeScript, no browser needed
  },
});
