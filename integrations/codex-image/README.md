# Codex CLI 图片 MCP（可选）

为 Claude 或其他 stdio MCP 客户端提供 `image_generate`、`image_edit`、`image_status`。主 Accio API 不会自动安装或启动此模块，也不会自动修改客户端配置。

## 环境与登录

- Node.js 24+。
- 已安装 Codex CLI，能运行 `codex --version` 和 `codex login status`。
- 使用本人有权限的 ChatGPT/Codex 账号；图片生成消耗 Codex 额度。没有自动切换到 OpenAI API Key 的回退。
- 本版在 Windows x64、Codex CLI 0.165.0-alpha.1.2 验证。其他 CLI 版本、macOS 和 Linux 未做本轮实机验收；`app-server` 协议升级可能需要适配。

认证由 Codex CLI 管理。模块不读取、导出或复制 OAuth token，也不会把订阅登录凭据转成通用图片 API Key。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)、[生图与额度说明](https://learn.chatgpt.com/docs/image-generation)。

## 配置

默认无需创建配置文件：`codex` 从 PATH 启动，状态和图片分别写入本模块的 `state/`、`output/`。Node.js 和 Codex 可执行文件都需要对客户端进程可见。

需要自定义时，将 `bridge.example.json` 复制为 `bridge.json`：

```json
{
  "codexBin": "codex",
  "stateDir": "./state",
  "outputDir": "./output",
  "timeoutSeconds": 600
}
```

目录相对于配置文件解析。`codexBin` 也可设为本机 Codex 可执行文件的绝对路径。环境变量 `CODEX_IMAGE_CONFIG` 可指定其他配置文件；实际配置和运行状态不应提交到 Git。

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

## 工具使用

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `image_generate` | `prompt`；可选 `reference_images`、`output_dir` | 立即返回 `job_id` |
| `image_edit` | `prompt`、非空 `reference_images`；可选 `output_dir` | 立即返回 `job_id` |
| `image_status` | `job_id`；可选 `include_image`（默认 true） | 运行状态或最终文件 |

参考图需为本机绝对路径，最多 8 张 PNG/JPEG/WebP。编辑指令应明确修改内容和保留内容。生成可能需要数分钟，提交后约 20 秒再查询，避免连续轮询。

只有状态为 `completed` 且存在实际图片文件，才能向用户报告成功。完成结果包含文件路径、字节数、尺寸；4 MiB 以内的图片还会作为 MCP image 内容返回。更大的图片通过文件路径交付，调用方需另行读取或展示。不要把模型的一句“已生成”当作真实文件。

默认每个任务有独立输出目录；同一连接一次只运行一个任务，输出使用不覆盖模式。任务结果落盘，可在客户端重新连接后继续查询。任务状态会保留提示词、参考图路径和输出路径，应当按个人数据管理；仓库忽略这些文件。

桥接只运行受限的图片任务，关闭 Shell、computer use、浏览器、Apps、多 Agent 及已有外部 MCP 工具。需要交互授权的问题会失败返回，不会自动扩大权限。

本模块交付的是客户端图片工具。它不会自动赋予原生 `/v1/messages` 助手消息任意图片输出能力。要让 claude-accio 读取工具返回的图像，请同时使用主项目 0.3.0 或更新版本。

## 验证与来源

在仓库根目录运行 `npm test`，或单独运行：

```sh
node --test integrations/codex-image/test/*.test.mjs
```

离线测试使用 fake Codex，不生成云端图片，也不使用真实账号。Windows 真实生图、参考图编辑、MCP 内联图片回传及 Claude 经本地网关读图已在受控验证中通过；公开仓库只保留去个人化摘要，不包含图片、账号或原始日志。

核心来自 [qiaomu-codex-imagegen](https://github.com/joeseesun/qiaomu-codex-imagegen) 的 MIT 实现，详见 [LICENSE](LICENSE) 与 [PROVENANCE.txt](PROVENANCE.txt)。本模块没有引入其模板、营销素材或完整 Skill。
