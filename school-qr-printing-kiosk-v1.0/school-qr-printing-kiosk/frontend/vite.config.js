import { defineConfig } from 'vite';

const target = process.env.KIOSK_DEV_API || 'http://127.0.0.1:3000';

function forwardLocalOrigin(proxyRequest, request) {
  const origin = request.headers.origin;
  if (origin === 'http://' + request.headers.host || origin === 'https://' + request.headers.host) {
    proxyRequest.setHeader('origin', new URL(target).origin);
  }
}

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  build: { target: ['chrome100', 'firefox100', 'safari15.4'] },
  server: {
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        configure(proxy) {
          // Local development only. Send the API its own origin for Vite-origin requests.
          proxy.on('proxyReq', forwardLocalOrigin);
        },
      },
      '/ws/': {
        target,
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReqWs', forwardLocalOrigin);
        },
      },
    },
  },
});

