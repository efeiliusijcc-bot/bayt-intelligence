import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    server: {
      deps: {
        inline: true,
      },
    },
  },
  server: {
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:4180",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom", "@tanstack/react-query"],
          "fluent-vendor": ["@fluentui/react-components", "@fluentui/react-icons"],
        },
      },
    },
  },
});
