import { defineConfig } from 'vitest/config';

// base './' so the build serves from any subpath, including GitHub Pages at /VYBEZ/.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // The heaviest things in this project should be Mike's paintings, not the bundle.
    chunkSizeWarningLimit: 600,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
