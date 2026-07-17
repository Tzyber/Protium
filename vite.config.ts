import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// tauri erwartet den build unter ../dist (relativ zu src-tauri).
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", target: "esnext" },
});
