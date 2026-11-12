import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const apiTarget = process.env.MH_DEV_API_ORIGIN || 'http://127.0.0.1:8787'

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
      '/api': apiTarget,
      '/media': apiTarget,
      '/i': apiTarget,
    },
  },
  build: {
    outDir: resolve('dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
  },
})
