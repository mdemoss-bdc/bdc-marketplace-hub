import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const DEFAULT_PORT = 5173;
const DEFAULT_API_TARGET = 'http://127.0.0.1:8080';

function resolvePort(): number {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_PORT;

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid PORT value: "${raw}"`);
  }
  return parsed;
}

const port = resolvePort();
const host = process.env.HOST ?? 'localhost';
const basePath = process.env.BASE_PATH ?? '/';
const apiTarget = process.env.API_PROXY_TARGET ?? DEFAULT_API_TARGET;

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    // Never emit source maps in production builds.
    // Eliminates the /dist/*.js.map files that expose original TS source.
    sourcemap: false,
    // Minify with esbuild (default) — names are mangled, strings inlined.
    minify: 'esbuild',
    rollupOptions: {
      output: {
        // Hashed, content-addressed chunk names — no readable module paths.
        chunkFileNames:  'assets/[hash].js',
        entryFileNames:  'assets/[hash].js',
        assetFileNames:  'assets/[hash][extname]',
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host,
    proxy: {
      // Forward /api/* to the Python BDC engine.
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host,
  },
});
