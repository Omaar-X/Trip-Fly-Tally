import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isHostedBuild = env.VERCEL === '1' || Boolean(env.RAILWAY_ENVIRONMENT);
  const apiUrl = env.VITE_API_URL?.trim();

  // A hosted SPA has no Vite dev proxy. Fail deployment instead of shipping a
  // build that sends API requests to index.html and breaks at login.
  if (isHostedBuild && !apiUrl) {
    throw new Error('VITE_API_URL is required for hosted frontend builds (for example: https://api.example.com)');
  }
  if (apiUrl) {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== 'https:' && mode === 'production') {
      throw new Error('VITE_API_URL must use HTTPS in production');
    }
  }

  return {
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
  };
});
