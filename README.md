# opencode-cache-warmer

保持 opencode 活跃会话的 LLM API prompt cache（如 Claude 5 分钟 TTL）不失效。

## 工作原理

插件在内存中追踪活跃会话，周期性检测空闲时间。当某个会话空闲超过阈值（默认 60 分钟），自动发送一条轻量消息迫使 LLM API 命中缓存前缀，随后撤回该条消息以保持对话上下文干净。

```
用户发消息 → 会话记入活跃列表
                  │
         setInterval(每10分钟)
                  │
       空闲 > 阈值? → prompt("hi")
                  │
             等待 AI 回复
                  │
           revert() 撤回整轮
```

## 文件

```
.opencode/plugins/
  cache-warmer.ts          ← 插件代码
  cache-warmer.json        ← 配置文件
```

## 安装

将 `cache-warmer.ts` 和 `cache-warmer.json` 复制到你的 `.opencode/plugins/` 目录：

```bash
# 项目级（仅当前项目生效）
cp cache-warmer.ts .opencode/plugins/
cp cache-warmer.json .opencode/plugins/

# 或全局（所有项目生效）
cp cache-warmer.ts ~/.config/opencode/plugins/
cp cache-warmer.json ~/.config/opencode/plugins/
```

## 配置

`.opencode/plugins/cache-warmer.json`：

```json
{
  "idle_threshold_minutes": 60,
  "check_interval_minutes": 10,
  "ping_message": "hi",
  "max_failed_pings": 3,
  "enabled": true
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `idle_threshold_minutes` | 60 | 会话空闲多久后触发 ping |
| `check_interval_minutes` | 10 | 检测间隔 |
| `ping_message` | `"hi"` | ping 时发送的消息 |
| `max_failed_pings` | 3 | 连续失败多少次后熔断 |
| `enabled` | true | 插件开关 |

## 许可证

MIT
