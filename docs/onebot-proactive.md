# 主动开口：为什么必须走 OneBot

## 一句话结论

**QQ 官方机器人不能主动发消息**。想让大肥鱼「自己想起来找你说话」，只能走 **OneBot 个人号协议**（NapCat / LLOneBot）。

---

## QQ 官方为什么不行

官方文档原文（[发送消息](https://bot.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html)）：

> **主动推送能力于 2025 年 4 月 21 日起不再提供，接口调用时会收到错误信息。**

所以「每月 4 条主动消息」那套规则**已经作废**，现在主动推送一律失败。

### 剩下能用的只有被动回复

| 场景 | 有效期 | 每个 `msg_id` 可回复 |
|---|---|---|
| 单聊 | 60 分钟 | 5 次 |
| 群聊 | 5 分钟 | 5 次 |

`msg_id` 是**用户发来的那条消息的 ID**，机器人无法凭空生成。所以：

- ✅ 用户发 1 条 → 机器人 60 分钟内连回 5 条
- ✅ 用户发 1 条 → 机器人隔 30 分钟补一句
- ❌ 用户从没发过 → 机器人先开口
- ❌ 用户 61 分钟前发的 → 现在想说话

### 那「大肥鱼说了很多条」是怎么来的

三种机制叠加的视觉错觉：

1. **流式输出** —— `/v2/users/{openid}/stream_messages`，一条回复分片推送
2. **文本分片** —— `textChunkLimit: 4500`，长回复自动切多条
3. **多 msg_id** —— `msgid-cache.js` 缓存最近 10 条 `msg_id`（私聊 TTL 30 分钟），不同消息各回一次

---

## OneBot 为什么可以

OneBot v11 是**个人 QQ 号**的协议封装（NapCat、LLOneBot、Lagrange 等实现）。它走的是普通 QQ 客户端的行为，**没有「主动推送」这个概念**，所以：

- ✅ 随时 `send_private_msg` 给任何人
- ✅ 没有月配额
- ✅ 支持图片、语音、视频、文件、表情
- ⚠️ 用的是你自己的 QQ 号，有账号风险

---

## 当前状态

`qq` profile 里**已经装了 `dsh-onebot 1.4.0`**：

```json
"bundles": [
  "@tencent-connect/dsh-qqbot",
  "dsh-persona-dafeiyu",
  "dsh-dafeiyu-life",
  "dafeiyu-speak",
  "dsh-onebot"
]
```

但 **OneBot 实现本身没有运行**（NapCat / LLOneBot 都没装），所以现在是空转。

`GET /dafeiyu/onebot` 会探测三个常见端点：

```
http://127.0.0.1:3001   NapCat/LLOneBot 正向 WS
http://127.0.0.1:5700   go-cqhttp HTTP
http://127.0.0.1:3000   NapCat HTTP
```

当前返回：

```json
{ "running": false, "note": "OneBot 未运行。装 NapCat/LLOneBot 并开启 HTTP 或正向 WS 后重试" }
```

---

## 要做什么才能让大肥鱼主动开口

### 1. 装 OneBot 实现

推荐 [NapCat](https://github.com/NapNeko/NapCatQQ)（基于 QQ NT 客户端，活跃维护）。

启动后开启 **HTTP 服务器**（默认 3000）或 **正向 WebSocket**（默认 3001）。

### 2. 配置 dsh-onebot 连上它

在 `qq` profile 的 `cordis.patch.yml` 加：

```yaml
- id: onebot
  name: dsh-onebot
  config:
    transport: forward-ws          # 或 http
    url: ws://127.0.0.1:3001
    respondToPrivate: true
    respondToGroup: true
    groupMentionOnly: true
    userAccessMode: allowlist      # 只响应你自己
    userIds: [你的QQ号]
```

### 3. 主动发送走 `send_private_msg`

`dsh-onebot` 不暴露 service，`client` 是 `apply` 内的局部变量。所以主动发送有两条路：

**A. 直接调 OneBot HTTP API（推荐，最简单）**

```bash
curl -X POST http://127.0.0.1:3000/send_private_msg \
  -H "Content-Type: application/json" \
  -d '{"user_id": 你的QQ号, "message": "本鱼想你了"}'
```

**B. 走 `dsh-onebot` 的 transport**（需改插件源码暴露 service）

---

## 和人格/上下文结合

你要的「仿真人人格 + 情绪 + 上下文，自己决定什么时候开口」，需要三步：

```
1. 触发：定时器 / dafeiyu-life 的 planner
2. 决策：读情绪状态 + 长期记忆 + 最近对话，让模型决定「说什么、要不要说」
3. 发送：走 OneBot send_private_msg
```

`dsh-dafeiyu-life` 里已经有前两步的雏形：

| 配置项 | 作用 | 当前 |
|---|---|---|
| `autonomousPlannerEnabled` | 自主计划（决定何时主动联系） | `false` |
| `autonomousPlannerMinutes` | 计划间隔（分钟） | `90` |
| `autonomousPlannerDailyLimit` | 每日上限 | `3` |
| `socialOutreachEnabled` | 自主分享/回访 | `false` |
| `socialAutoSend` | 是否真的发送 | `false` |
| `emotionSystemEnabled` | 情绪系统 | `true` |

**但它原来的 `sendMessage` 注入走的是 B 站私信/MCP，不是 QQ。** 要让它在 QQ 上主动开口，得把发送端换成 OneBot。

---

## 本插件当前提供的

| 路由 | 状态 |
|---|---|
| `GET /dafeiyu/onebot` | ✅ 探测 OneBot 是否在线 |
| ~~`POST /dafeiyu/proactive`~~ | ❌ 已删除（官方能力已废） |
| `POST /dafeiyu/sticker/send` | ✅ 表情包当图片发（走官方 API，被动通道） |

侧栏「发送」页的「主动开口（OneBot）」卡片会显示 OneBot 在线状态。
