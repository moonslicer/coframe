import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy the WebSocket to the Node WS server so the browser reaches it via /ws.
    proxy: {
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true, changeOrigin: true },
    },
  },
});
