import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/*
  Only here so a test can import an API route the way the route imports itself:
  Next resolves "@/lib/db" from tsconfig paths, vitest does not read those.
  Everything else stays on vitest's defaults.
*/
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
