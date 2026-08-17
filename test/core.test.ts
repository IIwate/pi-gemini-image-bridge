/**
 * Core pipeline tests: scan → load → build, each contract exercised with zero
 * Pi involvement (Unidirectional-Flow litmus test). Run with `node --test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanClipboardImagePaths } from "../src/core/scan.ts";
import { MAX_IMAGE_BYTES, loadImage } from "../src/core/load.ts";
import {
  TOO_LARGE_PLACEHOLDER,
  UNREADABLE_PLACEHOLDER,
  buildTransform,
  placeholderTextFor,
  type ConvertedItem,
  type ImageContent,
} from "../src/core/build.ts";

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

test("scan ignores non-clipboard paths and URLs", () => {
  const text = `random /tmp/foo.png and /home/user/pi-clipboard-x.png and https://x/y.png`;
  assert.deepEqual(scanClipboardImagePaths(text, WSL_DROP_DIR), []);
});

test("scan returns empty for text without matches", () => {
  assert.deepEqual(scanClipboardImagePaths("no images here", WSL_DROP_DIR), []);
  assert.deepEqual(scanClipboardImagePaths("", WSL_DROP_DIR), []);
});

test("scan accepts all extensions Pi can drop (png/jpg/webp/gif)", () => {
  const jpg = `/tmp/pi-clipboard-${UUID}.jpg`;
  const webp = `/tmp/pi-clipboard-${UUID}.webp`;
  const gif = `/tmp/pi-clipboard-${UUID}.gif`;
  assert.deepEqual(
    scanClipboardImagePaths(`${jpg} ${webp} ${gif}`, WSL_DROP_DIR),
    [jpg, webp, gif],
  );
});

// ---------------------------------------------------------------------------
// load.ts
// ---------------------------------------------------------------------------

test("load encodes a file as base64 with the correct mime type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gem-test-"));
  try {
    const path = join(dir, "shot.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]));
    const result = await loadImage(path);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.image.mimeType, "image/png");
      assert.equal(
        result.image.data,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]).toString("base64"),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load reports unreadable for a missing file", async () => {
  const result = await loadImage("/tmp/pi-clipboard-does-not-exist.png");
  assert.deepEqual(result, { ok: false, reason: "unreadable" });
});

test("load reports too-large above the byte ceiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gem-test-"));
  try {
    const path = join(dir, "big.png");
    await writeFile(path, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const result = await loadImage(path);
    assert.deepEqual(result, { ok: false, reason: "too-large" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// build.ts
// ---------------------------------------------------------------------------

const IMG: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };

test("build replaces paths with [Image #N] labels and appends images", () => {
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
