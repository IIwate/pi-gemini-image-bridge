/**
 * Core pipeline tests: scan → budget → load → build, each contract exercised with zero
 * Pi involvement (Unidirectional-Flow litmus test). Run with `node --test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanClipboardImagePaths } from "../src/core/scan.ts";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  createBudgetPool,
  type BudgetPool,
} from "../src/core/budget.ts";
import {
  MAX_SINGLE_IMAGE_BYTES,
  loadImageAdaptive,
  type AdaptiveLoadResult,
} from "../src/core/load.ts";
import {
  TOO_LARGE_PLACEHOLDER,
  UNREADABLE_PLACEHOLDER,
  buildTransform,
  placeholderTextFor,
  type ConvertedItem,
  type ImageContent,
} from "../src/core/build.ts";
import { encodePng } from "../src/wasm/engine.ts";

const UUID = "11111111-2222-4333-8444-555555555555";
const WSL_DROP_DIR = "/tmp";
const WIN_DROP_DIR = "C:\\Users\\tester\\AppData\\Local\\Temp";
const CLIP_PATH = `/tmp/pi-clipboard-${UUID}.png`;

// ---------------------------------------------------------------------------
// scan.ts
// ---------------------------------------------------------------------------

test("scan finds clipboard-image paths in order and deduplicates", () => {
  const other = `/tmp/pi-clipboard-${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}.jpg`;
  const text = `see ${CLIP_PATH} and ${other} and ${CLIP_PATH} again`;
  assert.deepEqual(scanClipboardImagePaths(text, WSL_DROP_DIR), [CLIP_PATH, other]);
});

test("scan matches Windows drop paths with backslash separators", () => {
  const winPath = `${WIN_DROP_DIR}\\pi-clipboard-${UUID}.png`;
  assert.deepEqual(scanClipboardImagePaths(`look at ${winPath}`, WIN_DROP_DIR), [winPath]);
});

test("scan matches Windows drop paths case-insensitively (lowercase drive/path)", () => {
  const winLower = `c:\\users\\tester\\appdata\\local\\temp\\pi-clipboard-${UUID}.png`;
  assert.deepEqual(scanClipboardImagePaths(`look at ${winLower}`, WIN_DROP_DIR), [winLower]);
});

test("scan matches Windows drop paths when separators are mixed (/ vs \\)", () => {
  const winForward = `C:/Users/tester/AppData/Local/Temp/pi-clipboard-${UUID}.png`;
  assert.deepEqual(scanClipboardImagePaths(`look at ${winForward}`, WIN_DROP_DIR), [winForward]);

  const dropDirForward = "C:/Users/tester/AppData/Local/Temp";
  const winBackslash = `C:\\Users\\tester\\AppData\\Local\\Temp\\pi-clipboard-${UUID}.png`;
  assert.deepEqual(scanClipboardImagePaths(`look at ${winBackslash}`, dropDirForward), [winBackslash]);
});

test("scan matches Windows paths with spaces in directory name", () => {
  const spaceDir = "C:\\Users\\John Doe\\AppData\\Local\\Temp";
  const winSpacePath = `${spaceDir}\\pi-clipboard-${UUID}.png`;
  assert.deepEqual(scanClipboardImagePaths(`see ${winSpacePath}`, spaceDir), [winSpacePath]);
});

test("scan ignores non-clipboard paths and URLs", () => {
  const text = `random /tmp/foo.png and /home/user/pi-clipboard-x.png and https://x/y.png`;
  assert.deepEqual(scanClipboardImagePaths(text, WSL_DROP_DIR), []);
});

test("scan returns empty for text without matches", () => {
  assert.deepEqual(scanClipboardImagePaths("no images here", WSL_DROP_DIR), []);
  assert.deepEqual(scanClipboardImagePaths("", WSL_DROP_DIR), []);
});

test("scan accepts all extensions Pi can drop (png/jpg/webp/gif) and uppercase", () => {
  const jpg = `/tmp/pi-clipboard-${UUID}.jpg`;
  const webp = `/tmp/pi-clipboard-${UUID}.webp`;
  const gif = `/tmp/pi-clipboard-${UUID}.gif`;
  const pngUpper = `/tmp/pi-clipboard-${UUID}.PNG`;
  assert.deepEqual(
    scanClipboardImagePaths(`${jpg} ${webp} ${gif} ${pngUpper}`, WSL_DROP_DIR),
    [jpg, webp, gif, pngUpper],
  );
});

// ---------------------------------------------------------------------------
// budget.ts (Dynamic Greedy Budget Pool)
// ---------------------------------------------------------------------------

test("budget pool initializes with default 50MB ceiling and allocates greedily", () => {
  const pool = createBudgetPool();
  assert.equal(pool.remainingBytes, DEFAULT_MAX_REQUEST_BYTES);

  // Consume 2MB
  const alloc1 = pool.allocate(2 * 1024 * 1024);
  assert.equal(alloc1.granted, true);
  assert.equal(pool.remainingBytes, DEFAULT_MAX_REQUEST_BYTES - 2 * 1024 * 1024);

  // Consume 40MB
  const alloc2 = pool.allocate(40 * 1024 * 1024);
  assert.equal(alloc2.granted, true);
  assert.equal(pool.remainingBytes, 8 * 1024 * 1024);

  // Attempt 10MB when only 8MB left -> rejected
  const alloc3 = pool.allocate(10 * 1024 * 1024);
  assert.equal(alloc3.granted, false);
  assert.equal(pool.remainingBytes, 8 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// load.ts (Tiered Adaptive Loader: Tiers 1-4)
// ---------------------------------------------------------------------------

test("load adaptive passes through files within budget with 100% fidelity (Tier 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gem-test-"));
  try {
    const path = join(dir, "shot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]);
    await writeFile(path, bytes);

    const pool = createBudgetPool();
    const result = await loadImageAdaptive(path, pool);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.tier, "passthrough");
      assert.equal(result.image.mimeType, "image/png");
      assert.equal(result.image.data, bytes.toString("base64"));
      assert.equal(result.annotation, null);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load adaptive performs WASM lossless re-encoding when budget requires optimization (Tier 2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gem-test-"));
  try {
    const path = join(dir, "unoptimized-padded.png");
    // Create a 100x100 clean PNG (~1.2KB) padded with 300KB dummy trailing bytes
    const width = 100;
    const height = 100;
    const rawRgba = new Uint8Array(width * height * 4);
    rawRgba.fill(64);
    const cleanPng = await encodePng(rawRgba, width, height);
    const paddedPng = Buffer.concat([cleanPng, Buffer.alloc(300 * 1024)]);
    await writeFile(path, paddedPng);

    // Budget of 50KB: raw 301KB exceeds budget, but Tier 2 lossless optimization reduces it to ~1.2KB
    const pool = createBudgetPool(50 * 1024);
    const result = await loadImageAdaptive(path, pool);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.tier, "lossless");
      assert.equal(result.annotation, null);
      assert.equal(result.image.mimeType, "image/png");
      assert.ok(result.image.data.length > 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load adaptive performs WASM resampling when budget requires downscaling (Tier 3)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gem-test-"));
  try {
    const path = join(dir, "large-highres.png");
    // Generate a 3000x1000 textured image (~12MB raw PNG)
    const width = 3000;
    const height = 1000;
    const rawRgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rawRgba.length; i += 4) {
      rawRgba[i] = (i * 7) % 255;
      rawRgba[i + 1] = (i * 13) % 255;
      rawRgba[i + 2] = (i * 17) % 255;
      rawRgba[i + 3] = 255;
    }
    const pngBytes = await encodePng(rawRgba, width, height);
    await writeFile(path, pngBytes);

    // 1. Budget of 20MB -> fits in Tier 1 passthrough directly
    const largePool = createBudgetPool(20 * 1024 * 1024);
    const passResult = await loadImageAdaptive(path, largePool);
    assert.equal(passResult.ok, true);
    if (passResult.ok) {
      assert.equal(passResult.tier, "passthrough");
    }

    // 2. Tight budget of 10MB -> original ~12MB cannot fit, but 2560px scaled (~8.7MB) fits!
    const tightPool = createBudgetPool(10 * 1024 * 1024);
    const tightResult = await loadImageAdaptive(path, tightPool);
    assert.equal(tightResult.ok, true);
    if (tightResult.ok) {
      assert.equal(tightResult.tier, "downscaled");
      assert.equal(
        tightResult.annotation,
        "(auto-scaled to 2560px to fit Gemini 100MB limit)",
      );
      assert.equal(tightResult.image.mimeType, "image/png");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load adaptive reports unreadable for a missing file (Tier 4)", async () => {
  const pool = createBudgetPool();
  const result = await loadImageAdaptive("/tmp/pi-clipboard-does-not-exist.png", pool);
  assert.deepEqual(result, { ok: false, reason: "unreadable" });
});

test("load adaptive handles oversized files exceeding total budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gem-test-"));
  try {
    const path = join(dir, "oversized.png");
    // Write 101MB dummy payload
    await writeFile(path, Buffer.alloc(101 * 1024 * 1024));

    const pool = createBudgetPool();
    const result = await loadImageAdaptive(path, pool);
    assert.deepEqual(result, { ok: false, reason: "too-large" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// build.ts
// ---------------------------------------------------------------------------

const IMG: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };

test("build replaces paths with [Image #N] labels and transparent annotations", () => {
  const existing: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "ZXhpc3Rpbmc=" }];
  const converted: ConvertedItem[] = [
    { path: CLIP_PATH, label: "[Image #1]", image: IMG, placeholder: "" },
  ];
  const result = buildTransform(`describe ${CLIP_PATH}`, existing, converted);
  assert.ok(result);
  assert.equal(result.text, "describe [Image #1]");
  assert.equal(result.images.length, 2);
  assert.deepEqual(result.images[0], existing[0]);
  assert.deepEqual(result.images[1], IMG);
});

test("build supports transparent annotation labels for downscaled images", () => {
  const converted: ConvertedItem[] = [
    {
      path: CLIP_PATH,
      label: "[Image #1 (auto-scaled to 2560px to fit Gemini 100MB limit)]",
      image: IMG,
      placeholder: "",
    },
  ];
  const result = buildTransform(`analyze ${CLIP_PATH}`, [], converted);
  assert.ok(result);
  assert.equal(
    result.text,
    "analyze [Image #1 (auto-scaled to 2560px to fit Gemini 100MB limit)]",
  );
});

test("build replaces failed paths with placeholder text and keeps numbering", () => {
  const other = `/tmp/pi-clipboard-${"f".repeat(8)}-${"a".repeat(4)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(12)}.png`;
  const converted: ConvertedItem[] = [
    { path: CLIP_PATH, label: "[Image #1]", image: IMG, placeholder: "" },
    {
      path: other,
      label: "[Image #2]",
      image: null,
      placeholder: placeholderTextFor("unreadable"),
    },
  ];
  const result = buildTransform(`${CLIP_PATH} and ${other}`, [], converted);
  assert.ok(result);
  assert.equal(result.text, "[Image #1] and [image omitted: could not be read]");
  assert.equal(result.images.length, 1);
});

test("build returns null when there is nothing to convert", () => {
  assert.equal(buildTransform("plain text", [], []), null);
});

test("placeholderTextFor maps both failure reasons", () => {
  assert.equal(placeholderTextFor("too-large"), TOO_LARGE_PLACEHOLDER);
  assert.equal(placeholderTextFor("unreadable"), UNREADABLE_PLACEHOLDER);
});
