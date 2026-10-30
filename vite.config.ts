import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// WRANGLER_CONFIG=wrangler.private.jsonc points the build at your real (gitignored) config.
export default defineConfig({
  plugins: [react(), cloudflare({ configPath: process.env.WRANGLER_CONFIG || undefined })],
  server: { port: 5180, strictPort: true },
});
