export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#e8f0fe',
          100: '#c5d8f8',
          200: '#9dbcf4',
          300: '#6d9fef',
          400: '#4484eb',
          500: '#1a6be8',
          600: '#1558c0',
          700: '#0f4398',
          800: '#0a2f70',
          900: '#051948',
        },
        shreeja: {
          blue:   '#1565c0',
          light:  '#42a5f5',
          accent: '#0d47a1',
          bg:     '#e3f2fd',
        }
      },
      backgroundImage: {
        'shreeja-gradient': 'linear-gradient(135deg, #1565c0 0%, #1e88e5 50%, #42a5f5 100%)',
      },
      backdropBlur: { xs: '2px' }
    }
  },
  plugins: []
};
