# Architecture decisions

Confirmed product decisions for the image-passthrough pipeline. Each decision states
the settled answer and the trade-off it resolves. Product background and usage live in
[README.md](../../README.md); module contracts live in [index.md](./index.md).

## D1 — Model gate

**Settled**: the clipboard attachment track is eligible only when
`ctx.model.id.startsWith("gemini")` and `ctx.model.input.includes("image")`.
The tool image relay has the additional Responses API gate defined by D14.

**Why**: image attachments are invalid for a model that does not declare image input
support. Metadata failures fail open, preserving the existing text-only behavior.
The provider/API distinction belongs to the relay-specific decision rather than the
general clipboard path.

## D2 — Source gate

**Settled**: only `event.source === "interactive"` is processed. rpc/extension sources
and `pi -p` (which resolves `@path` natively) pass through untouched.

**Why**: `sendUserMessage` callers can pass image blocks directly; text-path hacking is
an interactive-UI affordance only. Gates fail open — non-target traffic is never altered.

## D3 — Path matching scope

**Settled**: only complete Pi clipboard drop file paths under the platform temp directory are
converted: `<os.tmpdir()>/pi-clipboard-<uuid>.{png,jpg,jpeg,webp,gif}` (both `/` and `\`
separators accepted; directory substrings and longer extension prefixes are rejected). Pi's paste handler writes those files via
`path.join(os.tmpdir(), ...)` — `/tmp` on WSL/Linux, the user Temp dir on Windows —
and `scan.ts` receives the directory from `os.tmpdir()` at runtime. No other path
or URL is matched.

**Why**: prevents hijacking unrelated image references in prompts, while staying
platform-agnostic (a hardcoded `/tmp` would silently break on Windows hosts).
Trade-off: manually typed arbitrary image paths are not converted (accepted — users
paste or use `pi -p`).

## D4 — Placeholder label

**Settled**: each converted path is replaced in the outgoing text by `[Image #N: <filename>]` (extended/superseded by D13 to be stateless and self-contained, with optional transparent downscaling annotations).

**Why**: the model can correlate the label with the attached image while embedding the filename enables cross-session rehydration and model switching without in-memory state (D13). Pi has no label-stripping step, so the label text reaches the model; gemini handles text-plus-attachment correspondence well.

## D5 — Size ceiling and adaptive budget

**Settled**: 50MB baseline request-level binary ceiling (`DEFAULT_MAX_REQUEST_BYTES`) shared by
existing `event.images` and newly converted images. Existing attachments reserve their decoded
byte length before clipboard images allocate the remainder. Files within budget pass through directly; oversized files trigger the tiered adaptive
pipeline (D9) to attempt lossless re-compression and fidelity-guarded downscaling before
falling back to honest omission placeholders.

**Why**: Base64 inflates raw files ~1.333x, so 50MB raw binary becomes ~66.7MB Base64,
staying well below Gemini API's official 100MB request payload limit while reserving ~33.3MB
for System Prompts, tools, and multi-turn context.

## D6 — Failure handling

**Settled**: every omission uses a reason-specific placeholder: unreadable
(`[image omitted: could not be read]`), expired
(`[image omitted: clipboard temp file expired or missing from disk]`), above the hard file limit
(`[image omitted: exceeds 100MB hard file limit]`), unable to fit the remaining request budget
(`[image omitted: does not fit remaining request image budget]`), or Worker timeout
(`[image omitted: image processing timed out]`). The
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
- **Tier 1 (Validated Passthrough)**: Files within available budget pass lightweight image-structure validation and retain their original bytes without loading WASM.
- **Tier 2 (WASM Lossless Optimization)**: For PNG files exceeding available budget but ≤ 100MB, lazily load WASM codecs to perform pixel-lossless PNG re-encoding without resolution loss. Re-encoding may discard metadata and does not preserve byte identity. Non-PNG formats (JPG/JPEG/WebP/GIF) bypass Tier 2/3 and degrade to the request-budget placeholder if they do not fit.
- **Tier 3 (Fidelity-Guarded Resampling)**: When lossless compression cannot fit into budget (e.g., raw 8K screenshots), downscale using Lanczos3 with strict resolution floors (2560px → 2048px) to preserve code character and punctuation legibility.
- **Tier 4 (Hard Safety Floor)**: Hard-limit, request-budget, timeout, expired, and unreadable failures degrade to reason-specific placeholders. Tier 1 structural validation rejects obviously malformed or truncated files; complete decoding is reserved for PNG files entering Tier 2/3.

**Why**: Coding agents require maximum pixel fidelity for OCR, punctuation, and code token accuracy. Downscaling is reserved strictly as a defense against payload rejection.

## D10 — Self-Contained In-Process WebAssembly Codecs

**Settled**: embed required WebAssembly binary assets and lightweight wrappers directly in `src/wasm/` rather than adding external npm dependencies.

**Why**: avoids npm native-addon compilation issues (`node-gyp`), platform-specific `.node` binary failures, and network download errors during `pi install`. Ensures 100% cross-platform compatibility across Windows, WSL, macOS, and Linux with zero runtime npm dependencies.

## D11 — Dynamic Greedy Budget Pool

**Settled**: maintain a shared request-level binary budget pool (50MB raw binary, corresponding to ~66.7MB Base64 within Gemini's 100MB request limit with 33.3MB context margin). Images in multi-image prompts consume from this pool greedily in order of appearance.

**Why**: users frequently paste a small screenshot (e.g. 2MB popup) alongside a large screenshot (e.g. 40MB IDE window). Static division ($50\text{MB}/N$) would unnecessarily starve large images, while greedy pooling maximizes success rates.

## D12 — Background Worker Thread with Lazy Spawn & 30s Idle Auto-Reclaim

**Settled**: execute CPU-bound WebAssembly operations (PNG decoding, Lanczos3 resampling, and PNG encoding) in a dedicated Node.js `worker_thread` (`src/wasm/worker.js`), managed via an on-demand lifecycle pool (`src/wasm/pool.ts`). The Worker runtime graph uses native ESM JavaScript because Node refuses to strip TypeScript beneath `node_modules`; `src/wasm/protocol.ts` remains the typed serializable contract. The worker is spawned lazily only when a Tier 2/3 task arrives, kept warm for consecutive requests, processes tasks serially, and automatically terminates after 30 seconds of inactivity. Each pending task is owned by its Worker instance so a stale `error` or `exit` event cannot fail replacement-worker tasks. A 5000ms timeout terminates only the owning Worker and emits the processing-timeout result.

**Why**: WASM Lanczos3 resampling and DEFLATE encoding on high-res screenshots (3000px+) consume substantial CPU time. Keeping codec work in a lazily spawned Worker avoids blocking the terminal event loop, adds no Worker startup cost during extension activation, and reclaims Worker memory after 30 seconds idle. The worker processes tasks sequentially to bound peak memory usage.

## D13 — Stateless Self-Contained Placeholder Tokens & Model-Aware Dual-Track Routing

**Settled**: embed the clipboard image filename directly into emitted placeholder tokens (`[Image #N: pi-clipboard-<uuid>.<ext>]`). When rewound, resumed, or history-recalled input text contains these tokens:
1. **Gemini Track**: statelessly extracts the embedded filename, reconstructs `<tmpdir>/<filename>`, and re-injects top-level Base64 image attachments through the shared 50MB request-budget pipeline;
2. **Non-Gemini Track (Claude / GPT / Local)**: seamlessly restores `[Image #N: filename]` back to the local file path `<tmpdir>/<filename>` without any Base64 attachments (strictly protecting Claude's 5MB API limit and letting non-Gemini models use their native `read` tool);
3. **Expired Files**: if the temp file was evicted by OS cleanup, safely emits `[image omitted: clipboard temp file expired or missing from disk]`.

**Why**: memory caches are lost upon Pi process restarts or cross-session `/resume` commands, turning anonymous `[Image #1]` into dead strings. Embedding filenames creates an entirely stateless, durable contract that survives restarts, crosses sessions, seamlessly accommodates model switching, and protects external model API boundaries.

## D14 — Responses Tool Image Relay

**Settled**: before a request is sent, the `context` handler creates a transient view for
Gemini models that declare `input` support for images and use a known Responses API:
`openai-responses`, `openai-codex-responses`, or
`cliproxyapi-codex-responses`. It scans each consecutive batch of `toolResult` messages,
extracts every `ImageContent` regardless of the tool name, and removes those image blocks
from the corresponding tool results while retaining their text, `toolCallId`, tool name,
error flag, and other metadata. After the batch it appends one temporary `user` message
containing a text marker and all extracted images in their original order. Image-only tool
results receive `(see attached image)` so the Responses function output remains valid.

The original session messages are never changed. The handler does not call
`sendUserMessage`, add a visible message, or trigger another model turn; applying it twice
produces the same view and never duplicates Base64 payloads.

**Why**: Pi already creates image blocks for `read` and other image-producing tools, and
its native Google converter has a supported path for those blocks. The affected
CLIProxyAPI Responses translation can lose images nested in `function_call_output`, while
top-level user `input_image` parts survive. Reusing the proven user-attachment channel
fixes that proxy boundary without coupling the extension to CLIProxyAPI's internal JSON.
OpenAI Completions and native Google Gemini traffic are outside this relay gate.

**Trade-off**: the relay is intentionally allowlisted to known Responses API identifiers.
An unrecognized proxy API, a non-Gemini model, or a model without image input support is
left untouched until it is explicitly verified.

## D15 — Compact Transcript Labels

**Settled**: keep the full self-contained token (`[Image #N: filename]`, including any
downscaling annotation) in the transformed text sent to the model and stored in the
session, but register a Pi Markdown transformer that renders it as `[Image #N]` in the
interactive transcript. The display transform applies only to user messages and does not
alter provider payloads or rehydration input.

**Why**: temporary clipboard filenames are long enough to wrap onto a separate line in
the terminal, making an otherwise inline image attachment look like a broken or truncated
text block. Pi explicitly supports display-only Markdown transformers, so the visual label
can be shortened without weakening D13's stateless recovery contract.

**Trade-off**: the filename is no longer visible in the rendered transcript. It remains
available in the stored message and can be recovered by rewinding or switching models.





## Superseded

- **D4 (Anonymous `[Image #N]` label)**: extended by D13 into stateless self-contained placeholder tokens (`[Image #N: filename]`) to support cross-session rehydration and non-Gemini path restoration.
