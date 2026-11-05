import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
function testPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Invalid browser-test port.');
  return Number(value);
}
const apiOrigin = `http://127.0.0.1:${testPort(process.env.NEXRUN_E2E_API_PORT, 3001)}`;
const webPort = testPort(process.env.NEXRUN_E2E_WEB_PORT, 5173);
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: webPort, strictPort: true, proxy: { '/api': apiOrigin, '/healthz': apiOrigin } },
});
