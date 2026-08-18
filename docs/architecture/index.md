# Architecture

System map for the S.U.P.E.R. pipeline. This file owns the module contracts and data-flow
direction; product decisions (matching scope, size limit, placeholder text) live in
[decisions.md](./decisions.md) (D1–D14).

## System map

```text
src/index.ts       Composition root / Pi adapter (clipboard routing, context relay & rehydration)
src/core/scan.ts   Pure: extract clipboard paths & self-contained placeholder tokens
src/core/budget.ts Pure: request budget with existing-attachment reservation
src/core/load.ts   Pure/I/O: validated 4-tier adaptive image loader
src/core/build.ts  Pure: single-pass regex replacement & honest omission text assembly
src/core/tool-image-relay.ts Pure: build transient user-attachment views for Responses tool images
src/wasm/pool.ts   Worker thread manager (lazy worker spawn on Tier 2/3, 30s idle auto-reclaim, 5s timeout)
src/wasm/protocol.ts Serializable worker request/response contract
src/wasm/worker.js node_modules-safe background worker entry point
src/wasm/engine.js In-worker WASM codecs (zero external npm dependencies)
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
index.ts  gates: model.id startsWith "gemini" AND model.input includes "image"
           AND source === "interactive"
   │  text (unchanged)
   ▼
scan.ts ────────────────► string[]  (clipboard-image paths, in order of appearance)
   │
   │  budget.ts reserves event.images, then allocates the 50MB shared pool
   ▼
load.ts ────────────────► 4-Tier Adaptive Loader:
   │                         Tier 1: Structure-Validated Passthrough (original bytes)
   │                         Tier 2: WASM Lossless Optimization (PNG DEFLATE optimization without resolution loss)
   │                         Tier 3: Fidelity-Guarded Resampling (Lanczos3 down to 2560px/2048px)
   │                         Tier 4: Hard Safety Floor (Honest omission placeholder)
   ▼
build.ts ───────────────► TransformResult { text, images }
   │                        text: paths replaced by [Image #N] / transparent annotations / placeholders
   │                        images: [...event.images, ...converted]
   ▼
index.ts returns { action: "transform", ... }
```

Tool-result image relay (D14) runs on the separate `context` event immediately before
provider conversion. It is enabled only for Gemini image-capable models on the allowlisted
Responses APIs. It scans consecutive `toolResult` messages, retains their text and IDs,
then appends one transient `user` message with the extracted images. The returned view is
request-scoped; Pi's context runner does not write it back to the session.

Direction is strictly input → processing → output. Core modules are pure functions
(no Pi imports, no global state); the only side effect in the pipeline is `load.ts`
reading the filesystem.

## Module contracts (P)

All cross-module values are serializable plain data.

### scan.ts

```ts
// Returns clipboard-image paths found in `text`, in order of appearance.
// Only matches the Pi clipboard drop pattern under the given temp directory
// (decisions.md D3): <dropDir>/pi-clipboard-<uuid>.png|jpg|jpeg|webp|gif, accepting
// both / and \ separators (WSL and Windows hosts). No matches -> empty array.
scanClipboardImagePaths(text: string, dropDir: string): string[]

// Scans text for self-contained placeholder tokens ([Image #N: filename (annotation)])
// and extracts embedded filenames directly for stateless rehydration (decisions.md D13).
scanSelfContainedPlaceholders(text: string): SelfContainedPlaceholderMatch[]

// Extracts filename from path cleanly across POSIX / Windows backslashes.
extractFilename(filePath: string): string
```

Single responsibility: matching and token extraction only. It never reads files and never touches images.

### budget.ts

```ts
export const DEFAULT_MAX_REQUEST_BYTES = 50 * 1024 * 1024; // 50MB raw binary

// Returns the decoded byte length of an unprefixed Base64 payload.
base64DecodedByteLength(data: string): number

export interface BudgetPool {
  readonly totalBytes: number;
  readonly remainingBytes: number;
  allocate(neededBytes: number): BudgetAllocation;
}

// Creates a greedy budget pool after reserving bytes for existing attachments.
createBudgetPool(totalBytes?: number, reservedBytes?: number): BudgetPool
```

Single responsibility: dynamic greedy request-level binary budget calculation (decisions.md D5 & D11).

### load.ts

```ts
interface LoadedImage { type: "image"; mimeType: string; data: string } // data is base64

export type AdaptiveTier = "passthrough" | "lossless" | "downscaled";
export type FailureReason = "too-large" | "budget-exhausted" | "processing-timeout" | "unreadable" | "expired";
export type AdaptiveLoadResult =
  | { ok: true; tier: AdaptiveTier; image: LoadedImage; annotation: string | null }
  | { ok: false; reason: FailureReason };

// Loads an image through the 4-tier adaptive pipeline with background worker offloading.
// Structure-validates passthrough files and returns reason-specific failures for hard limits,
// request budget, timeout, expiration, and unreadable content.
loadImageAdaptive(filePath: string, budgetPool: BudgetPool): Promise<AdaptiveLoadResult>
```

