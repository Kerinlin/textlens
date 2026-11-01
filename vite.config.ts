import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const fromRoot = (...parts: string[]): string => resolve(projectRoot, ...parts)

export default defineConfig({
  root: fromRoot('src/renderer'),
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  resolve: {
    alias: {
      '@shared': fromRoot('src/shared'),
      '@renderer': fromRoot('src/renderer')
    }
  },
  build: {
    outDir: fromRoot('dist'),
    emptyOutDir: true,
    target: 'safari15',
    rollupOptions: {
      input: {
        toolbar: fromRoot('src/renderer/toolbar/index.html'),
        result: fromRoot('src/renderer/result/index.html'),
        settings: fromRoot('src/renderer/settings/index.html'),
        startup: fromRoot('src/renderer/startup/index.html'),
        screenshot: fromRoot('src/renderer/screenshot/index.html'),
        shotPin: fromRoot('src/renderer/shot-pin/index.html')
      }
    }
  }
})
