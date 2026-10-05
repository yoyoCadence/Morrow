import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback only, like the API it talks to.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // changeOrigin rewrites Host to the API's own address, which the API requires.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
