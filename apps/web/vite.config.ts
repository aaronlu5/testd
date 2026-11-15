import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [
    // Keep absolute /images/... URLs as plain public-dir URLs instead of importing them as modules.
    vue({ template: { transformAssetUrls: { includeAbsolute: false } } }),
  ],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true },
})
