# Pi Gemini Image Bridge

A Pi extension that relays tool-result images into the user-attachment channel for
Gemini-family models when a Responses proxy drops nested image blocks.

## Language

**Gemini-Family Models**:
Models whose ID starts with `gemini` and whose `input` metadata includes `image`
(e.g. `gemini-3.7-flash-high`, `gemini-pro-agent`).
_Avoid_: models without declared image input support (when referring specifically to the plugin's target gate)

**Image Bridge**:
The transport capability that moves tool-result images into the user-message channel
accepted by the target Gemini Responses path. It is a transport boundary, not a new
visible user message or model turn.
_Avoid_: image paste, image relay (when referring to the whole system)

**Responses Tool Image Gap**:
The Pi `toolResult` image block → Responses `function_call_output` → Gemini proxy path,
where a proxy such as CLIProxyAPI can drop nested image blocks during translation.
Pi has already produced the image; the gap is at the proxy boundary. Native Google
conversion and verified OpenAI Completions paths are outside this term.
_Avoid_: read tool failure, Pi image loss (when distinguishing the proxy translation gap)

**Tool Image Relay**:
A request-scoped context transformation for allowlisted Responses APIs. It removes
`ImageContent` blocks from consecutive `toolResult` messages, preserves their text and
`toolCallId` pairing, then appends one temporary user message containing the images in
order. It applies to every image-producing tool, not only `read`, and never changes the
stored session.
_Avoid_: sendUserMessage, synthetic user turn (the relay is not a visible message or extra turn)
