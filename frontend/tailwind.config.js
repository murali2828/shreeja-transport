// frontend/tailwind.config.js
// Theme: Shreeja Platform — deep sky-blue navbar, frosted-glass cards, white content area
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Primary Shreeja blue — matches the screenshot navbar (#0078D4 family)
        brand: {
          50:  '#e6f3fb',
          100: '#bddff5',
          200: '#8ec9ef',
          300: '#57b0e8',
          400: '#1f9be2',
          500: '#0078d4',   // exact Shreeja primary
          600: '#006bbf',
          700: '#005ba3',
          800: '#004b87',
          900: '#003a6b',
          950: '#00264a',
        },
        // Shreeja sky gradient stops
        sky: {
          from: '#0078d4',
          to:   '#2da0e0',
        },
      },
      fontFamily: {
        sans: ['Segoe UI', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        sm:   '0 1px 3px rgba(0,0,0,.08)',
        DEFAULT: '0 2px 8px rgba(0,0,0,.10)',
        md:   '0 4px 16px rgba(0,0,0,.12)',
        lg:   '0 8px 32px rgba(0,0,0,.14)',
        card: '0 2px 12px rgba(0,120,212,.10)',
        nav:  '0 2px 8px rgba(0,0,0,.18)',
      },
      borderRadius: {
        'xl':  '12px',
        '2xl': '16px',
        '3xl': '20px',
      },
      backgroundImage: {
        // Main page background — matches Shreeja sky gradient
        'shreeja-bg': 'linear-gradient(135deg, #0078d4 0%, #2da0e0 40%, #5bbce8 70%, #a8d8f0 100%)',
        // Card frosted glass
        'glass':      'linear-gradient(135deg, rgba(255,255,255,0.92) 0%, rgba(240,248,255,0.88) 100%)',
      },
    },
  },
  plugins: [],
};
