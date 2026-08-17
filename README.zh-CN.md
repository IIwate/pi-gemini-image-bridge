# pi-gemini-image-paste

[English](README.md) | 简体中文

Pi 扩展：让 gemini 系模型在交互模式真正看到粘贴的图片，绕过 CPA 代理的 read 工具丢图缺陷。

## 背景与根因

- **read 工具结果图片必丢**：CPA（cli-proxy-api）的 gemini 翻译器
  （`buildOpenAIResponsesFunctionResponsePart`）把 `function_call_output` 的 output 原样塞入
  `functionResponse.response.result`，不转 Gemini 的 `inlineData` 格式；Gemini/antigravity
  上游收到的是原始 OpenAI `input_image` 格式，当文本忽略。
- **上游无解**：Google Gemini API 官方不支持 functionResponse 内携带图片，read 工具链路在
  gemini 系无法修复（不修改 CPA）。
- **用户消息通道正常**：CPA 对 user 消息的 `input_image` 正确转 `inline_data`，图片作为
  附件随消息发送时模型能看到。
- **Pi 交互粘贴现状**：`handleClipboardPaste` 把剪贴板图片落盘到
  `/tmp/pi-clipboard-<uuid>.png` 并插入纯路径文本；提交时纯文本发送，不解析 `@`。
  → 交互模式下 gemini 系模型原本无法看任何图片（粘贴→路径→read→丢；read→丢）。

**本插件**：拦截交互输入，把文本中的剪贴板落盘图片路径转换为 user 消息图片附件，图片
走正常通道，模型真正看到图。

## 安装

1. 在 Pi 配置目录的 `settings.json`（WSL：`~/.pi/agent/settings.json`；Windows：`%USERPROFILE%\.pi\agent\settings.json`）的 `packages` 数组追加（已安装时可跳过）：

   ```json
   {
     "source": "/path/to/pi-gemini-image-paste",
     "extensions": ["+src/index.ts"]
   }
   ```

   *(发布到 npm 后亦可使用 `"npm:pi-gemini-image-paste"`)*

2. 重启 pi 生效。

## 用法

交互模式（TUI）下，模型为 gemini 系（`ctx.model.id` 以 `gemini` 开头）时：

- 粘贴图片（WSL/Linux：`Ctrl+V`；Windows：`Alt+V`；Pi 落盘 `/tmp/pi-clipboard-<uuid>.png` 并插入路径），发送消息；
- 或直接输入剪贴板落盘图片路径（如 `/tmp/pi-clipboard-<uuid>.png`）并描述问题。

插件会把路径替换为 `[Image #N]` 占位符，图片以附件形式随消息发送。其他模型（如
claude/codex/gpt 系）与 rpc/`pi -p` 通道行为不变。

## 验证

1. gemini 系模型（如 `gemini-3.7-flash-high`）交互模式粘贴一张截图（或输入剪贴板落盘的 `/tmp/pi-clipboard-<uuid>.png` 路径）并描述问题，模型应读出图片真实内容，消息中路径显示为 `[Image #1]`。
2. 对照组：`read` 工具读同一图片仍失败（read 链路缺陷，插件未触及）。
3. 开发验证：`node --test`（15 个单测，零依赖）、`tsc --noEmit`。

## 已知限制

- 仅 gemini 系模型生效（按 `model.id.startsWith("gemini")` 门控，不校验 provider）。
- 仅匹配剪贴板落盘文件 `<os.tmpdir()>/pi-clipboard-<uuid>.{png,jpg,webp,gif}`（自动适配 WSL `/tmp` 与 Windows 临时目录，`/` 与 `\` 分隔符均可）；手动输入其他图片路径不转换。
- 超过 50MB 的图片无法直通（无缩放能力，受不装依赖约束），替换为占位说明文本。
- `[Image #N]` 占位文本会随消息发给模型（Pi 无 Codex 的标签剥离机制）；gemini 对
  「文本 + 图片附件」对应关系理解良好，可接受。

## 架构

见 [docs/architecture/index.md](docs/architecture/index.md)（S.U.P.E.R 分层：组合根 +
三个纯函数 core 模块）与 [docs/architecture/decisions.md](docs/architecture/decisions.md)
（决策记录 D1–D8）。

## 协议

[MIT](LICENSE)
