# dsh-dafeiyu-entry

在 **DeepSeek Harness** 设置侧栏加一个「大肥鱼」控制台，把 QQ 大肥鱼主机的状态、聊天记录、机器人配置都搬到桌面端。

> 为什么需要它：原作者的 [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) 只装在 `qq` profile 里，而桌面端跑的是 `desktop` profile —— 两个 profile 互不可见，所以桌面侧栏里从来就没有「QQ 机器人」入口。本插件补上这块，并把宿主侧能力（读会话、改配置、重启主机）一并做了。

---

## 功能

### 概览

| 项 | 说明 |
|---|---|
| 主机状态 | 实时探测 `127.0.0.1:3080`（每 8 秒刷新），绿点呼吸 / 灰点离线 |
| Web UI | 一键打开（自动带 token），或复制完整地址 |
| 机器人名片 | 昵称、QQ 号、**加好友二维码**（手机 QQ 扫了就加） |
| 重启主机 | 关闭 `--profile qq` 进程并重新拉起 |

### 聊天

QQ 主机自己的会话记录 —— 桌面端会话列表读的是 `~/.dsh/sessions`，而 QQ 对话在
`~/.dsh-0.2/sessions`，两个 DSH_HOME 不通，所以那边永远看不到。

- 会话列表（手风琴展开）
- 对话气泡：你说的话右对齐主色气泡，大肥鱼左对齐灰色气泡
- 时间戳、消息条数

技术上要处理 **追加式多帧 zstd**：Node 的 `zstdDecompressSync` 只解第一帧，
`createZstdDecompress()` 遇到第二帧直接抛 `ABORT_ERR`。本插件按 RFC 8878
自己切帧（magic + frame header + 逐 block 走 `last_block/type/size`）再逐帧解压。

### 机器人

原作者插件设置页的全部配置项，直接读写 `qq` profile 的 `cordis.patch.yml`：

| 区块 | 内容 |
|---|---|
| 服务范围 | 私聊 / 群聊：所有人 · 白名单 · 禁用，白名单列表 |
| 基础设置 | 群聊仅 @ 回复、流式输出、显示工具调用结果、调试日志 |
| 模型 | Provider / Model / Preset / 文本分片上限 / 历史条数 |
| 个性化提示词 | 群聊 / 私聊额外 system prompt |

带 dirty 跟踪：改动后才亮「保存配置」，另有「放弃修改」。
写入前自动备份 `cordis.patch.yml.bak-ui`。**AppSecret 不回传前端。**

### 排障

启动命令、日志文件路径、实时日志尾部（等宽可滚动）、数据位置一览。

---

## 安装

```powershell
# 1) 把插件放到 ~/.dsh/plugins/
git clone https://github.com/TomCatV/dsh-dafeiyu-entry.git "$env:USERPROFILE\.dsh\plugins\dsh-dafeiyu-entry"

# 2) 挂进 desktop profile
$p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
$j = Get-Content $p -Raw | ConvertFrom-Json
$j.dependencies | Add-Member -NotePropertyName 'dsh-dafeiyu-entry' `
  -NotePropertyValue "link:$($env:USERPROFILE.Replace('\','/'))/.dsh/plugins/dsh-dafeiyu-entry" -Force
if ($j.dsh.profile.bundles -notcontains 'dsh-dafeiyu-entry') {
  $j.dsh.profile.bundles = @($j.dsh.profile.bundles) + 'dsh-dafeiyu-entry'
}
$j | ConvertTo-Json -Depth 10 | Set-Content $p -Encoding utf8

# 3) 建 junction，让 Node 能解析到
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-dafeiyu-entry" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-dafeiyu-entry"

# 4) 重启 DSH NEXT
```

重启后进 **设置 → 大肥鱼**。

---

## 依赖的外部环境

本插件本身零运行时依赖，但它假设了这些位置存在（可在 `lib/index.js` 顶部常量区改）：

| 常量 | 默认值 | 用途 |
|---|---|---|
| `DSH_HOME_02` | `C:\Users\Vincent\.dsh-0.2` | QQ 大肥鱼主机的隔离 DSH_HOME |
| `QQ_PROFILE_PATCH` | `<home>/profiles/qq/cordis.patch.yml` | 机器人配置与凭据 |
| `QQ_SESSIONS_DIR` | `<home>/sessions` | 聊天记录 |
| `BOOT_LOG` | `C:\Users\Vincent\dsh\tmp\qqboot.log` | 启动日志（解析 token / 绑定码） |
| `WEB_PORT` | `3080` | QQ 主机 Web UI 端口 |

二维码渲染用 `qrcode`，按「插件位置 → profiles → 绝对路径」逐级回落解析
（插件是 junction，Node 按 realpath 解析会找不到 `profiles/node_modules`）。

---

## HTTP 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dafeiyu/status` | 主机在线状态、端口、token URL、绑定态、日志尾部 |
| GET | `/dafeiyu/bind` | 当前绑定链接与绑定态 |
| POST | `/dafeiyu/open` | 用系统默认浏览器打开 Web UI |
| GET | `/dafeiyu/bot` | 机器人名片（昵称 / QQ 号 / share_url / 二维码 SVG） |
| GET | `/dafeiyu/sessions` | 会话列表（含最近对话） |
| GET | `/dafeiyu/config` | 读机器人配置（appSecret 剔除） |
| POST | `/dafeiyu/config` | 白名单合并写入配置 |
| POST | `/dafeiyu/host/restart` | 重启 QQ 主机 |

全部路由过 `connection.requestRejection` 信任栅栏。

---

## 架构

```
lib/index.js    Host 半侧（ESM，零依赖）
                  · 进程/端口探测、日志解析
                  · 多帧 zstd 会话解码
                  · im-qqbot 配置的 YAML 块读写
                  · 二维码生成（qrcode → SVG data URL）
lib/client.js   浏览器半侧（手写 ModuleLoader bundle，无需构建）
                  · 注册 settings.section（id=dafeiyu, order=28）
                  · 四个标签页 + 内联 CSS（__dfy_ 前缀）
```

`client.js` 的 `__ModuleLoader__.load({ id })` **必须等于 package name**
（`dsh-dafeiyu-entry`），否则同一 bundle 会被执行两次并报
`duplicate factory registration`，进而把 web boot 打失败、NEXT 进安全模式。

`apply()` 全程 try/catch：只加一个入口，绝不能因席位契约变化把宿主拖下水。

---

## License

MIT
