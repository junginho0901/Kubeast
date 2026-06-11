/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      keyframes: {
        // Indeterminate progress segment sliding across its track — used by the
        // cluster-switch indicator so it reads as "working" instead of a bar
        // that sits at a fixed width and then vanishes.
        'indeterminate-bar': {
          '0%': { left: '-35%', width: '35%' },
          '50%': { left: '30%', width: '55%' },
          '100%': { left: '100%', width: '35%' },
        },
      },
      animation: {
        'indeterminate-bar': 'indeterminate-bar 1.1s ease-in-out infinite',
      },
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
