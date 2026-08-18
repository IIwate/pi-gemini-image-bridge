# Pi Gemini Image Bridge

`v0.5.2` - Pi extension for delivering clipboard and tool-result images to Gemini-family
models as user-message attachments.

## Purpose

Pi already represents tool output as image blocks, but a Responses proxy can lose images
nested in tool results. Pi's interactive clipboard flow also inserts a temporary file path
instead of an attachment. This extension bridges those two input forms.

The target setup uses `@router-for-me/pi-cliproxyapi-provider` alongside this extension. The
CPA provider extension discovers models, registers the `cliproxyapi-codex-responses` API, and
sends inference through CPA's Codex Responses endpoint. No `models.json` entry is required.
This project only adapts image placement; it does not register CPA models, credentials, or
endpoints.

A native `google-generative-ai` configuration through `models.json` is a different Pi
integration. It bypasses the Responses relay, but it is not the target path documented here.

## Install

```bash
pi install npm:@router-for-me/pi-cliproxyapi-provider
pi install npm:pi-gemini-image-bridge
```

For a local checkout, add the package to Pi's `settings.json`:

```json
{
  "packages": [
    {
      "source": "/path/to/pi-gemini-image-bridge",
      "extensions": ["+src/index.ts"]
    }
  ]
}
```

Requires Pi `>= 0.84.1`, Node.js `>= 23.6.0`, and a configured CPA provider extension.
Use `/login CLIProxyAPI` (or `/login cliproxyapi`) in Pi to configure the CPA connection.

## Behavior

### Clipboard images

In interactive mode, paste with `Ctrl+V` on Linux/macOS/WSL or `Alt+V` on Windows, then
send the message. A Pi clipboard path such as
`<os.tmpdir()>/pi-clipboard-<uuid>.png` becomes a filename-bearing label and an image
attachment. The stored/model label retains the filename for restart and model-switch
recovery, while the interactive transcript renders it compactly as `[Image #N]` to avoid
long temporary names wrapping onto a separate line.

Only complete Pi clipboard-drop paths with `png`, `jpg`, `jpeg`, `webp`, or `gif` are matched.
Non-interactive input (`pi -p`, RPC) passes through unchanged.

### Responses tool images

The primary target is `cliproxyapi-codex-responses`. The relay is also enabled for these
explicitly allowlisted Responses APIs:

- `openai-responses`
- `openai-codex-responses`
- `cliproxyapi-codex-responses`

Images from consecutive `toolResult` messages are moved, in order, into one transient user
attachment message. Tool text, names, IDs, and error state remain intact. The session history
and model turn count are unchanged.

### Rewind and model switching

Labels contain the source filename, so they remain usable after restart, rewind, resume, and
history recall:

- Gemini models rehydrate the file as an attachment.
- Non-Gemini models restore the local path without Base64 injection.
- Missing temporary files become an explicit omission placeholder.

## Image handling

Images share a 50 MB raw-binary request budget, including existing attachments:

1. Files that fit are validated and passed through without re-encoding.
2. Oversized PNG files up to 100 MB are losslessly optimized in a background Worker.
3. If needed, PNG files are downscaled with 2560 px / 2048 px fidelity floors.
4. Hard-limit, budget, timeout, expired, and unreadable cases become reason-specific
   omission text; the original path is never left in the prompt.

The Worker is lazy, reused for nearby requests, and reclaimed after 30 seconds idle. Codec
WASM assets are bundled; no runtime npm dependencies are required.

## v0.5.2

- Render interactive transcript image labels compactly as `[Image #N]` using Pi's Markdown transformer to prevent terminal line wraps while preserving filenames in session text.

## v0.5.1

- Renamed the package from `pi-gemini-image-paste` to `pi-gemini-image-bridge`.
- Added stateless filename-bearing labels and model-aware recovery across model switches.
- Added the allowlisted Responses tool-image relay.
- Hardened adaptive loading, Worker replacement and timeout handling, npm startup, and
  Windows/WSL path matching.

Existing users must replace `pi-gemini-image-paste` with `pi-gemini-image-bridge` in Pi
package settings.

## Verify

```bash
npm test
npm run typecheck
```

For a manual check, paste an image through Gemini, relay a `read` image through an allowlisted
Responses API, then switch to a non-Gemini model and verify that the label restores to a path.

## Limits

- Clipboard conversion only applies to interactive Gemini input with declared image support.
- The Responses relay is allowlisted and does not modify native Google Gemini or OpenAI
  Completions traffic.
- Adaptive optimization and downscaling apply to PNG; other formats must fit the remaining
  budget.
- Rehydration requires the clipboard temporary file to still exist.

See [architecture/index.md](docs/architecture/index.md) for module contracts and data flow,
and [architecture/decisions.md](docs/architecture/decisions.md) for product decisions.

## License

[MIT](LICENSE)
