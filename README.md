# pi-gemini-image-paste

English | [简体中文](README.zh-CN.md)

A Pi extension that enables Gemini-family models to actually see pasted clipboard images in interactive mode, bypassing the broken `read`-tool image path in CPA (cli-proxy-api).

## Background & Root Cause

- **`read`-tool images are dropped upstream**: In CPA's Gemini translator (`buildOpenAIResponsesFunctionResponsePart`), `function_call_output` is forwarded raw inside `functionResponse.response.result` without conversion into Gemini's `inlineData` format. Gemini/antigravity upstream receives raw OpenAI `input_image` JSON objects and ignores them as plain text.
- **Upstream constraint**: The Google Gemini API officially does not support images inside `FunctionResponse` parts. The `read`-tool path cannot be fixed upstream without changing CPA.
- **User-message channel works**: CPA correctly translates `input_image` blocks in `message` turns into `inline_data`, allowing Gemini to see images sent as user-message attachments.
- **Pi's interactive paste mechanism**: `handleClipboardPaste` writes clipboard images to `<os.tmpdir()>/pi-clipboard-<uuid>.<ext>` and inserts the file path as plain text into the editor. When submitted, text is sent via `session.prompt(text)` without `@` reference expansion. As a result, Gemini-family models cannot see any pasted images in interactive mode (paste -> path text -> `read` tool -> dropped).

**This extension**: Intercepts interactive user input and converts clipboard drop paths into user-message image attachments, sending them through the working channel so Gemini models truly receive and understand images.

## Installation

1. Add the package to the `packages` array in your Pi `settings.json` (`~/.pi/agent/settings.json` on Linux/WSL or `%USERPROFILE%\.pi\agent\settings.json` on Windows):

   ```json
   {
     "source": "/path/to/pi-gemini-image-paste",
     "extensions": ["+src/index.ts"]
   }
   ```

   *(Or use `"npm:pi-gemini-image-paste"` once installed from npm)*

2. Restart Pi for changes to take effect.

## Usage

In interactive mode (TUI) when using a Gemini-family model (model ID starting with `gemini`, e.g. `gemini-3.7-flash-high`):

- **Paste image**: Press `Ctrl+V` (WSL/Linux) or `Alt+V` (Windows). Pi drops the image to disk and inserts its path. Send the message.
- **Or type path directly**: Input a clipboard drop path (e.g. `<os.tmpdir()>/pi-clipboard-<uuid>.png`) and prompt the model.

The extension replaces the path text with an `[Image #N]` placeholder and attaches the actual image to the user message. Non-Gemini models (Claude, Codex, GPT series) and non-interactive channels (`pi -p`, RPC) pass through untouched.

## Verification

1. In interactive mode with a Gemini-family model, paste a screenshot or input a clipboard drop path and ask the model to describe it. The model will accurately read the visual content, and the message text will display `[Image #1]`.
2. **Control group**: Using the `read` tool on the same image file will still fail/hallucinate (confirming the upstream tool-call defect).
3. **Development checks**: Run `node --test` (15 unit tests, zero dependencies) and `tsc --noEmit`.

## Known Limitations

- **Gemini-family models only**: Gated by `model.id.startsWith("gemini")`; other models remain unchanged.
- **Clipboard drop files only**: Matches `<os.tmpdir()>/pi-clipboard-<uuid>.{png,jpg,webp,gif}` across both `/` and `\` separators. Arbitrary user-typed image paths are not hijacked.
- **50MB byte ceiling**: Images exceeding 50MB are replaced with an explanatory placeholder (`[image omitted: exceeds 50MB limit]`), staying within Gemini API's 100MB request-body limit after base64 expansion.
- **Placeholder visibility**: `[Image #N]` placeholder text is sent to the model along with the attachment; Gemini handles text-plus-attachment correspondence naturally.

## Architecture

See [docs/architecture/index.md](docs/architecture/index.md) (S.U.P.E.R. modular monolith: composition root + pure core pipeline) and [docs/architecture/decisions.md](docs/architecture/decisions.md) (architecture decisions D1–D8).

## License

[MIT](LICENSE)
