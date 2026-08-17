# Architecture decisions

Confirmed product decisions for the image-passthrough pipeline. Each decision states
the settled answer and the trade-off it resolves. Product background and usage live in
[README.md](../../README.md); module contracts live in [index.md](./index.md).

## D1 — Model gate

**Settled**: only `ctx.model.id.startsWith("gemini")` triggers the pipeline; provider is
not checked.

**Why**: the read-tool image loss is a Gemini-upstream limitation (functionResponse
cannot carry images), independent of which proxy serves the model. Restricting by id
keeps the gate narrow and predictable.

## D2 — Source gate

**Settled**: only `event.source === "interactive"` is processed. rpc/extension sources
and `pi -p` (which resolves `@path` natively) pass through untouched.

**Why**: `sendUserMessage` callers can pass image blocks directly; text-path hacking is
an interactive-UI affordance only. Gates fail open — non-target traffic is never altered.

## D3 — Path matching scope

**Settled**: only Pi clipboard drop files under the platform temp directory are
converted: `<os.tmpdir()>/pi-clipboard-<uuid>.{png,jpg,webp,gif}` (both `/` and `\`
separators accepted). Pi's paste handler writes those files via
`path.join(os.tmpdir(), ...)` — `/tmp` on WSL/Linux, the user Temp dir on Windows —
and `scan.ts` receives the directory from `os.tmpdir()` at runtime. No other path
or URL is matched.

**Why**: prevents hijacking unrelated image references in prompts, while staying
platform-agnostic (a hardcoded `/tmp` would silently break on Windows hosts).
Trade-off: manually typed arbitrary image paths are not converted (accepted — users
paste or use `pi -p`).

## D4 — Placeholder label

**Settled**: each converted path is replaced in the outgoing text by `[Image #N]`,
numbered in order of appearance. Mirrors Codex's local-image placeholder convention.

**Why**: the model can correlate the label with the attached image. Pi has no
label-stripping step, so the label text reaches the model; gemini handles
text-plus-attachment correspondence well (accepted).

## D5 — Size ceiling and adaptive budget

**Settled**: 50MB baseline request-level binary ceiling (`DEFAULT_MAX_REQUEST_BYTES`).
Files within budget pass through directly; oversized files trigger the tiered adaptive
pipeline (D9) to attempt lossless re-compression and fidelity-guarded downscaling before
falling back to honest omission placeholders.

**Why**: Base64 inflates raw files ~1.333x, so 50MB raw binary becomes ~66.7MB Base64,
staying well below Gemini API's official 100MB request payload limit while reserving ~33.3MB
for System Prompts, tools, and multi-turn context.

## D6 — Failure handling

**Settled**: unreadable or oversized files become placeholder text
(`[image omitted: could not be read]` / `[image omitted: exceeds 50MB limit]`); the
original path never survives in the outgoing text. No notification is shown.

**Why**: keeping the path would route the model back into the broken read path (the
very defect this plugin bypasses). Placeholder text is honest and predictable,
mirroring Codex's `image_preparation.rs` error placeholders. Silent-failure risk is
low because the user sees the placeholder in the echoed message.

## D7 — Image merge semantics

**Settled**: the transform re-includes `event.images` explicitly and appends converted
images after them.

**Why**: Pi's extension runner applies `result.images ?? currentImages` — returning the
field replaces, not merges. Omitting `event.images` would silently detach images
attached by other means.

## D8 — Documentation

**Settled**: README.md owns background/usage/verification/limits; decisions live in
this file; CONTEXT.md is vocabulary-only.

## D9 — Tiered Adaptive Image Pipeline (Fidelity First)

**Settled**: structure image processing as a 4-tier progressive degradation ladder:
- **Tier 1 (Fast-Path Passthrough)**: Files within available budget (≤ 50MB) pass through directly (0ms overhead, 100% bit-level lossless).
- **Tier 2 (WASM Lossless Optimization)**: For files exceeding single budget but ≤ 100MB, lazily load in-process WASM codecs to perform lossless WebP/PNG optimization without resolution loss.
- **Tier 3 (Fidelity-Guarded Resampling)**: When lossless compression cannot fit into budget (e.g., raw 8K screenshots), downscale using Lanczos3 with strict resolution floors (2560px → 2048px) to preserve code character and punctuation legibility.
- **Tier 4 (Hard Safety Floor)**: Destructive/unsupported/corrupted files safely degrade to `[image omitted: ...]` rather than crashing the Gemini API with a >100MB payload.

**Why**: Coding agents require maximum pixel fidelity for OCR, punctuation, and code token accuracy. Downscaling is reserved strictly as a defense against payload rejection.

## D10 — Self-Contained In-Process WebAssembly Codecs

**Settled**: embed required WebAssembly binary assets and lightweight wrappers directly in `src/wasm/` rather than adding external npm dependencies.

**Why**: avoids npm native-addon compilation issues (`node-gyp`), platform-specific `.node` binary failures, and network download errors during `pi install`. Ensures 100% cross-platform compatibility across Windows, WSL, macOS, and Linux with zero runtime npm dependencies.

## D11 — Dynamic Greedy Budget Pool

**Settled**: maintain a shared request-level binary budget pool (50MB raw binary, corresponding to ~66.7MB Base64 within Gemini's 100MB request limit with 33.3MB context margin). Images in multi-image prompts consume from this pool greedily in order of appearance.

**Why**: users frequently paste a small screenshot (e.g. 2MB popup) alongside a large screenshot (e.g. 40MB IDE window). Static division ($50\text{MB}/N$) would unnecessarily starve large images, while greedy pooling maximizes success rates.


## Superseded

None.
