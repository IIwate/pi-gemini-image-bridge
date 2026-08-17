/**
 * Core pipeline tests: scan → budget → load → build, each contract exercised with zero
 * Pi involvement (Unidirectional-Flow litmus test). Run with `node --test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanClipboardImagePaths,
  scanSelfContainedPlaceholders,
} from "../src/core/scan.ts";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  createBudgetPool,
} from "../src/core/budget.ts";
import {
  MAX_SINGLE_IMAGE_BYTES,
  MAX_HARD_FILE_BYTES,
  loadImageAdaptive,
  type AdaptiveLoadResult,
} from "../src/core/load.ts";
import {
  TOO_LARGE_PLACEHOLDER,
  UNREADABLE_PLACEHOLDER,
  EXPIRED_PLACEHOLDER,
  buildTransform,
  placeholderTextFor,
  type ConvertedItem,
  type ImageContent,
} from "../src/core/build.ts";
import { encodePng } from "../src/wasm/engine.ts";
import { terminateWorkerPool } from "../src/wasm/pool.ts";

const UUID = "11111111-2222-4333-8444-555555555555";
const WSL_DROP_DIR = "/tmp";
const WIN_DROP_DIR = "C:\\Users\\tester\\AppData\\Local\\Temp";
const CLIP_PATH = `/tmp/pi-clipboard-${UUID}.png`;
const CLIP_FILENAME = `pi-clipboard-${UUID}.png`;

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

test("scan finds self-contained placeholder tokens and extracts embedded filenames", () => {
  const fn1 = `pi-clipboard-${UUID}.png`;
  const fn2 = `pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg`;
  const text = `check [Image #1: ${fn1}] and [Image #2: ${fn2} (auto-scaled to 2560px to fit Gemini 100MB limit)]`;

  const results = scanSelfContainedPlaceholders(text);
  assert.equal(results.length, 2);
  assert.equal(results[0].token, `[Image #1: ${fn1}]`);
  assert.equal(results[0].filename, fn1);
  assert.equal(results[1].token, `[Image #2: ${fn2} (auto-scaled to 2560px to fit Gemini 100MB limit)]`);
  assert.equal(results[1].filename, fn2);
  assert.deepEqual(scanSelfContainedPlaceholders("plain text without placeholders"), []);
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

test("load adaptive reports expired for a missing file (Tier 4)", async () => {
  const pool = createBudgetPool();
  const result = await loadImageAdaptive("/tmp/pi-clipboard-does-not-exist.png", pool);
  assert.deepEqual(result, { ok: false, reason: "expired" });
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

test("build replaces targets with self-contained labels and transparent annotations", () => {
  const existing: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "ZXhpc3Rpbmc=" }];
  const converted: ConvertedItem[] = [
    { target: CLIP_PATH, label: `[Image #1: ${CLIP_FILENAME}]`, image: IMG, placeholder: "" },
  ];
  const result = buildTransform(`describe ${CLIP_PATH}`, existing, converted);
  assert.ok(result);
  assert.equal(result.text, `describe [Image #1: ${CLIP_FILENAME}]`);
  assert.equal(result.images.length, 2);
  assert.deepEqual(result.images[0], existing[0]);
  assert.deepEqual(result.images[1], IMG);
});

test("build supports transparent annotation labels for downscaled images", () => {
  const converted: ConvertedItem[] = [
    {
      target: CLIP_PATH,
      label: `[Image #1: ${CLIP_FILENAME} (auto-scaled to 2560px to fit Gemini 100MB limit)]`,
      image: IMG,
      placeholder: "",
    },
  ];
  const result = buildTransform(`analyze ${CLIP_PATH}`, [], converted);
  assert.ok(result);
  assert.equal(
    result.text,
    `analyze [Image #1: ${CLIP_FILENAME} (auto-scaled to 2560px to fit Gemini 100MB limit)]`,
  );
});

test("build replaces failed paths and placeholders with honest notices", () => {
  const other = `/tmp/pi-clipboard-${"f".repeat(8)}-${"a".repeat(4)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(12)}.png`;
  const converted: ConvertedItem[] = [
    { target: CLIP_PATH, label: `[Image #1: ${CLIP_FILENAME}]`, image: IMG, placeholder: "" },
    {
      target: other,
      label: `[Image #2: other.png]`,
      image: null,
      placeholder: placeholderTextFor("unreadable"),
    },
    {
      target: `[Image #3: deleted.png]`,
      label: "",
      image: null,
      placeholder: placeholderTextFor("expired"),
    },
  ];
  const result = buildTransform(`${CLIP_PATH} and ${other} and [Image #3: deleted.png]`, [], converted);
  assert.ok(result);
  assert.equal(
    result.text,
    `[Image #1: ${CLIP_FILENAME}] and ${UNREADABLE_PLACEHOLDER} and ${EXPIRED_PLACEHOLDER}`,
  );
  assert.equal(result.images.length, 1);
});

test("build prevents double substitution and prefix collisions with single-pass replacement", () => {
  // Scenario 1: Prefix collision
  const convPrefix: ConvertedItem[] = [
    { target: "[Image #1: a.png]", label: "[Image #1: a.png-NEW]", image: IMG, placeholder: "" },
    { target: "[Image #10: b.png]", label: "[Image #10: b.png-NEW]", image: IMG, placeholder: "" },
  ];
  const txPrefix = buildTransform("compare [Image #10: b.png] with [Image #1: a.png]", [], convPrefix);
  assert.ok(txPrefix);
  assert.equal(txPrefix.text, "compare [Image #10: b.png-NEW] with [Image #1: a.png-NEW]");

  // Scenario 2: Double substitution
  const convDouble: ConvertedItem[] = [
    { target: CLIP_PATH, label: "[Image #2: new.png]", image: IMG, placeholder: "" },
    { target: "[Image #2: old.png]", label: "[Image #1: old.png]", image: IMG, placeholder: "" },
  ];
  const txDouble = buildTransform(`see ${CLIP_PATH} and [Image #2: old.png]`, [], convDouble);
  assert.ok(txDouble);
  assert.equal(txDouble.text, "see [Image #2: new.png] and [Image #1: old.png]");
});

test("build returns null when there is nothing to convert", () => {
  assert.equal(buildTransform("plain text", [], []), null);
});

test("placeholderTextFor maps failure reasons honestly", () => {
  assert.equal(placeholderTextFor("too-large"), TOO_LARGE_PLACEHOLDER);
  assert.equal(placeholderTextFor("unreadable"), UNREADABLE_PLACEHOLDER);
  assert.equal(placeholderTextFor("expired"), EXPIRED_PLACEHOLDER);
});

// ---------------------------------------------------------------------------
// Integration Simulation: Cross-Session Stateless Rehydration & Model Switching
// ---------------------------------------------------------------------------

test("stateless self-contained rehydration cycle across sessions and model switching", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gem-test-"));
  try {
    const filename = `pi-clipboard-${UUID}.png`;
    const filePath = join(dir, filename);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]);
    await writeFile(filePath, pngBytes);

    // 1. Initial Gemini submission: raw path -> self-contained token
    const initialText = `check ${filePath}`;
    const scanned = scanClipboardImagePaths(initialText, dir);
    assert.deepEqual(scanned, [filePath]);

    const selfContainedLabel = `[Image #1: ${filename}]`;
    const conv1: ConvertedItem[] = [
      { target: filePath, label: selfContainedLabel, image: { type: "image", mimeType: "image/png", data: pngBytes.toString("base64") }, placeholder: "" },
    ];
    const tx1 = buildTransform(initialText, [], conv1);
    assert.ok(tx1);
    assert.equal(tx1.text, `check ${selfContainedLabel}`);

    // 2. Cross-Session / Rewind in Gemini: No in-memory cache! Extract filename directly from token.
    const rewoundText = `re-check ${selfContainedLabel}`;
    const phMatches = scanSelfContainedPlaceholders(rewoundText);
    assert.equal(phMatches.length, 1);
    assert.equal(phMatches[0].filename, filename);

    // Reconstruct physical path statelessly
    const reconstructedPath = join(dir, phMatches[0].filename);
    const loadResult = await loadImageAdaptive(reconstructedPath, createBudgetPool());
    assert.equal(loadResult.ok, true);

    // 3. Model Switch to Claude (Non-Gemini): Restores physical path without Base64 attachments!
    const restoredTextForClaude = rewoundText.replaceAll(phMatches[0].token, reconstructedPath);
    assert.equal(restoredTextForClaude, `re-check ${reconstructedPath}`);

    // 4. File expired / deleted from disk:
    await rm(filePath);
    const expiredLoadResult = await loadImageAdaptive(reconstructedPath, createBudgetPool());
    assert.equal(expiredLoadResult.ok, false);
    assert.equal(expiredLoadResult.reason, "expired");

    const convExpired: ConvertedItem[] = [
      { target: phMatches[0].token, label: "", image: null, placeholder: EXPIRED_PLACEHOLDER },
    ];
    const txExpired = buildTransform(rewoundText, [], convExpired);
    assert.ok(txExpired);
    assert.equal(txExpired.text, `re-check ${EXPIRED_PLACEHOLDER}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleanup worker pool for clean test exit", async () => {
  await terminateWorkerPool();
});
