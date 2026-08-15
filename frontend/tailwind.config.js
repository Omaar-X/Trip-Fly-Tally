/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
          950: '#042f2e',
        },
      },
      fontFamily: {
        sans: ['"Spline Sans"', '"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"Spline Sans Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card:      '0 1px 2px rgb(0 0 0/0.04), 0 4px 16px -4px rgb(0 0 0/0.08)',
        'card-md': '0 2px 8px rgb(0 0 0/0.06), 0 8px 32px -8px rgb(0 0 0/0.12)',
        'card-lg': '0 8px 40px -8px rgb(0 0 0/0.18)',
        glow:      '0 0 0 3px rgb(20 184 166/0.2)',
      },
      animation: {
        'fade-in':  'fadeIn 0.18s ease-out both',
        'slide-up': 'slideUp 0.24s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-in': 'slideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) both',
        'scale-in': 'scaleIn 0.18s ease-out both',
      },
      keyframes: {
        fadeIn:  { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(10px)' },  to: { opacity: '1', transform: 'translateY(0)' } },
        slideIn: { from: { opacity: '0', transform: 'translateX(-12px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        scaleIn: { from: { opacity: '0', transform: 'scale(0.95)' },       to: { opacity: '1', transform: 'scale(1)' } },
      },
    },
  },
  plugins: [],
};
