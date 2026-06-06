import { defineConfig, loadEnv } from "vite";

// Production deployment topology:
//   https://<PUBLIC_HOST>/brambletooth/        →  static frontend (this build)
//   wss://<PUBLIC_HOST>/brambletooth/ws        →  WebSocket game server
//   https://<PUBLIC_HOST>/brambletooth/api/... →  HTTP profile API
// A reverse-proxy gateway on PUBLIC_HOST fronts all three at the
// /brambletooth/ prefix and strips the prefix before forwarding to
// the Node server on :8787. `base` matches that prefix so asset
// URLs resolve correctly under the proxy.
//
// PUBLIC_HOST is read from the environment (e.g. .env.local) so the
// actual host name never lands in source. See .env.example for the
// expected shape.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const publicHost = env.PUBLIC_HOST?.trim();
  return {
    base: "/brambletooth/",
    server: {
      host: true,
      port: 5173,
      open: true,
      // Wildcard for tailnet MagicDNS hostnames + localhost are safe
      // generic defaults. The deployment's bare short-name is pulled
      // from PUBLIC_HOST so it stays out of the repo.
      allowedHosts: [
        ".tail7e6e30.ts.net",
        "localhost",
        ...(publicHost ? [publicHost] : []),
      ],
    },
    build: {
      target: "es2022",
      sourcemap: true,
    },
  };
});
