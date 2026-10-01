import { defineConfig } from "vite";

/*
 * The JARVIS Admin panel is a plain static bundle: no server, no rewrite runtime,
 * no secrets. `vercel.json` publishes `dist/` as static output and rewrites any
 * unknown path to `index.html` so a reload on a deep link (or the OAuth callback
 * that returns to the site root) is always served by the app.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    // The Supabase client is the only runtime dependency and it is not tiny; a
    // single chunk keeps the OAuth redirect back to the origin a single request.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
  },
});