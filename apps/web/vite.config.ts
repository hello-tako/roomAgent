import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/orgs": { target: api, ws: true },
      "/join": api,
      "/j": api,
      "/health": api,
      "/local": api,
      "/access": api,
    },
  },
});
