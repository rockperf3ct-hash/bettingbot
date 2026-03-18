/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // FanDuel-style navy + blue
        navy: {
          950: '#060d1f',
          900: '#0a1628',
          800: '#0f2040',
          700: '#152a52',
          600: '#1b3564',
          500: '#234080',
        },
        blue: {
          400: '#3b9eff',
          500: '#1a7ce8',
          600: '#1565c8',
        },
        // Keep brand green for win/positive indicators
        brand: {
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
        },
        // Surface colors
        surface: {
          DEFAULT: '#0f2040',
          raised:  '#152a52',
          overlay: '#1b3564',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)',
        slip: '0 4px 24px rgba(0,0,0,0.6)',
      },
      animation: {
        'pulse-slow': 'pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'score-bump': 'scoreBump 0.4s ease-out',
        'slide-in':   'slideIn 0.25s ease-out',
        'fade-in':    'fadeIn 0.2s ease-out',
      },
      keyframes: {
        scoreBump: {
          '0%':   { transform: 'scale(1)',    color: '#ffffff' },
          '50%':  { transform: 'scale(1.25)', color: '#3b9eff' },
          '100%': { transform: 'scale(1)',    color: '#ffffff' },
        },
        slideIn: {
          '0%':   { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)',     opacity: '1' },
        },
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
