module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: { extend: { colors: {
    bg: 'rgb(var(--bg) / <alpha-value>)', card: 'rgb(var(--card) / <alpha-value>)', line: 'rgb(var(--line) / <alpha-value>)',
    ink: 'rgb(var(--ink) / <alpha-value>)', mute: 'rgb(var(--mute) / <alpha-value>)',
    brand: 'rgb(var(--brand) / <alpha-value>)', good: 'rgb(var(--good) / <alpha-value>)', bad: 'rgb(var(--bad) / <alpha-value>)', warn: 'rgb(var(--warn) / <alpha-value>)' } } },
  plugins: [],
};
