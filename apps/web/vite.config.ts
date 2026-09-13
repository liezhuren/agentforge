import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 控制台是本地工具，不做代码分割：单文件更容易被服务端直接托管与调试
    sourcemap: false,
  },
  server: {
    port: 5173,
    // 开发时把 API 与 SSE 代理到服务端，避免 CORS 与两套地址
    proxy: {
      '/api': { target: 'http://127.0.0.1:7788', changeOrigin: true },
    },
  },
});
