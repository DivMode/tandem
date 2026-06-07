import { defineConfig } from "vitest/config";

// An inline (empty) PostCSS config stops vite/vitest from walking UP past the
// repo for a postcss.config.js — a stray one in a parent directory (e.g.
// $HOME) would otherwise break every test run with unrelated plugin errors.
// This repo has no CSS to process.
export default defineConfig({
  css: { postcss: { plugins: [] } },
});
