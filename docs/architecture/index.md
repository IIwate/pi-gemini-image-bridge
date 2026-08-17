# Architecture

System map for the S.U.P.E.R. pipeline. This file owns the module contracts and data-flow
direction; product decisions (matching scope, size limit, placeholder text) live in
[decisions.md](./decisions.md) (D1–D8).

## System map

```text
src/index.ts       Composition root / Pi adapter (only file touching the extension API)
src/core/scan.ts   Pure: extract clipboard-image paths from input text
src/core/load.ts   Pure: read file -> base64 + mimeType, enforce size limit
src/core/build.ts  Pure: assemble transform payload (placeholder text + merged images)
test/              node:test unit tests over the core contracts
```

No layer depends on Pi. `src/index.ts` owns all host knowledge (`pi.on`, `ctx.model`,
`event.source`, `event.images`) and calls core modules with plain values; core modules
know nothing about Pi.

## Data flow (U)

```
Pi input event
   │  text, images, source, ctx.model
   ▼
index.ts  gates: model.id startsWith "gemini" AND source === "interactive"
   │  text (unchanged)
   ▼
scan.ts ────────────────► string[]  (clipboard-image paths, in order of appearance)
   │
   │  per path
   ▼
load.ts ────────────────► ok: { mimeType, data } | err: "too-large" | "unreadable"
   │
   ▼
build.ts ───────────────► TransformResult { text, images }
   │                        text: paths replaced by [Image #N] / placeholder text
   │                        images: [...event.images, ...converted]
   ▼
index.ts returns { action: "transform", ... }
```

Direction is strictly input → processing → output. Core modules are pure functions
(no Pi imports, no global state); the only side effect in the pipeline is `load.ts`
reading the filesystem.

## Module contracts (P)

All cross-module values are serializable plain data.

### scan.ts

```ts
// Returns clipboard-image paths found in `text`, in order of appearance.
// Only matches the Pi clipboard drop pattern under the given temp directory
// (decisions.md D3): <dropDir>/pi-clipboard-<uuid>.png|jpg|webp|gif, accepting
// both / and \ separators (WSL and Windows hosts). No matches -> empty array.
scanClipboardImagePaths(text: string, dropDir: string): string[]
```

Single responsibility: matching only. It never reads files and never touches images.

### load.ts

```ts
interface LoadedImage { mimeType: string; data: string } // data is base64 (no data: prefix)

// Reads `path` and encodes it as base64. Rejects when the file exceeds
// MAX_IMAGE_BYTES (50MB, decisions.md D5) or cannot be read.
// Errors are data, not exceptions: callers branch on `ok`.
loadImage(path: string): { ok: true; image: LoadedImage } | { ok: false; reason: "too-large" | "unreadable" }
```

Single responsibility: file → base64 with the size gate. No text rewriting.

### build.ts

```ts
interface TransformResult {
  text: string;      // paths replaced by [Image #N]; failures replaced by placeholder text
  images: ImageContent[]; // [...existingImages, ...converted] (decisions.md D7)
}

// existingImages come from event.images; matches are scan+load results.
// Returns null when there is nothing to convert (caller continues unchanged).
buildTransform(text: string, existingImages: ImageContent[], loaded: { path: string; result: LoadImageResult }[]): TransformResult | null
```

Single responsibility: assemble the final text/images payload. No file I/O, no scanning.

## Environment-agnostic (E)

- No environment variables, no API keys: the extension is stateless by nature.
- The only path assumptions are the clipboard drop directory (`scan.ts` receives it
  from `os.tmpdir()` at runtime, decisions.md D3) and the size limit (`load.ts`
  constant, decisions.md D5) — both are declared product decisions, documented in
  decisions.md, not scattered literals.
- All dependencies are declared in `package.json` (peerDependency
  `@earendil-works/pi-coding-agent`; devDependencies `typescript`/`@types/node` optional
  for typecheck). Runtime has zero third-party imports.
- Logging: no user-facing notification on failure (decisions.md D6); core modules stay silent.

## Replaceability (R)

| Replace this | Impact scope | Approach |
|:-------------|:-------------|:---------|
| Matching rules (e.g. accept any image path) | `scan.ts` only | New matcher, same `string[]` output |
| Encoding/size strategy (e.g. add downscaling) | `load.ts` only | New loader, same `ok/err` union |
| Placeholder wording / merge policy | `build.ts` only | New builder, same `TransformResult` |
| Pi host API (e.g. RPC transport) | `index.ts` only | New adapter, same gate + pipeline calls |

## Defensive notes

- **Failure boundary**: `load.ts` never throws; unreadable/oversized files become
  placeholder text in `build.ts` (decisions.md D6). The original path must never survive
  in the outgoing text — it would route the model back into the broken `read` path.
- **Gates fail open**: when the model is not gemini or the source is not
  interactive, `index.ts` returns `{ action: "continue" }` and the message is
  untouched (D1–D2). The plugin must never alter non-target traffic.
- **Merge semantics**: Pi's extension runner replaces `images` when transform
  returns the field (`result.images ?? currentImages`), so `build.ts` must re-include
  `event.images` explicitly (D7). Dropping them would silently detach user images.

## Verification strategy

- Unit tests (`test/`, node:test) cover the three core contracts: match/no-match,
  size gate, read failure, numbering, merge, and placeholder replacement — with
  zero Pi involvement (U litmus test).
- `src/index.ts` (composition root) is kept thin on purpose; it is exercised by the
  interactive verification in [README.md](../../README.md) rather than unit tests.
