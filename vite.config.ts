import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [crx({ manifest })],
  // blocked.html is only a redirect target, so CRXJS copies it without bundling its script.
  // Listing it as an entry gets the script compiled to a file the extension CSP allows.
  build: { rollupOptions: { input: { blocked: "blocked.html" } } },
});
