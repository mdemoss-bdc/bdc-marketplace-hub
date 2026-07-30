/**
 * Vercel-safe random token helpers for the local api-server package.
 * Re-exports the shared Node helper (node:crypto + Web Crypto fallback).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadShared(): {
  randomHex: (n: number) => string;
  randomRecoveryId: () => string;
  randomBytesCompat: (n: number) => Buffer;
} {
  const candidates = [
    path.resolve(__dirname, "../../../api/_lib/random-token.js"),
    path.resolve(process.cwd(), "api/_lib/random-token.js"),
    path.resolve(process.cwd(), "../api/_lib/random-token.js"),
  ];
  for (const file of candidates) {
    try {
      return require(file);
    } catch {
      /* try next */
    }
  }
  // Inline Web Crypto fallback if shared module is unreachable
  function randomBytesCompat(size: number): Buffer {
    const n = Math.max(1, Number(size) || 16);
    try {
      const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
      return randomBytes(n);
    } catch {
      /* Web Crypto */
    }
    const bytes = new Uint8Array(n);
    globalThis.crypto.getRandomValues(bytes);
    return Buffer.from(bytes);
  }
  function randomHex(byteLength: number): string {
    return randomBytesCompat(byteLength).toString("hex");
  }
  function randomRecoveryId(): string {
    return `REC-${randomHex(3).toUpperCase()}-${randomHex(3).toUpperCase()}`;
  }
  return { randomBytesCompat, randomHex, randomRecoveryId };
}

const shared = loadShared();

export const randomBytesCompat = shared.randomBytesCompat;
export const randomHex = shared.randomHex;
export const randomRecoveryId = shared.randomRecoveryId;

export default shared;
