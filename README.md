# pi-gemini-image-paste

A lightweight [Pi](https://github.com/badlogic/pi-mono) extension that enables Gemini-family models to receive pasted clipboard images as user-message attachments, bypassing the broken `read`-tool image path in CPA (CLIProxyAPI).

## Why

1. **`read`-tool images fail upstream**: Google Gemini API does not support images inside `FunctionResponse` (tool outputs). When Gemini calls `read` on an image, the image is ignored upstream and the model hallucinates.
2. **User messages work**: CPA correctly translates `input_image` blocks in user messages into Gemini's `inline_data` format.
3. **Pi paste limitation**: In interactive mode (TUI), pasting an image saves it to `<os.tmpdir()>/pi-clipboard-<uuid>.<ext>` and inserts the raw path text. Submitted prompts are sent as plain text without resolving `@` references, forcing the model into the broken `read` tool.

**This plugin** intercepts interactive input, runs an adaptive 4-tier image pipeline, attaches the processed images directly to the user message, and replaces the paths in text with self-contained tokens like `[Image #1: pi-clipboard-<uuid>.png]`.

## 4-Tier Adaptive Image Pipeline

Designed with **Fidelity-First & Zero Hard-Wall Rejection** principles:

| Tier | Trigger | Behavior | Fidelity |
|---|---|---|---|
| **Tier 1: Validated Passthrough** | Within available request budget | Lightweight image-structure validation followed by direct Base64 encoding without loading WASM | **Original Bytes Preserved** |
| **Tier 2: Lossless Optimization** | PNG exceeding budget, ≤ 100MB | Lazy-loads WASM in a background Worker to optimize DEFLATE without changing decoded pixels | **Pixel-Lossless** |
| **Tier 3: Fidelity-Guarded Downscale** | High-res PNG images (e.g. 8K) exceeding budget | Lanczos3 downscaling via background Worker with 2560px/2048px floors to preserve code OCR legibility, transparently annotated | **High-Fidelity Guarded** |
| **Tier 4: Hard Safety Floor** | Hard-limit, request-budget, timeout, expired, or unreadable failures | Replaced with a reason-specific omission placeholder | **Safe & Honest** |

## Installation

### Via Pi CLI (Recommended)
```bash
pi install npm:pi-gemini-image-paste
```

### Via `settings.json`
Add to the `packages` array in `settings.json` (`~/.pi/agent/settings.json` on Linux/macOS/WSL, `%USERPROFILE%\.pi\agent\settings.json` on Windows):

```json
{
  "packages": [
    "npm:pi-gemini-image-paste"
  ]
}
```

### From Local Source (Development)
```json
{
  "packages": [
    {
      "source": "/path/to/pi-gemini-image-paste",
      "extensions": ["+src/index.ts"]
    }
  ]
}
```

Restart Pi after configuring.

## Usage

In interactive mode with any Gemini-family model (model ID starting with `gemini`, e.g., `gemini-3.7-flash-high`):

- **Paste image**: Press `Ctrl+V` (Linux/macOS/WSL) or `Alt+V` (Windows). Pi drops the image and pastes the path. Send the message.
- **Or type path**: Enter `<os.tmpdir()>/pi-clipboard-<uuid>.png` directly in your prompt.

The path is replaced with `[Image #1: pi-clipboard-<uuid>.png]` (or `[Image #1: pi-clipboard-<uuid>.png (auto-scaled to 2560px to fit Gemini 100MB limit)]`), and the image is attached directly to the user message. Raw clipboard paths remain untouched for non-Gemini models, and all non-interactive runs (`pi -p`, RPC) pass through unchanged.

When switching to a non-Gemini model (Claude / GPT), any self-contained tokens in rewound prompt history are automatically restored to their physical temp file paths without Base64 payload inflation, protecting non-Gemini API payload limits.

## Verification

### Automated Tests
Run the self-contained test suite (matching, budgets, adaptive loading, Worker replacement, npm installation layout, single-pass build, and stateless rehydration):

```bash
npm test
```

### Typecheck
Verify TypeScript types without emitting:

```bash
npm run typecheck
```

### Interactive Verification
1. **Gemini Paste**: In Pi interactive mode with a Gemini model (e.g. `gemini-3.7-flash-high`), paste an image (`Ctrl+V` or `Alt+V`) and send. Verify the path is replaced with `[Image #1: pi-clipboard-<uuid>.<ext>]` and the model responds with accurate visual recognition.
2. **Model Switching**: Switch to a non-Gemini model (e.g. `claude-3-5-sonnet`) in the same session. Rewind or edit a message containing `[Image #1: ...]` and submit; verify the token is restored to the physical file path without Base64 attachments.

## Key Boundaries

- **Dual-track targeting**: Interactive Gemini input converts raw paths and rehydrates tokens; interactive non-Gemini input only restores self-contained tokens to local paths.
- **Drop files only**: Matches complete `<os.tmpdir()>/pi-clipboard-<uuid>.{png,jpg,jpeg,webp,gif}` paths across both `/` and `\` separators.
- **Request protection**: Existing image attachments and newly converted images share the same 50MB raw-binary budget.
- **Zero runtime dependencies**: Self-contained in-process WASM assets (~200KB) with zero external npm dependencies.

## Known Limits

- Lossless optimization and downscaling are available only for PNG files. Other formats must already fit the remaining request budget.
- Tier 1 performs lightweight structural validation, not a complete decode. Deep corruption in an otherwise well-formed JPEG, WebP, or GIF may still be rejected upstream.
- Rehydration depends on the clipboard drop file still existing in the platform temp directory.

## Architecture

See [docs/architecture/index.md](docs/architecture/index.md) (S.U.P.E.R. modular monolith) and [docs/architecture/decisions.md](docs/architecture/decisions.md) (architecture decisions D1–D13).

## License

[MIT](LICENSE)
