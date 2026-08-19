# Architecture decisions

Confirmed product decisions. Each decision states the settled answer and the trade-off
it resolves. Product background and usage live in [README.md](../../README.md); module
contracts live in [index.md](./index.md).

## D8 — Documentation

**Settled**: README.md owns background/usage/verification/limits; decisions live in
this file; CONTEXT.md is vocabulary-only.

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

## D16 — Convergence to the Pi-native input path

**Settled**: the entire input-stage clipboard pipeline is removed. The extension's only
runtime behavior is the D14 relay. Clipboard pastes, image loading, size limits,
downscaling, placeholder labels, transcript compaction, and rewind/model-switch
rehydration all follow Pi's native behavior; the extension registers no `input` handler
and no Markdown transformer.

**Why**: Pi's `read` tool now natively produces image toolResults for every model, so a
user who pastes an image path can simply let the model `read` it. That made the parallel
paste-conversion track (matching temp paths, Base64 loading, budget pools, WASM codecs,
worker threads, dual-track rehydration) a second product pipeline for one input form.
There is no current large-image use case justifying an enhancement track either — image
size and normalization are Pi's own contract. Deleting the track removes the maintenance
burden, the uncertainty around proxy payload limits, and the risk of the extension's
placeholders drifting from Pi's behavior on rewind and model switching.

**Trade-off**: interactive clipboard pastes revert to Pi-native behavior — the pasted
temp path stays in the message text, and models that cannot resolve it natively rely on
the `read` tool. If a real large-image or paste-attachment need reappears, it should be
redesigned against Pi's current pipeline instead of resurrecting the removed code.

## Retracted by D16

The following decisions governed the removed input pipeline; their full history lives in
git (`v0.5.2`). They are kept here as one-line records only.

- **D1 — Model gate**: clipboard track eligible only for Gemini IDs with declared image
  input.
- **D2 — Source gate**: only `event.source === "interactive"` input was processed.
- **D3 — Path matching scope**: only complete Pi clipboard drop paths under `os.tmpdir()`
  were converted.
- **D4 — Placeholder label** (superseded by D13): anonymous `[Image #N]` labels.
- **D5 — Size ceiling and adaptive budget**: 50MB shared raw-binary request budget.
- **D6 — Failure handling**: reason-specific omission placeholders; the original path
  never survived in outgoing text.
- **D7 — Image merge semantics**: transform results re-included `event.images` explicitly.
- **D9 — Tiered adaptive pipeline**: 4-tier passthrough/lossless/downscale/omission ladder.
- **D10 — Self-contained in-process WASM codecs**: bundled WASM binaries instead of npm
  image dependencies.
- **D11 — Dynamic greedy budget pool**: greedy multi-image allocation under the shared
  ceiling.
- **D12 — Background worker thread**: lazy-spawned, 30s-idle-reclaimed worker for codec
  work.
- **D13 — Stateless self-contained tokens & dual-track routing**: filename-bearing tokens
  with Gemini re-injection and non-Gemini path restoration.
- **D15 — Compact transcript labels**: Markdown transformer rendering `[Image #N: filename]`
  as `[Image #N]` in the interactive transcript.
