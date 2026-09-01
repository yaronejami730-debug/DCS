import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    // Bind every interface. Without this Vite listens on ::1 only, so a browser
    // that resolves "localhost" to 127.0.0.1 gets a dead connection — and, the
    // point of this app, a phone on the same WiFi could not reach it at all.
    host: true,
  },
  resolve: {
    // Belt and braces against the "Invalid hook call" class of failure: in a
    // hoisted monorepo a dependency can resolve a different React copy than the
    // app does, and two Reacts in one page break every hook.
    dedupe: ['react', 'react-dom'],
  },
  // The .env lives at the repo root so every app shares one file.
  envDir: '../..',
});
