module.exports = {
  plugins: {
    // Tailwind 4: the PostCSS plugin lives in its own package and handles vendor prefixing itself
    // (no separate autoprefixer). The theme is declared in CSS (`src/app/index.css` → `@theme`).
    '@tailwindcss/postcss': {},
  },
};
