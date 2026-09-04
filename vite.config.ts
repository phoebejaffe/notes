import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const port = Number(process.env.PORT) || 3430

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
})
