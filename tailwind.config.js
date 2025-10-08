module.exports = {
  content: [
    "./*.html",
    "./scripts/**/*.{js,ts}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#7c3aed',
          50: '#f4f0ff',
          100: '#ebe4ff',
          200: '#d6c7ff',
          300: '#b59bff',
          400: '#9a76ff',
          500: '#7c3aed',
          600: '#6d28d9',
          700: '#5b21b6',
          800: '#4c1d95',
          900: '#3b0d7b',
        },
      },
      boxShadow: {
        glow: '0 0 0 2px rgba(124,58,237,.25), 0 5px 25px rgba(124,58,237,.35)',
      },
    },
  },
  plugins: [],
}
