// @ts-check

/**
 * engine.js - In-process self-contained WebAssembly image engine.
 *
 * This runtime graph remains JavaScript because Node refuses to strip TypeScript
 * from packages installed under node_modules.
 */

import { readFile } from "node:fs/promises";

import initPngModule, { decode as pngDecodeWasm, encode as pngEncodeWasm } from "./pkg/png.js";
import initResizeModule, { resize as wasmResize } from "./pkg/resize.js";

/** @type {Promise<void> | null} */
let pngReady = null;
/** @type {Promise<void> | null} */
let resizeReady = null;

async function ensurePngReady() {
  if (!pngReady) {
    pngReady = (async () => {
      const wasmUrl = new URL("./assets/png.wasm", import.meta.url);
      const wasmBuffer = await readFile(wasmUrl);
      const wasmModule = await WebAssembly.compile(wasmBuffer);
      await initPngModule(wasmModule);
    })();
  }
  return pngReady;
}

async function ensureResizeReady() {
  if (!resizeReady) {
    resizeReady = (async () => {
      const wasmUrl = new URL("./assets/resize.wasm", import.meta.url);
      const wasmBuffer = await readFile(wasmUrl);
      const wasmModule = await WebAssembly.compile(wasmBuffer);
      await initResizeModule(wasmModule);
    })();
  }
  return resizeReady;
}

/**
 * @typedef {object} RawImageData
 * @property {Uint8ClampedArray | Uint8Array} data
 * @property {number} width
 * @property {number} height
 */

/**
 * Decodes a PNG buffer into raw RGBA image data.
 * @param {Uint8Array} buffer
 * @returns {Promise<RawImageData>}
 */
export async function decodePng(buffer) {
  await ensurePngReady();
  const result = await pngDecodeWasm(new Uint8Array(buffer));
  if (!result) throw new Error("Failed to decode PNG with WASM");
  return result;
}

/**
 * Encodes raw RGBA image data into a lossless PNG buffer.
 * @param {Uint8Array | Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Uint8Array>}
 */
export async function encodePng(data, width, height) {
  await ensurePngReady();
  const rawArray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const result = await pngEncodeWasm(rawArray, width, height, 8);
  if (!result) throw new Error("Failed to encode PNG with WASM");
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
}

/**
 * Resizes raw RGBA image data using Lanczos3 interpolation.
 * @param {Uint8Array | Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {Promise<RawImageData>}
 */
export async function resizeLanczos3(data, width, height, targetWidth, targetHeight) {
  await ensureResizeReady();
  const rawArray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const resizedData = wasmResize(
    rawArray,
    width,
    height,
    targetWidth,
    targetHeight,
    3,
    true,
    false,
  );
  return {
    data: resizedData,
    width: targetWidth,
    height: targetHeight,
  };
}
