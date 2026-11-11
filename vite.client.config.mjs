import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('public'),
  base: './',
  plugins: [vue()],
  publicDir: false,
  server: {
    port: 5173,
    strictPort: true,
    open: '/',
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/media': 'http://127.0.0.1:8787',
      '/i': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: resolve('dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
  },
})
