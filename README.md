# Pi Gemini Image Bridge

`v0.6.0` - Pi extension that relays tool-result images to Gemini-family models as
user-message attachments across Responses proxies.

## Purpose

Pi's `read` tool already produces native image blocks in `toolResult` messages, and
that path works for Claude, GPT, and native Google Gemini. The remaining gap is the
proxy boundary: a Responses proxy such as CLIProxyAPI translates top-level user
`input_image` parts correctly but can drop images nested in `function_call_output`
items. This extension closes exactly that gap and does nothing else.

The target setup uses `@router-for-me/pi-cliproxyapi-provider` alongside this extension. The
CPA provider extension discovers models, registers the `cliproxyapi-codex-responses` API, and
sends inference through CPA's Codex Responses endpoint. No `models.json` entry is required.
This project only adapts image placement; it does not register CPA models, credentials, or
endpoints.

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

Before each request, a request-scoped `context` handler runs for Gemini models that
declare image input support on the allowlisted Responses APIs:

- `openai-responses`
- `openai-codex-responses`
- `cliproxyapi-codex-responses`

Images from consecutive `toolResult` messages are moved, in order, into one transient
user attachment message. Tool text, names, IDs, and error state remain intact. The
session history and model turn count are unchanged; the relayed view exists only for
the current request. Applying it twice produces the same result.

Everything else is Pi-native. Clipboard pastes, `read` execution, image normalization
(size and downscaling), rewind, resume, and model switching all follow Pi's built-in
behavior; this extension never rewrites user input.

## Verify

```bash
npm test
npm run typecheck
```

For a manual check, ask a CPA-proxied Gemini model to `read` an image file and confirm
the model describes its contents.

## v0.6.0

- Removed the clipboard path-to-attachment pipeline, self-contained
  `[Image #N: filename]` labels, transcript label compaction, rewind/model-switch
  rehydration, and the WASM adaptive encoding pipeline. Pi's native `read` image
  support replaces the whole input track; image size handling follows Pi's native
  normalization. The extension now only performs the Responses tool-image relay.

## Limits

- The relay is allowlisted and does not modify native Google Gemini or OpenAI
  Completions traffic. Unknown models or APIs are left untouched.
- Image data itself is never re-encoded, resized, or budgeted; whatever Pi's native
  pipeline produced is what gets relayed.

See [architecture/index.md](docs/architecture/index.md) for module contracts and data flow,
and [architecture/decisions.md](docs/architecture/decisions.md) for product decisions.

## License

[MIT](LICENSE)
