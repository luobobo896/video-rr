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
    // 编辑器原子写会在源码目录里生成 .<file>.<pid>.tmpdir/*.tmp，Windows 下 watcher
    // 一旦 watch 到已释放的临时文件就抛 EBUSY 并整进程退出，直接忽略这类目录
    watch: { ignored: ['**/*.tmpdir/**', '**/.*.tmpdir/**', '**/*.tmp'] },
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
