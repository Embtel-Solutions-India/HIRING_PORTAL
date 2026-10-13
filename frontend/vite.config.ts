import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // loadEnv (not process.env) so this file type-checks without Node types.
  const api = loadEnv(mode, ".", "").API_URL || "http://localhost:3000";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // In development the API runs separately on :3000 (npm run dev in /backend); override with API_URL.
      proxy: {
        "/api": api,
        "/t/": api,
      },
    },
  };
});
