# pi-gemini-image-paste

A lightweight [Pi](https://github.com/badlogic/pi-mono) extension that enables Gemini-family models to receive pasted clipboard images as user-message attachments, bypassing the broken `read`-tool image path in CPA (CLIProxyAPI).

## Why

1. **`read`-tool images fail upstream**: Google Gemini API does not support images inside `FunctionResponse` (tool outputs). When Gemini calls `read` on an image, the image is ignored upstream and the model hallucinates.
2. **User messages work**: CPA correctly translates `input_image` blocks in user messages into Gemini's `inline_data` format.
3. **Pi paste limitation**: In interactive mode (TUI), pasting an image saves it to `<os.tmpdir()>/pi-clipboard-<uuid>.<ext>` and inserts the raw path text. Submitted prompts are sent as plain text without resolving `@` references, forcing the model into the broken `read` tool.

**This plugin** intercepts interactive input, runs an adaptive 4-tier image pipeline, attaches the processed images directly to the user message, and replaces the paths in text with `[Image #N]`.

## 4-Tier Adaptive Image Pipeline

Designed with **Fidelity-First & Zero Hard-Wall Rejection** principles:

| Tier | Trigger | Behavior | Fidelity |
|---|---|---|---|
| **Tier 1: Fast-Path Passthrough** | ≤ available budget (≤ 50MB) | 0ms direct Base64 encoding without loading WASM | **100% Bit-Level Lossless** |
| **Tier 2: Lossless Optimization** | Budget tight, ≤ 100MB | Lazy-loads in-process WASM to optimize DEFLATE without resolution loss | **100% Bit-Level Lossless** |
| **Tier 3: Fidelity-Guarded Downscale** | High-res images (e.g. 8K) exceeding budget | Lanczos3 downscaling with 2560px/2048px floors to preserve code OCR legibility, transparently annotated | **High-Fidelity Guarded** |
| **Tier 4: Hard Safety Floor** | Destructive files (>100MB) | Replaced with honest omission placeholder, strictly protecting Gemini's 100MB limit | **Safe & Honest** |

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

The path is replaced with `[Image #1]` (or `[Image #1 (auto-scaled to 2560px to fit Gemini 100MB limit)]`), and the image is attached directly to the user message. Non-Gemini models and non-interactive runs (`pi -p`, RPC) pass through untouched.

## Key Boundaries

- **Targeted**: Only activates when `ctx.model.id` starts with `gemini` and `event.source === "interactive"`.
- **Drop files only**: Matches `<os.tmpdir()>/pi-clipboard-<uuid>.{png,jpg,webp,gif}` across both `/` and `\` separators.
- **100MB protection**: Request-level dynamic greedy budget pool strictly prevents payload rejection by the API.
- **Zero runtime dependencies**: Self-contained in-process WASM assets (~200KB) with zero external npm dependencies.

## Architecture

See [docs/architecture/index.md](docs/architecture/index.md) (S.U.P.E.R. modular monolith) and [docs/architecture/decisions.md](docs/architecture/decisions.md) (architecture decisions D1–D11).

## License

[MIT](LICENSE)
