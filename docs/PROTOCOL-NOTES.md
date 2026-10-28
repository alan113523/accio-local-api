# Accio 接入协议研究

这些记录来自客户端行为分析与受控的合成请求，不包含官方客户端源码、反编译产物或个人运行数据。

## 可复现的调用链

`兼容客户端 → 可选 CC Switch → 本项目独立 API → Accio 模型网关`

本项目的独立登录使用官方 PKCE 流程：`https://www.accio.com/login`、`/api/oauth/token` 和 `/api/auth/refresh_token`。推理与目录的网关域名为 `https://phoenix-gw.alibaba.com`。

| 操作 | 网关路径 | 关键行为 |
|---|---|---|
| 核对独立登录账号 | `/api/auth/userinfo` | 与官方当前空间元数据中的账号匹配 |
| 实时模型目录 | `/api/llm/config/v2` | 读取可见且未锁定型号；不使用静态回退 |
| 空间订阅额度 | `/api/entitlement/currentSubscription` | 区分 TEAM 与 INDIVIDUAL，团队同时带 teamId 与 x-team-id |
| 模型生成 | `/api/adk/llm/generateContent` | 使用实时 modelCode，auto_model=false，SSE 返回 |

OAuth client ID、官方客户端公共 appKey、固定域名和原生模块相对位置是协议常量，不是任何使用者的秘密。它们随协议改变时可能需要重新适配。真实 token、签名、Cookie、账号标识和设备标识只在运行时产生，不随源码分发。

## 空间与额度池

`userinfo.activeTeam` 不足以代表官方客户端当前选中的空间。即使该值为 null，客户端仍可能使用团队订阅。当前实现读取 `~/.accio/state/current-space.json` 的 kind/accountId/teamId，校验与独立 OAuth 的身份一致，再构造团队请求。

此前的错误路径遗漏了团队请求头，导致请求落到个人免费池。修复后分别查询所选空间的订阅；账号或空间无法确认时失败，不静默换池。此处不保留任何真实账号、团队编号或积分数。

## 型号与客户端身份

客户端菜单名、客户端身份提示词、网关实际请求型号和云端原始事件是不同的观测点。若用 Sonnet 角色别名代表 Opus，客户端可能附带 Sonnet 身份提示词。本项目不重写这些提示词；应在 CC Switch / 客户端配置中使用匹配的真实型号别名。

目录的 `modelCode` 是 Accio 的不透明路由标识，不等于 Anthropic 型号 ID。本地兼容响应的 model 和 `x-accio-model-id` 由本项目生成，只能证明本地映射。

## 原始云端型号字段

生产请求使用 `properties.normalized_response="true"`。该模式下观测到的原始事件片段通常只包含正文增量和结束事件，未必保留初始型号字段。

只在独立诊断请求中改为 `normalized_response="false"` 后，可以在 `raw_response_json` 中观察 `message_start.message.model`。这是 Accio 网关返回的云端型号声明，证据强于本地别名，但仍不是由使用者独立获得的厂商后台证明。

2026-10-18 的受控测试中，10 个 Claude 型号都成功返回合成问题的答案，原始型号字段均与所选型号对应。Haiku 4.5 返回 `claude-haiku-4-5-20251001`，符合官方文档中的别名解析。部分响应含 `amazon-bedrock-invocationMetrics`，支持使用或透传 Bedrock 响应的推断；没有该字段时不能据此判断渠道。

本项目没有访问 Accio 云端内部路由表、厂商调用后台或云端隐藏提示词，也不将模型自述当作型号证明。短算术请求是可达性与字段检查，不是模型能力基准。

## 提示词边界

本地代码仅转发调用方的系统指令，不加载官方 Agent 的技能、记忆或任务规划上下文。原生请求中的 `include_thoughts=false` 控制返回内容，不等于关闭模型推理。客户端自己的提示词与 Accio 云端行为需要分别看待。

## 参考

0.3.0 的图片输入沿用本地协议的 `inline_data` / `file_data`，工具图片置于对应函数结果旁保留像素。原生聊天图片响应暂不交付，使用明确错误代替静默忽略。

可选 Codex 图片模块另行通过 `codex app-server` 的 `imageGeneration` 完成事件及 `savedPath` 获取文件，不接管 Accio 登录或模型路由；协议见 [Codex App Server](https://learn.chatgpt.com/docs/app-server)，源码来源与许可证见模块目录。

- [Claude Opus 5.5 官方型号](https://platform.claude.com/docs/en/models/opus-5-5/overview)
- [Haiku 4.5 官方型号与别名](https://platform.claude.com/docs/en/models/haiku-4-5/overview)
- [AWS 官方 Bedrock 监控与流式指标](https://aws.amazon.com/cn/blogs/china/amazon-bedrock-monitoring-logging-practices/)
- [Accio Agent Core 上下文设计](https://www.accio.com/wow/doc-agent-core-design.html)
- [CC Switch](https://github.com/farion1231/cc-switch)
- [REA](https://github.com/morluto/rea)：可辅助本机 Electron 或原生程序分析，本项目不依赖它运行。
