import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": "http://127.0.0.1:7220",
      "/clash": "http://127.0.0.1:7220",
      "/clash-ws": { target: "ws://127.0.0.1:7220", ws: true },
    },
  },
});
