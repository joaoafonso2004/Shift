/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#08090c', soft: '#12141a', line: '#1e2129' },
        chalk: { DEFAULT: '#f4f5f7', dim: '#9aa1ae', faint: '#5b6270' },
        // Squad identity hues, indexed by sync_members.color_slot (0-3).
        slot: { 0: '#4f8cff', 1: '#ff8a4f', 2: '#3ddc97', 3: '#c77dff' },
        pass: '#3ddc97',
        warn: '#ffb020',
        fail: '#ff5f56',
      },
    },
  },
  plugins: [],
};
