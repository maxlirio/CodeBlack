import { defineConfig } from 'vite';

// `base` must match the GitHub Pages sub-path (https://<user>.github.io/CodeBlack/).
// Override with BASE_PATH=/ for local file serving or a custom domain.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/CodeBlack/',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false
  },
  server: {
    host: true
  }
});
