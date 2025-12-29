import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    global: "window", // 아까 했던 global 변수 해결
  },
  build: {
    minify: false, // ★★★ 여기가 핵심! "압축하지 마" (에러 해결)
    terserOptions: {
      compress: false,
      mangle: false,
    },
  },
})
