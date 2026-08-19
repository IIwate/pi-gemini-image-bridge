# Architecture

System map for the S.U.P.E.R. pipeline. This file owns the module contracts and data-flow
direction; product decisions (relay gate, scope convergence) live in
[decisions.md](./decisions.md) (D8, D14, D16).

## System map

```text
src/index.ts                  Composition root / Pi adapter: registers the request-scoped context relay
src/core/tool-image-relay.ts  Pure: build transient user-attachment views for Responses tool images
test/tool-image-relay.test.ts node:test unit tests over the relay contract
```

No layer depends on Pi. `src/index.ts` owns all host knowledge (`pi.on`, `ctx.model`)
and calls the core module with plain values; the core module knows nothing about Pi.

## Data flow (U)

```
Pi `context` event (request-scoped message copy)
   │  event.messages, ctx.model
   ▼
index.ts  gate: decisions.md D14
           model.id startsWith "gemini" AND model.input includes "image"
           AND model.api is allowlisted (openai-responses, openai-codex-responses,
           cliproxyapi-codex-responses)
   ▼
tool-image-relay.ts ──► new messages view:
                          toolResult text/IDs/error flags intact, image blocks removed,
                          one transient user attachment message appended per
                          consecutive toolResult batch
   ▼
index.ts returns { messages } — Pi's context runner uses this view for the
current request only and never writes it back to the session
```

Direction is strictly input → processing → output. The core module is a pure function
over serializable messages (no Pi imports, no filesystem, no global state).

## Module contracts (P)

All cross-module values are serializable plain data.

### tool-image-relay.ts

```ts
interface ImageModelDescriptor {
  id: string;
  api: string;
  input: readonly string[];
}

// True only for Gemini IDs that declare image input support.
isGeminiImageModel(model?: ImageModelDescriptor): boolean

// True only for the D14 Responses API allowlist.
shouldRelayToolResultImages(model?: ImageModelDescriptor): boolean

// Returns a request-scoped copy: tool-result text/IDs remain in place and images are
// appended once in a temporary user attachment message after each consecutive batch.
relayToolResultImages<T>(messages: readonly T[]): Array<T | RelayedUserMessage>
```

Single responsibility: adapt tool-result image placement for a known provider boundary.
It does not read files, encode Base64, send messages, or mutate the session.

## Environment-agnostic (E)

- No environment variables, no API keys, no filesystem access: the relay is a pure
  function over the request context.
- All dependencies are declared in `package.json` (peerDependency
  `@earendil-works/pi-coding-agent`; devDependencies `typescript`/`@types/node` optional
  for typecheck). Runtime has zero third-party imports.
- Logging: unknown models or APIs fail open silently (decisions.md D14).

## Replaceability (R)

| Replace this | Impact scope | Approach |
|:-------------|:-------------|:---------|
| Responses tool image placement | `tool-image-relay.ts` only | Replace the request-view policy, same serializable message output |
| Pi host API (e.g. RPC transport) | `index.ts` only | New adapter, same gate + relay call |

## Defensive notes

- **Context relay is request-scoped**: D14 operates on Pi's cloned context messages and
  returns a new view. It never appends a session entry, calls `sendUserMessage`, or causes
  an additional model turn. Unknown APIs and models without image input support fail open.
- **Idempotence**: the relay never duplicates Base64 payloads; applying it to its own
  output yields the same view.
- **No input rewriting**: the extension registers no `input` handler. User text,
  clipboard paths, placeholders, and attachments reach Pi exactly as typed (D16).

## Verification strategy

- Tests (`test/tool-image-relay.test.ts`, node:test) cover relay ordering, aggregation,
  image-only placeholder text, idempotence, and the model/API gates with zero Pi
  involvement.
- `src/index.ts` (composition root) is kept thin on purpose; it is exercised by the
  interactive verification in [README.md](../../README.md) rather than unit tests.
