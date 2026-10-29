# Accio / Codex 图片 MCP（可选）

为 Claude 或其他 stdio MCP 客户端提供 `image_generate`、`image_edit`、`image_status`。主 Accio API 不会自动安装或启动此模块，也不会自动修改客户端配置。

## 环境与后端选择

两个后端都需要 Node.js 24+，按本人已有账号选择：

| `backend` | 所需环境 | 额度 |
| --- | --- | --- |
| `accio` | 本项目 0.4.0+ 正在本机运行，已完成本人 Accio 登录 | Accio 图片额度，无需 Codex CLI / 账号 |
| `codex`（默认） | Codex CLI，`codex --version` 和 `codex login status` 正常 | 本人的 Codex 额度 |

Accio 原生图片链路在 Windows x64、Accio 0.36.2 验证；Codex 链路历史验证版本为 CLI 0.165.0-alpha.1.2。macOS 和 Linux 未做本轮实机验收；官方接口升级可能需要适配。失败不会自动重试或切换到另一个后端，没有 OpenAI API Key 计费回退。

Accio 后端仅从本人本机 Key 文件读取本地 API Key，并只发送到回环地址的 Accio Local API；OAuth 仍由主项目管理。Codex 后端的认证由 Codex CLI 管理，模块不读取或复制其 OAuth token。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)、[Codex 生图与额度说明](https://learn.chatgpt.com/docs/image-generation)。

## 配置

保留旧版默认行为：无配置时使用 `codex`，从 PATH 启动，状态和图片分别写入本模块的 `state/`、`output/`。

**只有 Accio 的用户**：把 `bridge.accio.example.json` 复制为 `bridge.json`：

```json
{
  "backend": "accio",
  "accioBaseUrl": "http://127.0.0.1:18437",
  "accioModel": "gpt-image-2",
  "accioResolution": "1K",
  "stateDir": "./state",
  "outputDir": "./output",
  "timeoutSeconds": 360
}
```

默认安装自动查找 Windows `%LOCALAPPDATA%/Accio Local API/state/api.key` 或 macOS `~/Library/Application Support/Accio Local API/api.key`；也可通过 `ACCIO_API_STATE_DIR` 指定状态目录。自定义安装位置时，添加 `accioApiKeyFile`，例如 `C:/path/to/Accio Local API/state/api.key`。填写文件路径，不要复制 Key 内容。`accioBaseUrl` 仅支持 HTTP 回环地址，避免把本人 Key 发送到远程服务。

默认图片模型 `gpt-image-2` 走 Accio 原生网关，消耗 Accio 额度。可选 `accioSize`（如 `1024x1024`）指定尺寸；编辑默认保留上游按参考图处理尺寸的行为。[接口与模型验证范围](../../docs/ACCIO-IMAGES.md)。

**使用 Codex 的用户**：可把 `bridge.example.json` 复制为 `bridge.json`：

```json
{
  "backend": "codex",
  "codexBin": "codex",
  "stateDir": "./state",
  "outputDir": "./output",
  "timeoutSeconds": 600
}
```

目录和 Key 文件路径相对于配置文件解析。`codexBin` 也可设为本机 Codex 可执行文件的绝对路径。环境变量 `CODEX_IMAGE_CONFIG` 可指定其他配置文件；实际配置和运行状态不应提交到 Git。只有选择 Codex 时才需要该可执行文件。

在 MCP 客户端中加入以下条目，将路径换成自己的仓库位置；如果 GUI 客户端找不到 `node`，将 `command` 换成 Node.js 的绝对路径：

```json
{
  "mcpServers": {
    "codex-image": {
      "command": "node",
      "args": ["/absolute/path/to/accio-local-api/integrations/codex-image/src/mcp-server.mjs"]
    }
  }
}
```

Windows 可以使用 `C:/path/to/accio-local-api/integrations/codex-image/src/mcp-server.mjs`。合并到现有配置并重新加载客户端，保留原来的 MCP 条目。

目录和示例 MCP 名 `codex-image` 沿用旧版本以保持兼容；这不限制后端选择。朋友只使用 Accio 时也可以使用同一个登记条目。

## 工具使用

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `image_generate` | `prompt`；可选 `backend`、`reference_images`、`output_dir` | 立即返回 `job_id` 和 `backend` |
| `image_edit` | `prompt`、非空 `reference_images`；可选 `backend`、`output_dir` | 立即返回 `job_id` 和 `backend` |
| `image_status` | `job_id`；可选 `include_image`（默认 true） | 运行状态或最终文件 |

`backend` 可选 `accio` 或 `codex`，省略时使用配置默认值。参考图需为本机绝对路径，最多 8 张 PNG/JPEG/WebP；Accio 参考文件原始数据总计最多 5 MiB。编辑指令应明确修改内容和保留内容。生成可能需要数分钟，提交后约 20 秒再查询，避免连续轮询。

只有状态为 `completed` 且存在实际图片文件，才能向用户报告成功。完成结果包含文件路径、字节数、尺寸；4 MiB 以内的图片还会作为 MCP image 内容返回。更大的图片通过文件路径交付，调用方需另行读取或展示。不要把模型的一句“已生成”当作真实文件。

默认每个任务有独立输出目录；同一连接一次只运行一个任务，输出使用不覆盖模式。任务结果落盘，可在客户端重新连接后继续查询。任务状态会保留提示词、参考图路径和输出路径，应当按个人数据管理；仓库忽略这些文件。

Accio 后端向本机 API 发起一次图片请求，不启动 Codex 或执行其他工具。Codex 后端只运行受限图片任务，关闭 Shell、computer use、浏览器、Apps、多 Agent 及已有外部 MCP 工具。需要交互授权的问题会失败返回，不会自动扩大权限。

本模块交付的是客户端图片工具。它不会自动赋予原生 `/v1/messages` 助手消息任意图片输出能力。要让 claude-accio 读取工具返回的图像，请同时使用主项目 0.3.0 或更新版本。

## 验证与来源

在仓库根目录运行 `npm test`，或单独运行：

```sh
node --test integrations/codex-image/test/*.test.mjs
```

离线测试使用 fake Codex 或模拟 Accio 图片响应，不生成云端图片，也不使用真实账号。Windows 真实 Codex 生图/改图与 Accio 原生生图/改图均取得实际图片；MCP 及 Claude 验证范围见[发布验证](../../docs/RELEASE-VALIDATION.md)。公开仓库只保留去个人化摘要，不包含图片、账号或原始日志。

核心来自 [qiaomu-codex-imagegen](https://github.com/joeseesun/qiaomu-codex-imagegen) 的 MIT 实现，详见 [LICENSE](LICENSE) 与 [PROVENANCE.txt](PROVENANCE.txt)。本模块没有引入其模板、营销素材或完整 Skill。
