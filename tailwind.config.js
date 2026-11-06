const c = name => `rgb(var(--c-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts}'],
  theme: {
    extend: {
      colors: {
        bg: c('bg'),
        surface: c('surface'),
        surface2: c('surface2'),
        ink: c('ink'),
        muted: c('muted'),
        line: c('line'),
        primary: c('primary'),
        primarysoft: c('primarysoft'),
        onprimary: c('onprimary'),
        lav: c('lav'),
        lavsoft: c('lavsoft'),
        lavink: c('lavink'),
        amber: c('amber'),
        ambersoft: c('ambersoft'),
        amberink: c('amberink'),
        coral: c('coral'),
        coralsoft: c('coralsoft'),
        teal: c('teal'),
        m1: c('m1'),
        m2: c('m2'),
        m3: c('m3'),
      },
      fontFamily: {
        sans: ['Figtree', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: [
          '"Bricolage Grotesque"',
          'Figtree',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
