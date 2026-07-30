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
    // Emit static assets at the repository root so Vercel / `pnpm run build`
    // can serve `./dist/index.html` without an extra copy step.
    outDir: path.resolve(import.meta.dirname, '..', '..', 'dist'),
    emptyOutDir: true,
    // Never emit source maps in production builds.
    // Eliminates the /dist/*.js.map files that expose original TS source.
    sourcemap: false,
    // Minify with esbuild (default) — names are mangled, strings inlined.
    minify: 'esbuild',
    // Single app shell chunk is intentionally large; avoid noisy size advisory.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      onLog(level, log, handler) {
        // Silence residual Rollup noise from Next-style "use client" directives
        // that may remain in dependency graphs during location reporting.
        const message = String(log.message || '');
        if (
          message.includes("Can't resolve original location of error") ||
          message.includes('Module level directives cause errors when bundled')
        ) {
          return;
        }
        if (
          log.cause &&
          typeof log.cause === 'object' &&
          'message' in log.cause &&
          String((log.cause as { message?: string }).message || '').includes(
            "Can't resolve original location of error",
          )
        ) {
          return;
        }
        handler(level, log);
      },
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
