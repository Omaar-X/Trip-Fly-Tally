import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // lets the dev frontend call the API without CORS friction
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      // uploaded company branding assets (logo/favicon), served by the backend
      '/uploads': { target: 'http://localhost:4000', changeOrigin: true },
      // deployable Trip Fly BD branding asset, served by the backend
      '/branding': { target: 'http://localhost:4000', changeOrigin: true }
    }
  }
});
