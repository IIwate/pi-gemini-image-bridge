# Pi Gemini Image Paste

A Pi extension that converts pasted clipboard images into message attachments for
Gemini-family models, bypassing the broken `read`-tool image path in the CPA proxy.

## Language

**Gemini-Family Models**:
Models whose ID starts with `gemini` (e.g. `gemini-3.7-flash-high`, `gemini-pro-agent`).
_Avoid_: Google models, multimodal models (when referring specifically to the plugin's target gate)

**Read-Tool Broken Path**:
The `read` tool → CPA `functionResponse` → Gemini upstream path, where images are
dropped because CPA does not translate them to `inlineData` and Gemini does not
support images inside `FunctionResponse`.
_Avoid_: read tool failure, tool image loss (when distinguishing from user-message attachments)

**Image Passthrough**:
The plugin's core mechanism: converting a pasted clipboard image file path found in
interactive input text into an image attachment on the user message, so the image
travels via the user-message channel (which CPA translates correctly to `inline_data`).
_Avoid_: bypass, workaround (when naming the feature)

**Clipboard Drop File**:
A pasted clipboard image saved to disk by Pi's `handleClipboardPaste`, matching
`<os.tmpdir()>/pi-clipboard-<uuid>.<ext>`. The only image path pattern the plugin converts.
_Avoid_: temp image, screenshot file, clipboard image (when the exact path pattern matters)

**Placeholder Label ([Image #N])**:
The `[Image #1]`-style label that replaces a converted image path in the user's text,
numbered in order of appearance. When an image is downscaled to fit the API limit,
the label becomes transparently annotated (e.g. `[Image #1 (auto-scaled to 2560px to fit Gemini 100MB limit)]`).
_Avoid_: tag, replacement text (when referring to the emitted label in prompts)

**Tiered Adaptive Pipeline**:
The 4-tier progressive degradation ladder for processing clipboard images:
1. Tier 1 (Fast-Path Passthrough): 0ms, 100% bit-level lossless for sizes within budget (≤ 50MB);
2. Tier 2 (Lossless Optimization): In-process WASM lossless re-compression without resolution loss;
3. Tier 3 (Fidelity-Guarded Resampling): Lanczos3 downscaling with hard floors at 2560px/2048px to preserve code OCR clarity;
4. Tier 4 (Hard Safety Floor): Honest placeholder omission to strictly avoid exceeding Gemini's 100MB request limit.
_Avoid_: compression pipeline, image resizing (when referring to the 4-tier decision ladder)

**Dynamic Greedy Budget Pool**:
The total request-level binary budget (~50MB raw binary, ~66.7MB Base64) derived from the 100MB
Gemini API limit minus context safety margins. Multiple images in a single prompt consume
from this pool greedily in order of appearance.
_Avoid_: static budget, image size limit (when referring to the multi-image shared pool)

**Worker Thread Pipeline**:
The dedicated background execution channel powered by Node.js `worker_threads`. Offloads
CPU-intensive WASM compilation, Lanczos3 resampling, and PNG encoding to a background
thread so the main TUI event loop never freezes.
_Avoid_: async execution, background thread (when referring to the dedicated Node.js Worker pool)

**Lazy Spawn & 30s Idle Auto-Reclaim**:
The on-demand worker lifecycle pattern (Piscina standard). The worker thread is only spawned
when a Tier 2/3 task arrives, kept warm for consecutive requests, and automatically terminated
after 30 seconds of inactivity to reclaim all memory.
_Avoid_: eager worker, permanent daemon (when describing thread lifecycle management)

**Session Attachment Cache**:
An in-memory LRU cache that associates emitted placeholder labels (e.g. `[Image #1]`) with
their on-disk clipboard image file paths during the active session. Holds lightweight path
strings only, never keeping large image buffers in memory.
_Avoid_: disk cache, persistent store (when referring to the in-memory label-to-path registry)

**Placeholder Rehydration**:
The reverse-resolution process where existing `[Image #N]` labels present in rewound,
aborted, or history-recalled draft text are restored to valid image attachments by resolving
against the session attachment cache and re-validating the underlying files.
_Avoid_: undo restore, text recovery (when describing placeholder-to-attachment rehydration)

