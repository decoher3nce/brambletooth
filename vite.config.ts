import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    open: true,
    allowedHosts: [".tail7e6e30.ts.net", "localhost"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
