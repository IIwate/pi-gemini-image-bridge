/**
 * engine.ts — In-process self-contained WebAssembly image engine.
 *
 * Provides lazy-loaded WASM PNG decoding, encoding, and Lanczos3 resizing
 * with zero third-party runtime npm dependencies (decisions.md D10).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// @ts-expect-error - Internal WASM glue code
import initPngModule, { decode as pngDecodeWasm, encode as pngEncodeWasm } from "./pkg/png.js";
// @ts-expect-error - Internal WASM glue code
import initResizeModule, { resize as wasmResize } from "./pkg/resize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pngReady: Promise<void> | null = null;
let resizeReady: Promise<void> | null = null;

async function ensurePngReady(): Promise<void> {
  if (!pngReady) {
    pngReady = (async () => {
      const wasmPath = join(__dirname, "assets", "png.wasm");
      const wasmBuffer = await readFile(wasmPath);
      const wasmModule = await WebAssembly.compile(wasmBuffer);
      await initPngModule(wasmModule);
    })();
  }
  return pngReady;
}

async function ensureResizeReady(): Promise<void> {
  if (!resizeReady) {
    resizeReady = (async () => {
      const wasmPath = join(__dirname, "assets", "resize.wasm");
      const wasmBuffer = await readFile(wasmPath);
      const wasmModule = await WebAssembly.compile(wasmBuffer);
      await initResizeModule(wasmModule);
    })();
  }
  return resizeReady;
}

export interface RawImageData {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Decodes a PNG buffer into raw RGBA image data.
 */
export async function decodePng(buffer: Uint8Array): Promise<RawImageData> {
  await ensurePngReady();
  const result = await pngDecodeWasm(new Uint8Array(buffer));
  if (!result) throw new Error("Failed to decode PNG with WASM");
  return result;
}

/**
 * Encodes raw RGBA image data into a lossless PNG buffer.
 */
export async function encodePng(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array> {
  await ensurePngReady();
  const rawArray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const result = await pngEncodeWasm(rawArray, width, height, 8);
  if (!result) throw new Error("Failed to encode PNG with WASM");
  return new Uint8Array(result.buffer);
}

/**
 * Resizes raw RGBA image data to target dimensions using high-quality Lanczos3 interpolation (index 3).
 */
export async function resizeLanczos3(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Promise<RawImageData> {
  await ensureResizeReady();
  const rawArray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // Typ_idx 3 = Lanczos3, premultiply = true, color_space_conversion = false
  const resizedData = wasmResize(rawArray, width, height, targetWidth, targetHeight, 3, true, false);
  return {
    data: resizedData,
    width: targetWidth,
    height: targetHeight,
  };
}
