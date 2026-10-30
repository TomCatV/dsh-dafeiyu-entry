# 主动消息 & 表情包

本插件内置两条**绕开 `dsh-qqbot` 、直连 QQ 官方 API** 的通道。不 fork 作者仓库，也不依赖上游同步。

---

## 为什么不用插件自带的

`@tencent-connect/dsh-qqbot` 的 `bot` 实例只在 `gateway/bootstrap.js` 内部创建，**没有对外暴露**。它的 `ReplyLimiter` 注释里写着「限额耗尽应降级为主动消息」，但代码里一处 `sendProactiveMessage` 都没有调用。

表情包更彻底：全库搜 `表情 / emoji / sticker / mface`，**零命中**。

所以这两块只能自己实现。

---

## 主动消息

### 原理

QQ 官方 API 用 `msg_id` 区分两种发送：

| | 带 `msg_id` | 不带 `msg_id` |
|---|---|---|
| 类型 | 被动回复 | **主动推送** |
| 限制 | 几乎无限制 | 有月配额 |
| 用途 | 回应刚收到的消息 | 定时提醒、自主待办通知 |

本插件走后者：

```
POST https://api.sgroup.qq.com/v2/users/{openid}/messages
POST https://api.sgroup.qq.com/v2/groups/{group_openid}/messages
body: { content, msg_type: 0 }        ← 注意：没有 msg_id
```

### 配额保护

官方对主动推送有月配额（一般 4 条/用户/月，视机器人类型）。超了会 403。

本地台账 `<DSH_HOME>/dafeiyu-proactive.json` 按月记账，**保守设为 3 条**，到上限直接拒绝，不去撞 QQ 的墙：

```
POST /dafeiyu/proactive  → 429 { error: "本月主动消息已用 3/3 条" }
```

### openid 从哪来

QQ 不提供「列出会话」的接口，openid 只能从三个地方捞：

| 来源 | 文件 | 何时有 |
|---|---|---|
| 日志扫描 | `<DSH_HOME>/logs/*.log`、`qqboot.log` | 收到过消息就有 |
| model-prefs | `~/.dsh-qqbot/model-prefs.json` | 用过 `/model` 或 `/preset` |
| 持久台账 | `<DSH_HOME>/dafeiyu-peers.json` | 上面任一命中后自动落盘 |

日志扫描的锚点（`dsh-qqbot` 的 `transport/inbound.js:23` 打印）：

```
Processing: scope=c2c peerId=<32位HEX> body="..."
```

`GET /dafeiyu/peers` 会合并三个来源并返回剩余配额。

### 实测

```bash
# 假 openid → 参数格式不对
POST /dafeiyu/proactive {"peerId":"FAKE_OPENID_TEST"}
→ QQ API 404 {"code":11321,"message":"请求Query参数user_id无效"}

# 合法格式但不存在
POST /dafeiyu/proactive {"peerId":"AAAA...(32位)"}
→ QQ API 400 {"code":11255,"message":"请求的资源不存在(用户/群已注销)"}
```

第二个响应证明**接口路径、鉴权、body 全部正确**，只差真实 openid。

---

## 表情包

### QQ 不支持真正的表情包消息

官方 API 只有：文本、Markdown、图片、语音、视频、文件、Ark 卡片、按钮。没有 sticker。

**唯一可行路径：当图片发。**

### 用法

把 `.gif` / `.png` / `.jpg` / `.webp` 丢进：

```
<DSH_HOME>/dafeiyu-stickers/
```

然后：

```
GET  /dafeiyu/stickers               列出所有表情包
POST /dafeiyu/sticker/send           发送
     { "peerId": "...", "scope": "c2c", "name": "whale-happy.png" }
```

发送链路：

```
读文件 → base64 → POST /v2/{users|groups}/{openid}/files
        { file_type: 1, file_data: <base64>, srv_send_msg: false }
        ↓ 拿到 file_info
POST /v2/{users|groups}/{openid}/messages
     { msg_type: 7, media: { file_info }, content: ' ' }
```

`msg_type: 7` 是富媒体消息。`content: ' '` 不能省——QQ 要求 media 消息必须带 content 字段。

---

## 安全边界

- **不发就不写台账**：只有 QQ 返回 200 才 `used + 1`，避免失败也吃配额
- **文件名白名单**：`/^[^/\\]+\.(gif|png|jpg|jpeg|webp)$/i`，挡目录穿越
- **appSecret 只在 Host 侧用**，经 `/dafeiyu/config` 读出来时已剔除
- 所有路由过 `connection.requestRejection` 信任栅栏

---

## 和 `dafeiyu-life` 的自主系统怎么配合

`bili-duty/config.json` 里两项**默认关闭**，开启后才会用到主动消息：

```json
"autonomousPlannerEnabled": false,   // 自主计划（定时主动联系主人）
"socialAutoSend": false              // 社交主动发起
```

这两项归 `dsh-dafeiyu-life` 管，本插件只提供**发送通道**，不做决策。什么时候推、推什么，由 `dafeiyu-life` 的 planner 决定。
