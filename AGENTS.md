# AGENTS.md

## 项目概述

opencode 插件：cache-warmer。通过周期性 ping 空闲会话来保持 LLM API prompt cache 不过期。

## 结构

```
.opencode/plugins/cache-warmer.ts    ← 插件主代码（唯一源文件）
.opencode/plugins/cache-warmer.json  ← 运行时配置
.opencode/package.json               ← SDK 依赖 (@opencode-ai/plugin)
opencode.json                        ← 本地 opencode 配置（已 gitignore）
docs/superpowers/                    ← 设计文档和实现计划
```

## 开发须知

- **无构建步骤**：插件由 opencode 直接加载 `.ts` 文件，无需编译
- **无测试/lint**：当前无测试框架或 lint 配置
- **验证方式**：修改后重启 opencode，观察 console 日志 `[cache-warmer]` 前缀输出
- **opencode.json 是本地文件**：已 gitignore，不要提交；里面定义了 `ping` command 供插件使用

## 插件 API

插件使用 `@opencode-ai/plugin` 类型，导出满足 `Plugin` 签名的异步函数。核心 client 方法：

- `client.session.list()` — 列出活跃会话
- `client.session.messages({ path: { id } })` — 获取会话消息
- `client.session.command({ path: { id }, body: { command } })` — 执行命令（如 "ping"）
- `client.session.revert({ path: { id }, body: { messageID } })` — 撤回到指定消息

## 注意事项

- 插件通过 `event` hook 监听 `session.created`、`session.status`、`message.updated`、`session.deleted` 事件
- 竞态保护：ping 期间如果用户发了消息，跳过 revert
- 熔断机制：连续失败 `max_failed_pings` 次后停止 ping 该会话
- 配置从 `worktree/.opencode/plugins/cache-warmer.json` 加载，读取失败则使用默认值
