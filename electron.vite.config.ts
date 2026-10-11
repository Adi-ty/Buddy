import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      // Bundle the local avatar generator, including its JSON style definition.
      externalizeDeps: { exclude: ['@dicebear/core', '@dicebear/styles'] },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      // A sandboxed preload must be a self-contained CommonJS bundle.
      lib: { entry: resolve('src/preload/index.ts'), formats: ['cjs'] },
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', strictPort: true },
  },
})
