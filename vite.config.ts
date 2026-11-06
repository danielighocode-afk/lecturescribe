import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Older phones (Android 7 era Chrome, iOS 12 and up) should still run the app.
    target: ['chrome64', 'safari12'],
  },
});
