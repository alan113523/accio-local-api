# Accio 原生图片接口

从 0.4.0 起，本项目可复用本人 Accio 登录访问原生图片生成和编辑接口。只需要正常运行的 Accio Local API；选择 `accio` 图片后端时无需 Codex CLI、Codex 登录或 OpenAI API Key。生成使用 Accio 图片额度，具体可用模型和计费以当前账号及官方服务为准。

## Claude 中使用

按照 [图片 MCP 文档](../integrations/codex-image/README.md) 登记 stdio 工具，把 `bridge.accio.example.json` 复制为模块内的 `bridge.json`。默认 Windows/macOS 安装可自动定位本机 API Key；自定义安装设置 `accioApiKeyFile`。不要把 Key 内容写到配置或分享给他人。

`image_generate` / `image_edit` 提交异步任务，`image_status` 返回真实图片。`backend: "accio"` 可覆盖默认后端。旧目录名及 MCP 名 `codex-image` 保留兼容，选择 Accio 时不会启动 Codex。

## HTTP 请求

这两个接口使用 `application/json`，返回 OpenAI 风格的 `data` 数组；只实现这里列出的字段，不支持 multipart 上传或完整 OpenAI Images API 参数。鉴权、回环监听、Origin 限制与其他本机接口相同。

`POST /v1/images/generations`：

```json
{
  "model": "gpt-image-2",
  "prompt": "A folded green paper boat on pale blue water",
  "n": 1,
  "resolution": "1K",
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

`POST /v1/images/edits`：

```json
{
  "model": "gpt-image-2",
  "prompt": "Change only the paper boat to red",
  "reference_images": [
    { "mime_type": "image/png", "data": "<actual base64 image bytes>" }
  ],
  "response_format": "b64_json"
}
```

支持参数：`prompt`（必填，最多 30000 字符）、`model`、`n`（仅 1）、`resolution`（`1K` / `2K` / `4K`）、`size`（宽x高）、`aspect_ratio`（如 `1:1`）、`response_format`（默认 `b64_json`，也可显式 `url`）。尺寸与模型组合是否可用由上游决定。编辑必须传 1–8 张 PNG/JPEG/WebP 参考图；不提供尺寸时不会强制裁成正方形。

响应示例：

```json
{
  "created": 0,
  "data": [{ "b64_json": "<actual base64 image bytes>" }],
  "accio": {
    "backend": "accio",
    "requested_model": "gpt-image-2",
    "actual_model": "<upstream model code>",
    "fallback_applied": false,
    "width": 1024,
    "height": 1024
  }
}
```

`actual_model` 与 `fallback_applied` 如实反映 Accio 的结果；本桥接不会跨后端重试。显式请求 `url` 时返回 `{ "url": "..." }`；API 不自动下载远程 URL。默认内联交付缺失时明确失败，避免把一个链接误当作已经取得图片。

## 已验证与限制

- Windows、Accio 0.36.2 的原生 REST 传输及 `gpt-image-2` 已实测生成和参考图编辑。另观察到原生代码 `gemini-3.1-flash-image`、`gemini-3-pro-image`，允许传入，但本轮未做真实生成验收。
- 媒体目录中的 `image_standard`、`image_pro` 等档位 ID 不是这个 REST 传输接受的模型代码；实际请求已验证会拒绝，不能直接混用。
- 主 API 请求体最多 8 MiB；MCP 参考文件原始数据总计最多 5 MiB，最多 8 张，预留 base64 开销。上游响应最多 25 MiB，图片请求超时 360 秒。
- 图片请求可能扣额度。超时、网络断开、上游错误或没有取得图片时，不自动重发；失败不等于上游一定没有生成或扣费，应先检查官方记录再决定是否手动重试。
- 依赖官方非公开接口，客户端或网关升级可能改变行为；macOS 原生图片链路本轮未实机验证。
- 本仓库只包含最小协议适配，不分发官方程序、解包源码、登录凭据、私人图片或原始响应。

实现前检查了 [accio-manager](https://github.com/caidaoli/accio-manager)、[AI-Helper](https://github.com/TF49/AI-Helper)、[accio-proxy](https://github.com/Maicon501a/accio-proxy)：分别存在原生生图参数传输缺口、接入方向不同或只有聊天/图片输入的问题，因此复用本项目已有认证及任务交付能力，增加最小原生图片适配。候选项目的存在不代表它们已接入本项目。
