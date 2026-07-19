import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deployed on GitHub Pages at /natali-krown/ai-content-studio/ — build output
// goes to the sibling ../ai-content-studio directory, which Pages serves.
export default defineConfig({
  plugins: [react()],
  base: '/natali-krown/ai-content-studio/',
  build: {
    outDir: '../ai-content-studio',
    emptyOutDir: true,
  },
})
