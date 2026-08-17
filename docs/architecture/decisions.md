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

## D5 — Size ceiling

**Settled**: 50MB byte ceiling (`MAX_IMAGE_BYTES` in `src/core/load.ts`). Oversized
files are replaced with `[image omitted: exceeds 50MB limit]`.

**Why**: base64 inflates payloads ~1.37x, so a 50MB raw file becomes ~68MB of
request body — under Gemini API's official 100MB inline-data limit with headroom. Downscaling was not chosen: it would require an image
library, violating the no-new-dependencies constraint (Codex downscales because it
ships an image crate). The ceiling is defensive; clipboard screenshots are typically
well below 1MB.

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
this file; CONTEXT.md is vocabulary-only. No ADR file (decisions are cheap to reverse,
so they do not meet the ADR bar).

## Superseded

None.