Single responsibility: 4-tier file loading & degradation decision ladder. No text rewriting.

### build.ts

```ts
export interface ConvertedItem {
  target: string;      // path or self-contained token
  label: string;       // [Image #N: filename] with optional transparent annotation
  image: ImageContent | null;
  placeholder: string; // honest omission text when image is null
}

interface TransformResult {
  text: string;      // paths replaced by [Image #N: filename]; failures replaced by placeholder text
  images: ImageContent[]; // [...existingImages, ...converted] (decisions.md D7)
}

// Assembles the final text payload via single-pass regex replacement (preventing prefix
// collisions and double substitution) and merges converted images after existing ones.
buildTransform(originalText: string, existingImages: ImageContent[], converted: ConvertedItem[]): TransformResult | null
```

Single responsibility: assemble the final text/images payload. No file I/O, no scanning.

### tool-image-relay.ts

```ts
interface ImageModelDescriptor {
  id: string;
  api: string;
  input: readonly string[];
}

// True only for Gemini IDs that declare image input support.
isGeminiImageModel(model?: ImageModelDescriptor): boolean

// True only for the D14 Responses API allowlist.
shouldRelayToolResultImages(model?: ImageModelDescriptor): boolean

// Returns a request-scoped copy: tool-result text/IDs remain in place and images are
// appended once in a temporary user attachment message after each consecutive batch.
relayToolResultImages<T>(messages: readonly T[]): Array<T | RelayedUserMessage>
```

Single responsibility: adapt tool-result image placement for a known provider boundary.
It does not read files, encode Base64, send messages, or mutate the session.

### wasm/ (Worker & Engine)

```ts
// Offloads CPU-bound WebAssembly operations to a node_modules-safe JavaScript worker (D12).
processImageInWorker(filePath: string, remainingBytes: number): Promise<WorkerTaskResponse>
```

Single responsibility: lazy worker lifecycle management, 30s idle auto-reclaim, and WASM PNG/Lanczos3 processing.

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
- The Worker runtime graph is native ESM JavaScript so npm-installed packages do not depend on
  Node's unsupported TypeScript stripping inside `node_modules` (decisions.md D12).

## Replaceability (R)

| Replace this | Impact scope | Approach |
|:-------------|:-------------|:---------|
| Matching rules (e.g. accept any image path) | `scan.ts` only | New matcher, same `string[]` output |
| Encoding/size strategy (e.g. add downscaling) | `load.ts` only | New loader, same `ok/err` union |
| Placeholder wording / merge policy | `build.ts` only | New builder, same `TransformResult` |
| Pi host API (e.g. RPC transport) | `index.ts` only | New adapter, same gate + pipeline calls |
| Responses tool image placement | `tool-image-relay.ts` only | Replace the request-view policy, same serializable message output |

## Defensive notes

- **Failure boundary**: `load.ts` never throws; unreadable, expired, hard-limit, budget, and timeout failures become
  placeholder text in `build.ts` (decisions.md D6). The original path must never survive
  in the outgoing text — it would route the model back into the broken `read` path.
- **Gates fail open & Dual-track routing**: when the source is not interactive,
  or the model is not gemini and the prompt contains no placeholder tokens,
  `index.ts` returns `{ action: "continue" }` and the message is untouched (D1–D2).
  When a non-Gemini model encounters self-contained tokens, Track B restores them to
  local file paths without Base64 attachments (D13). The plugin never alters non-target traffic.
- **Context relay is request-scoped**: D14 operates on Pi's cloned context messages and
  returns a new view. It never appends a session entry, calls `sendUserMessage`, or causes
  an additional model turn. Unknown APIs and models without image input support fail open.
- **Merge semantics**: Pi's extension runner replaces `images` when transform
  returns the field (`result.images ?? currentImages`), so `build.ts` must re-include
  `event.images` explicitly (D7). Dropping them would silently detach user images.

## Verification strategy

- Tests (`test/`, node:test) cover matching boundaries, existing-attachment budget reservation,
  validation, all adaptive tiers, Worker replacement isolation, npm `node_modules` startup,
  numbering, merge, placeholder replacement, and D14 tool image relay ordering/idempotence
  with zero Pi involvement.
- `src/index.ts` (composition root) is kept thin on purpose; it is exercised by the
  interactive verification in [README.md](../../README.md) rather than unit tests.
