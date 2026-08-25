import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    // lightningcss (Vite 8's default) rejects the design system's
    // ::picker(select):popover-open rules; esbuild minifies them fine.
    cssMinify: "esbuild",
  },
});
