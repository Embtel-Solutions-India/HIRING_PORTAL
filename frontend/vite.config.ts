import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs separately on :3000 (npm run dev in /backend).
    proxy: {
      "/api": "http://localhost:3000",
      "/t/": "http://localhost:3000",
    },
  },
});
