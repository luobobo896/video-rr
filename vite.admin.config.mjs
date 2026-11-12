import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const apiTarget = process.env.MH_DEV_API_ORIGIN || 'http://127.0.0.1:8787'

export default defineConfig({
  root: resolve('admin'),
  base: './',
  plugins: [vue()],
  publicDir: false,
  server: {
    port: 5174,
    strictPort: true,
    open: '/',
    fs: {
      allow: [resolve('.')],
    },
    proxy: {
      '/admin/api': apiTarget,
      '/media': apiTarget,
      '/api': apiTarget,
    },
  },
  build: {
    outDir: resolve('dist/admin'),
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
  },
})
