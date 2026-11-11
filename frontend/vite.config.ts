// vite.config.ts — dev server bound to 0.0.0.0:3000 (the port supervisor expects), HMR over the
// HTTPS ingress (clientPort 443), and REACT_APP_* kept as an allowed env prefix so the existing
// REACT_APP_BACKEND_URL variable works unchanged through import.meta.env.
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "REACT_APP_");
  const backend = (env.REACT_APP_BACKEND_URL || "http://localhost:8000").replace(/\/+$/, "");

  return {
    plugins: [react()],
    envPrefix: ["VITE_", "REACT_APP_"],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      host: "0.0.0.0",
      port: 3000,
      strictPort: true,
      allowedHosts: true,
      hmr: { clientPort: 443 },
      proxy: { "/api": { target: backend, changeOrigin: true } },
    },
  };
});
