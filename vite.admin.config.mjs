import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('admin'),
  base: './',
  plugins: [vue()],
  publicDir: false,
  server: {
    port: 5174,
    strictPort: true,
    open: '/',
    proxy: {
      '/admin/api': 'http://127.0.0.1:8787',
      '/media': 'http://127.0.0.1:8787',
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: resolve('dist/admin'),
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
  },
})
