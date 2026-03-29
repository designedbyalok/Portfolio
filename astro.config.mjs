import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  experimental: {
    viewTransitions: true,
  },
  vite: {
    server: {
      fs: {
        allow: [
          '/Users/alokkumar/Astro-portfolio',
        ],
      },
    },
  },
});
