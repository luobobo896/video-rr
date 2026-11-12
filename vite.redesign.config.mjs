import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('web-redesign'),
  base: './',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    fs: {
      allow: [resolve('.')],
    },
    proxy: {
      '/admin/api': 'http://127.0.0.1:8787',
      '/api': 'http://127.0.0.1:8787',
      '/media': 'http://127.0.0.1:8787',
      '/i': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: resolve('dist/redesign'),
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
  },
  preview: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
    proxy: {
      '/admin/api': 'http://127.0.0.1:8787',
      '/api': 'http://127.0.0.1:8787',
      '/media': 'http://127.0.0.1:8787',
      '/i': 'http://127.0.0.1:8787',
    },
  },
})
