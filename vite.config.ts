import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import reactPlugin from "@vitejs/plugin-react";
import { defineConfig, PluginOption } from "vite";

import sparkPlugin from "@github/spark/spark-vite-plugin";
import createIconImportProxy from "@github/spark/vitePhosphorIconProxyPlugin";
import { resolve } from 'path'

const projectRoot = process.env.PROJECT_ROOT || import.meta.dirname
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' || !!process.env.VITEST

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Use regular React plugin for tests without Fast Refresh
    isTest 
      ? reactPlugin({ 
          // Include only test files for React transformation
          include: /\.test\.(tsx?|jsx?)$/
        }) 
      : react(),
    tailwindcss(),
    // DO NOT REMOVE
    createIconImportProxy() as PluginOption,
    sparkPlugin() as PluginOption,
  ],
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src')
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    deps: {
      optimizer: {
        web: {
          include: []
        }
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test-setup.ts',
        'src/components/ui/**',
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
      ]
    }
  }
});
