import { defineConfig } from "vite";

// GitHub Pages serves the site under /<repo>/, so asset URLs need that prefix
// when built for production. Local dev still mounts at / via `npm run dev`.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/3pp-helper/" : "/",
}));
