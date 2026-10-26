# CC Switch 每分钟 Accio 额度查询

此配置供每位使用者查询自己的 Accio 当前空间额度。它请求本项目的 `/quota`，以“积分”展示余额；不依赖模型推理，不消耗输出 token。官方额度查询本身仍会产生网络请求。

## 文件

- [accio-usage-query.js](../examples/cc-switch/accio-usage-query.js)：完整查询表达式，可直接粘贴到 CC Switch 的提取器代码区域。
- [usage-script.json](../examples/cc-switch/usage-script.json)：同一表达式及完整查询参数，对应供应商 `meta.usage_script` 对象。它不是完整供应商导出文件，不能作为一张供应商卡片直接导入。

两个文件均没有真实 Key、账号、团队编号、固定余额、用户路径或供应商 ID。`{{apiKey}}` 与 `{{baseUrl}}` 由 CC Switch 使用当前供应商配置填入。地址末尾的 `/v1` 或斜杠会被规范化，因此兼容 Messages 和 Chat Completions 的基础地址，也支持自己的本机端口。

## 在图形界面配置

先在自己的 Mac 安装本项目、完成独立登录，并在 CC Switch 建好自己的 Accio 供应商。

1. 打开对应应用（Claude Code 或 Claude Desktop）的 Accio 卡片，点“更多 → 配置用量查询”。
2. 打开“启用用量查询”，选择“通用模板”。
3. API Key 和请求地址留空，沿用这张 Accio 卡片已有的本地 API 配置。
4. 用 `accio-usage-query.js` 的全部内容替换提取器代码，保留最外层的 `({ ... })`。
5. 超时时间填写 **30 秒**，自动查询间隔填写 **1 分钟**。
6. 点“测试脚本”，确认返回自己空间的订阅信息和积分，再“保存配置”。

如果两个应用都使用 Accio，在两个应用各自的卡片上重复配置。它们展示同一账号空间的余额，不是两个独立额度池，不能相加。可将鼠标悬停在余额上查看总额、已用和更新时间；点击余额可立即重新查询。

自动查询由 CC Switch 执行，按其原生逻辑对使用中的供应商生效。CC Switch 与本地 API 服务需要运行；切换路由、关闭应用、休眠或断网时，不能把“1 分钟配置值”理解成后台持续更新保证。界面上的数字是最近成功查询的快照，不是实时扣费流水。

## 显示与错误处理

- `scope=team` 显示“Accio 团队订阅”，`scope=personal` 显示“Accio 个人订阅”。
- 剩余、已用、总额来自 `/quota` 的 `remainingCredits`、`usedCredits`、`totalCredits`，单位固定为“积分”。
- 余额为零是有效结果；字段缺失、范围不明或数值无效时显示查询失败，不伪造零余额。
- 身份失效、空间无法确认等 API 错误保留明确提示。应在自己的本机修复登录或空间选择。

查询复用本项目已经校验过的官方当前空间，不使用 `userinfo.activeTeam` 推测额度池，也不会自动回退到个人免费池。该配置没有重置日期数据，因此不编造重置倒计时。

高级配置时，只将 `usage-script.json` 的对象合并到该供应商的 `meta.usage_script`，保留其余配置；推荐优先通过图形界面设置。不要覆盖整个数据库或导入其他人的供应商导出。

## 验证边界

在 CC Switch 4.0.15 的 Claude Code 和 Claude Desktop 卡片中已通过原生脚本测试，并确认保存了 1 分钟间隔。分发仅包含通用配置及合成测试；没有导出该验证账号的余额或本机配置。实际定时执行仍由使用者的 CC Switch 环境决定。

[CC Switch 官方用量查询说明（4.0.15）](https://github.com/farion1231/cc-switch/blob/v4.0.15/docs/user-manual/zh/2-providers/2.5-usage-query.md)
