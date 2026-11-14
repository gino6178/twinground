import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react({jsxImportSource:'@atlas/i18n'})],
  resolve: {alias: {'@atlas/i18n': resolve(import.meta.dirname, 'src/i18n')}},
  server: { proxy: { '/api': 'http://localhost:8765' } },
  build: { rollupOptions: { input: {
    main: resolve(import.meta.dirname, 'index.html'),
    recovery: resolve(import.meta.dirname, 'diagnostics/graphics.html'),
    scenario: resolve(import.meta.dirname, 'microterrain-scenario.html'),
  }, output: { manualChunks(id) {
    // Vendor code changes rarely; separate chunks stay cached across app deploys.
    if (id.includes('/node_modules/three/build/')) return 'three'
    if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
    if (/[\\/]node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/.test(id)) return 'motion'
  } } } },
})
