import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// `base: "./"` keeps every URL relative, so the built site works from any folder
// (for example https://<user>.github.io/Readily/).
export default defineConfig({
  base: "./",
  plugins: [tailwindcss()],
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
