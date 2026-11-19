import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    license: true,
    rolldownOptions: {
      onLog(level, log, handler) {
        // Dependencies also ship to React Server Components. This app runs in the browser.
        if (log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('use client')) return;
        handler(level, log);
      },
    },
  },
});
