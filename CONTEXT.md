# Pi Gemini Image Paste

A Pi extension that converts pasted clipboard images into message attachments for
Gemini-family models, bypassing the broken `read`-tool image path in the CPA proxy.

## Language

**gemini 系**:
Gemini-family models (model id starts with `gemini`, e.g. `gemini-3.7-flash-high`).
_Avoid_: 谷歌模型, Gemini models (when referring to the plugin's target set)

**read 链路**:
The `read` tool → CPA `functionResponse` → Gemini upstream path, where images are
dropped because CPA does not translate them to `inlineData` and Gemini does not
support images inside `FunctionResponse`.
_Avoid_: read 工具（单独指工具本身时）, 工具图片链路

**直通（image passthrough）**:
The plugin's mechanism: converting a pasted clipboard image file path found in
interactive input text into an image attachment on the user message, so the image
travels via the user-message channel (which CPA translates correctly).
_Avoid_: 绕过, workaround (when naming the feature)

**剪贴板落盘文件**:
A pasted clipboard image saved to disk by Pi's `handleClipboardPaste`, matching
`/tmp/pi-clipboard-<uuid>.png`. The only image path pattern the plugin converts.
_Avoid_: 临时图片, clipboard image (when the path pattern matters)

**占位符（[Image #N]）**:
The `[Image #1]`-style label that replaces a converted image path in the user's text,
numbered in order of appearance. Mirrors Codex's local-image placeholder convention.
_Avoid_: 标签, placeholder (when referring to the emitted text)
