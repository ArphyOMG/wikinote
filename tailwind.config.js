import typography from '@tailwindcss/typography'
import lineClamp from '@tailwindcss/line-clamp'

export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: { extend: {} },
  plugins: [typography, lineClamp],
}
