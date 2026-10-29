/**
 * dsh-dafeiyu-entry — Host 半侧
 *
 * 职责：给浏览器半侧的「大肥鱼」设置页提供两条只读 + 一条操作的 HTTP 接口。
 *
 *   GET  /dafeiyu/status   探测 QQ 大肥鱼主机（~/.dsh-0.2）是否在跑、端口、绑定链接、最近日志
 *   GET  /dafeiyu/bind     只取最新的 QQ 绑定链接（会从启动日志里解析 task_id）
 *   POST /dafeiyu/open     在系统默认浏览器里打开 QQ 主机的 Web UI
 *
 * 设计要点：
 *  · 不注入任何 DSH 服务 —— 只做进程/文件探测，profile 缺什么都不会让插件挂掉。
 *  · webServer 拿不到时（桌面端可能用 file:// + IPC）静默降级，不炸 fiber。
 *  · 所有路由都过一遍 connection.requestRejection 信任栅栏，防跨站读写。
 */

const ROUTE_BASE = '/dafeiyu'

export const name = 'dsh-dafeiyu-entry'

/**
 * 必须声明 `webServer` —— cordis 的服务代理在未注入时读 `ctx.webServer` 会直接抛
 * "cannot get property \"webServer\" without inject"，把整颗 fiber 打成 failed。
 * 声明后等宿主把 webServer 起好；万一某个 profile 没有它，fiber 停在 pending
 * 等待而不是崩，客户端半侧仍能显示静态说明。
 */
export const inject = ['webServer']

/** QQ 大肥鱼主机的固定落点（由 C:\dsh-0.2\start-qq-dafeiyu.cmd 决定）。 */
const DSH_HOME_02 = 'C:\\Users\\Vincent\\.dsh-0.2'
const BOOT_LOG = 'C:\\Users\\Vincent\\dsh\\tmp\\qqboot.log'
const WEB_PORT = 3080
/** QQ 机器人凭据落在 qq profile 的 patch 里（扫码绑定时由 dsh-qqbot 写入）。 */
const QQ_PROFILE_PATCH = DSH_HOME_02 + '\\profiles\\qq\\cordis.patch.yml'

/* ── 机器人配置读写 ──────────────────────────────────────────────────────
 *
 * 原作者的插件（@tencent-connect/dsh-qqbot）只装在 **qq profile** 里，
 * 桌面端用的是 **desktop profile** —— 两个 profile 互不可见，所以他的
 * 「QQ 机器人」侧栏入口在桌面端根本不存在。这里把配置能力搬过来：
 * 直接读写 qq profile 的 cordis.patch.yml 中 `- id: im-qqbot` 那一块，
 * 改完提示重启 QQ 主机生效。
 */

/** 作者插件支持、且 UI 可写的键（对齐其 bind-routes 的 EDITABLE_CONFIG_KEYS） */
const QQ_WRITABLE_KEYS = [
  'requireMention',
  'streaming',
  'showToolResults',
  'debug',
  'provider',
  'model',
  'preset',
  'groupPrompt',
  'directPrompt',
  'textChunkLimit',
  'historyLimit',
  'maxQueue'
]

/** 作者插件的出厂默认值（其 cordis.patch.yml 里写的那份） */
const QQ_DEFAULTS = {
  requireMention: true,
  streaming: true,
  showToolResults: false,
  debug: false,
  provider: '',
  model: '',
  preset: '',
  groupPrompt: '',
  directPrompt: '',
  textChunkLimit: 4500,
  historyLimit: 10,
  maxQueue: 20,
  access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] }
}

/** 读 qq profile patch 全文（读不到返回空串） */
async function readQqPatch() {
  try {
    const fs = await import('node:fs/promises')
    return await fs.readFile(QQ_PROFILE_PATCH, 'utf8')
  } catch {
    return ''
  }
}

/** 从 patch 文本里切出 `- id: im-qqbot` 那一块 */
function imQqbotBlock(lines) {
  const start = lines.findIndex((l) => /^-\s*id:\s*im-qqbot\s*$/.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s*id:/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/** 标量 → YAML 值（字符串加单引号，布尔/数字裸写） */
function yamlScalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  if (s === '') return "''"
  return "'" + s.replace(/'/g, "''") + "'"
}

/** 解析 im-qqbot 块里的已知键 */
function parseImQqbot(lines, block) {
  const cfg = {}
  for (let i = block.start + 1; i < block.end; i++) {
    const m = /^\s{4}([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const raw = m[2].trim()
    if (raw === '') continue
    let val = raw
    if (raw === 'true') val = true
    else if (raw === 'false') val = false
    else if (/^\d+$/.test(raw)) val = Number(raw)
    else val = raw.replace(/^'(.*)'$/, '$1').replace(/''/g, "'")
    cfg[m[1]] = val
  }
  const access = {}
  for (let i = block.start + 1; i < block.end; i++) {
    if (!/^\s{4}access:\s*$/.test(lines[i])) continue
    for (let j = i + 1; j < block.end && /^\s{6}/.test(lines[j]); j++) {
      const mm = /^\s{6}([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(lines[j])
      if (!mm) continue
      const raw = mm[2].trim()
      if (raw === '[]') access[mm[1]] = []
      else if (raw === '') access[mm[1]] = ''
      else if (raw === 'true') access[mm[1]] = true
      else if (raw === 'false') access[mm[1]] = false
      else access[mm[1]] = raw.replace(/^'(.*)'$/, '$1')
    }
  }
  if (Object.keys(access).length > 0) cfg.access = access
  return cfg
}

/** 读当前生效配置（出厂默认 ← patch 覆盖） */
async function readQqConfig() {
  const text = await readQqPatch()
  const lines = text.split(/\r?\n/)
  const block = imQqbotBlock(lines)
  const fromPatch = block ? parseImQqbot(lines, block) : {}
  const merged = { ...QQ_DEFAULTS, ...fromPatch }
  merged.access = { ...QQ_DEFAULTS.access, ...(fromPatch.access || {}) }
  return { config: merged, hasBlock: block !== null, patchPath: QQ_PROFILE_PATCH }
}

/** 白名单合并写入，返回写后的完整配置 */
async function writeQqConfig(partial) {
  const fs = await import('node:fs/promises')
  const text = await readQqPatch()
  const lines = text.split(/\r?\n/)
  const block = imQqbotBlock(lines)
  const current = block ? parseImQqbot(lines, block) : {}

  const next = { ...current }
  for (const key of QQ_WRITABLE_KEYS) {
    if (!Object.hasOwn(partial || {}, key)) continue
    const v = partial[key]
    if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') next[key] = v
  }
  if (partial && typeof partial.access === 'object' && partial.access !== null) {
    const a = { ...(current.access || {}) }
    for (const k of ['c2cMode', 'groupMode']) {
      const v = partial.access[k]
      if (v === 'open' || v === 'allowlist' || v === 'off') a[k] = v
    }
    if (Array.isArray(partial.access.c2cAllow)) a.c2cAllow = partial.access.c2cAllow.map(String)
    if (Array.isArray(partial.access.groupAllow)) a.groupAllow = partial.access.groupAllow.map(String)
    next.access = a
  }

  const out = ['- id: im-qqbot', '  config:']
  if (typeof next.appId === 'string' && next.appId !== '') {
    out.push('    appId: ' + yamlScalar(next.appId))
  }
  if (typeof next.appSecret === 'string' && next.appSecret !== '') {
    out.push('    appSecret: ' + yamlScalar(next.appSecret))
  }
  for (const key of QQ_WRITABLE_KEYS) {
    if (!Object.hasOwn(next, key)) continue
    const v = next[key]
    if (typeof v === 'string' && v === '') continue // 空串 = 继承宿主，不落盘
    out.push(`    ${key}: ${yamlScalar(v)}`)
  }
  const acc = next.access || QQ_DEFAULTS.access
  const list = (arr) =>
    Array.isArray(arr) && arr.length > 0 ? '[' + arr.map((x) => yamlScalar(x)).join(', ') + ']' : '[]'
  out.push('    access:')
  out.push(`      c2cMode: ${yamlScalar(acc.c2cMode || 'open')}`)
  out.push(`      c2cAllow: ${list(acc.c2cAllow)}`)
  out.push(`      groupMode: ${yamlScalar(acc.groupMode || 'open')}`)
  out.push(`      groupAllow: ${list(acc.groupAllow)}`)

  let replaced
  if (block) {
    replaced = [...lines.slice(0, block.start), ...out, ...lines.slice(block.end)]
  } else {
    const trimmed = lines.filter((l, i) => !(i === lines.length - 1 && l === ''))
    replaced = [...trimmed, ...out, '']
  }
  let body = replaced.join('\n')
  if (!body.endsWith('\n')) body += '\n'

  try {
    await fs.copyFile(QQ_PROFILE_PATCH, QQ_PROFILE_PATCH + '.bak-ui')
  } catch {
    /* 首次可能没有源文件 */
  }
  await fs.writeFile(QQ_PROFILE_PATCH, body, 'utf8')
  return readQqConfig()
}

/** QQ 会话存储：<home>/sessions/<cwd 哈希>/<session-id>/session.v4.jsonl.zstd */
const QQ_SESSIONS_DIR = DSH_HOME_02 + '\\sessions'

/* ── 聊天记录 ────────────────────────────────────────────────────────────
 *
 * 这里读的是 **QQ 主机自己的 DSH_HOME**（~/.dsh-0.2），不是桌面端的 ~/.dsh。
 * 两个 home 的 sessions 目录互不相通，所以桌面端会话列表里永远看不到 QQ 对话
 * ——这正是「聊天记录找不到」的原因。QQ 侧插件的源码里也没有任何
 * 聊天记录界面（grep 聊天记录/会话列表/transcript 全空），它只管绑定与配置。
 *
 * 会话文件是 zstd 多帧压缩的 JSONL；Node 22 的 zlib 自带 zstd，
 * 用 stream 解压才能跨帧拿到完整内容。
 */

/**
 * 把一个多帧 zstd 缓冲区切成若干单帧。
 *
 * 为什么必须自己切：Node 22 的 `zstdDecompressSync` 只解**第一帧**就停，
 * `createZstdDecompress()` 在第二帧直接抛 ABORT_ERR。而 DSH 的
 * `session.v4.jsonl.zstd` 是「追加式多帧」—— 每条事件一帧，
 * 只解第一帧等于只拿到 session 头部那一行（实测 183 字符 / 2 行）。
 *
 * 帧结构（RFC 8878）足够简单，按规范走一遍就能精确算出每帧长度：
 *   magic(4) + frame_header(2..14) + blocks + [checksum(4)]
 * 每个 block 头 3 字节 LE：last_block(1) | block_type(2) | block_size(21)
 */
function splitZstdFrames(buf) {
  const frames = []
  let off = 0
  while (off + 4 <= buf.length) {
    if (
      buf[off] !== 0x28 ||
      buf[off + 1] !== 0xb5 ||
      buf[off + 2] !== 0x2f ||
      buf[off + 3] !== 0xfd
    ) {
      // 不是帧头：跳到下一个可能的 magic（容错，避免整段失败）
      const next = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off + 1)
      if (next < 0) break
      off = next
      continue
    }
    const start = off
    let p = off + 4
    if (p >= buf.length) break
    const fhd = buf[p]
    p += 1
    const fcsFlag = (fhd >> 6) & 0x03
    const singleSegment = (fhd >> 5) & 0x01
    const checksumFlag = (fhd >> 2) & 0x01
    const dictIdFlag = fhd & 0x03

    if (!singleSegment) p += 1 // Window_Descriptor
    p += [0, 1, 2, 4][dictIdFlag]
    p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]

    // 走完所有 block
    let ok = false
    while (p + 3 <= buf.length) {
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
      p += 3
      const last = h & 1
      const type = (h >> 1) & 0x03
      const size = h >>> 3
      if (type === 0) p += size // Raw
      else if (type === 1) p += 1 // RLE
      else if (type === 2) p += size // Compressed
      else return frames // 保留块类型：目录到此为止
      if (p > buf.length) break
      if (last) {
        ok = true
        break
      }
    }
    if (!ok) break
    if (checksumFlag) p += 4
    if (p > buf.length) break
    frames.push(buf.subarray(start, p))
    off = p
  }
  return frames
}

/** 解压一个 session.v4.jsonl.zstd（多帧 zstd）为文本 */
async function decodeSessionFile(file) {
  const fs = await import('node:fs/promises')
  const zlib = await import('node:zlib')
  const buf = await fs.readFile(file)
  const frames = splitZstdFrames(buf)
  if (frames.length === 0) return ''
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(frame).toString('utf8'))
    } catch {
      /* 单帧坏了就跳过，别丢整段 */
    }
  }
  return parts.join('')
}

/** 从会话 JSONL 里抽出标题与最近若干条对话 */
function summarizeSession(text, limit = 6) {
  let title = ''
  const msgs = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const type = obj.type || ''
    const data = obj.data || {}
    if (type === 'session/title' && !title) {
      title = String(data.title || '')
      continue
    }
    if (type === 'user/message') {
      const parts = (data.content || [])
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
      const body = parts.join(' ').replace(/\s+/g, ' ').trim()
      if (!body) continue
      // 跳过运行时注入，只留真人说的话
      if (
        body.includes('runtime context') ||
        body.startsWith('Time sampled') ||
        body.startsWith('<system-reminder>') ||
        body.includes('A skill is a reusable set of task-specific instructions')
      ) {
        continue
      }
      msgs.push({ role: 'user', text: body.slice(0, 500) })
      continue
    }
    if (type === 'assistant/message') {
      const content = (data.message && data.message.content) || []
      const body = content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!body) continue
      msgs.push({ role: 'assistant', text: body.slice(0, 500) })
    }
  }
  return { title, msgs: msgs.slice(-limit) }
}

/** 列出 QQ 主机的会话（标题 / 时间 / 最近几条对话） */
async function listQqSessions(limit = 8) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const out = []

  let groups = []
  try {
    groups = await fs.readdir(QQ_SESSIONS_DIR, { withFileTypes: true })
  } catch {
    return out
  }

  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(QQ_SESSIONS_DIR, group.name)
    let sessions = []
    try {
      sessions = await fs.readdir(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const dir = path.join(groupDir, s.name)
      const candidates = [
        path.join(dir, 'session.v4.jsonl.zstd'),
        path.join(dir, 'session.v3.jsonl.zstd'),
        path.join(dir, 'session.jsonl.zstd')
      ]
      let file = ''
      let mtime = 0
      let size = 0
      for (const c of candidates) {
        try {
          const st = await fs.stat(c)
          if (st.size > 0) {
            file = c
            mtime = st.mtimeMs
            size = st.size
            break
          }
        } catch {
          /* 试下一个 */
        }
      }
      if (!file) continue
      let summary = { title: '', msgs: [] }
      try {
        summary = summarizeSession(await decodeSessionFile(file))
      } catch {
        /* 解不开就只给元数据 */
      }
      out.push({
        id: s.name,
        cwd: group.name,
        title: summary.title,
        msgs: summary.msgs,
        mtime,
        size
      })
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
}

/* ── 机器人名片（名字 / QQ 号 / 加好友二维码）─────────────────────────────
 *
 * 为什么要 Host 侧做：二维码在宿主生成，客户端 bundle 保持零第三方依赖，
 * 与 @tencent-connect/dsh-qqbot 的 setup/qr-svg.ts 同一策略（它用 `qrcode`）。
 *
 * 解析 `qrcode` 有个坑：本插件是 junction 到 `profiles/desktop/node_modules` 的，
 * Node 按 realpath（`~/.dsh/plugins/dsh-dafeiyu-entry`）解析，向上找不到
 * `profiles/node_modules`。所以按「插件位置 → profiles → 绝对路径候选」逐级回落。
 */
const QRCODE_CANDIDATES = [
  'qrcode',
  'C:\\Users\\Vincent\\.dsh\\profiles\\node_modules\\qrcode\\lib\\index.js',
  'C:\\Users\\Vincent\\.dsh\\profiles\\desktop\\node_modules\\qrcode\\lib\\index.js'
]

let qrCodeModule
async function loadQrCode() {
  if (qrCodeModule !== undefined) return qrCodeModule
  const { createRequire } = await import('node:module')
  const bases = [import.meta.url]
  try {
    if (process.argv[1]) bases.push(process.argv[1])
  } catch {
    /* 无 argv */
  }
  for (const base of bases) {
    for (const cand of QRCODE_CANDIDATES) {
      try {
        const req = createRequire(base)
        const mod = req(cand)
        qrCodeModule = mod && typeof mod.toString === 'function' ? mod : mod?.default
        if (qrCodeModule && typeof qrCodeModule.toString === 'function') return qrCodeModule
      } catch {
        /* 试下一个 */
      }
    }
  }
  qrCodeModule = null
  return null
}

/** 从 qq profile patch 里读 QQ 机器人凭据（appId / appSecret）。 */
async function readQqCredentials() {
  try {
    const fs = await import('node:fs/promises')
    const text = await fs.readFile(QQ_PROFILE_PATCH, 'utf8')
    const block = /-\s*id:\s*im-qqbot[\s\S]{0,600}?(?=\n-\s*id:|\s*$)/.exec(text)
    const scope = block ? block[0] : text
    const appId = /appId:\s*['"]?(\d{5,})['"]?/.exec(scope)?.[1] ?? ''
    const appSecret = /appSecret:\s*['"]?([A-Za-z0-9_-]{8,})['"]?/.exec(scope)?.[1] ?? ''
    return { appId, appSecret }
  } catch {
    return { appId: '', appSecret: '' }
  }
}

/** 机器人名片缓存：access_token 有效期约 12 分钟，share_url 基本不变。 */
const botCache = { at: 0, value: null }
const BOT_CACHE_MS = 10 * 60 * 1000

/**
 * 取机器人自身信息：昵称、QQ 号（robot_uin）、加好友分享链接，并渲染成二维码。
 * 任何一步失败都降级返回，不让设置页整块挂掉。
 */
async function resolveBotCard(force = false) {
  const now = Date.now()
  if (!force && botCache.value && now - botCache.at < BOT_CACHE_MS) return botCache.value

  const { appId, appSecret } = await readQqCredentials()
  const card = {
    ok: false,
    appId,
    name: '',
    robotUin: '',
    shareUrl: '',
    qr: '',
    error: ''
  }

  if (!appId || !appSecret) {
    card.error = '未在 qq profile 里找到 QQ 机器人凭据（appId / appSecret）'
    botCache.value = card
    botCache.at = now
    return card
  }

  try {
    const tokenRes = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret })
    })
    const tokenJson = await tokenRes.json()
    const token = tokenJson?.access_token
    if (!token) throw new Error('getAppAccessToken 未返回 access_token')

    const meRes = await fetch('https://api.sgroup.qq.com/users/@me', {
      headers: { Authorization: 'QQBot ' + token, 'X-Union-Appid': appId }
    })
    if (!meRes.ok) throw new Error('users/@me HTTP ' + meRes.status)
    const me = await meRes.json()

    card.name = typeof me?.username === 'string' ? me.username : ''
    card.shareUrl = typeof me?.share_url === 'string' ? me.share_url : ''
    const uinMatch = /robot_uin=(\d+)/.exec(card.shareUrl)
    card.robotUin = uinMatch ? uinMatch[1] : ''

    if (card.shareUrl) {
      const QRCode = await loadQrCode()
      if (QRCode) {
        const svg = await QRCode.toString(card.shareUrl, { type: 'svg', margin: 1, width: 240 })
        card.qr = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
      } else {
        card.error = '二维码渲染库 qrcode 不可用，仅提供链接'
      }
    }
    card.ok = !!card.shareUrl
  } catch (err) {
    card.error = String(err && err.message ? err.message : err)
  }

  botCache.value = card
  botCache.at = now
  return card
}

function resolveWebServer(ctx) {
  try {
    return ctx.webServer
  } catch {
    return undefined
  }
}

function hasRoutes(server) {
  return !!server && typeof server.register === 'function' && typeof server.tapIndex === 'function'
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length)
  })
  res.end(body)
}

export function apply(ctx) {
  const disposers = []
  const webServer = resolveWebServer(ctx)

  if (!hasRoutes(webServer)) {
    try {
      ctx.logger?.warn?.(
        '[' + name + '] 当前 profile 没有可用的 webServer；「大肥鱼」设置页将只显示静态说明。'
      )
    } catch {
      /* 日志失败不影响加载 */
    }
    return
  }

  function rejected(req, res) {
    try {
      const conn =
        (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return false
    }
  }

  function registerRoute(route) {
    const inner = route && route.handler
    const wrapped = Object.assign({}, route, {
      handler: async (req, res) => {
        if (rejected(req, res)) return
        return inner(req, res)
      }
    })
    return webServer.register(wrapped)
  }

  /** 读启动日志尾部（可能很大，只取最后 64KB）。 */
  async function readBootTail(bytes = 64 * 1024) {
    const fs = await import('node:fs/promises')
    let fh
    try {
      const st = await fs.stat(BOOT_LOG)
      const start = Math.max(0, st.size - bytes)
      fh = await fs.open(BOOT_LOG, 'r')
      const buf = Buffer.alloc(Math.min(bytes, st.size))
      await fh.read(buf, 0, buf.length, start)
      return buf.toString('utf8')
    } catch {
      return ''
    } finally {
      try {
        if (fh) await fh.close()
      } catch {
        /* ignore */
      }
    }
  }

  /** 从启动日志里解析当前有效的绑定链接和 token 化的 Web URL。 */
  async function parseBootLog(text) {
    const tasks = [...text.matchAll(/connect\.html\?task_id=([0-9a-f-]{36})/g)]
    const bindUrl = tasks.length
      ? `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${tasks[tasks.length - 1][1]}&source=dsh-qqbot&_wv=2`
      : ''

    const tokenHits = [...text.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/?\?token=([A-Za-z0-9_-]+))/g)]
    const last = tokenHits.length ? tokenHits[tokenHits.length - 1] : null
    const webUrl = last ? last[1] : ''
    const port = last ? Number(last[2]) : WEB_PORT
    const token = last ? last[3] : ''

    /*
     * 是否已绑定机器人。
     *
     * 判据取三种真实信号，任一命中即算已绑定：
     *   1. 扫码那次留下的「绑定成功」字样（首次绑定时出现一次）
     *   2. `[im-qqbot] Bot ready! appId=...` —— 凭据可用、长连接已建立（之后每次启动都出现）
     *   3. 配置里已写入 appId/appSecret
     * 只看第 1 种会误判：绑定后重启不再出现「绑定成功」，会一直显示"未绑定"。
     */
    const boundByLog =
      /绑定成功|已绑定|bind(ing)? succeeded/i.test(text) || /\[im-qqbot\]\s*Bot ready!/i.test(text)

    // 第 3 种信号：qq profile 的 patch 里写入了 im-qqbot 的 appId
    let boundByConfig = false
    try {
      const fs = await import('node:fs/promises')
      const patch = await fs.readFile(
        'C:\\Users\\Vincent\\.dsh-0.2\\profiles\\qq\\cordis.patch.yml',
        'utf8'
      )
      boundByConfig = /-\s*id:\s*im-qqbot[\s\S]{0,400}?appId:\s*['"]?\d{6,}/.test(patch)
    } catch {
      /* 文件不存在就是没绑定 */
    }

    const bound = boundByLog || boundByConfig

    return { bindUrl, webUrl, port, token, bound }
  }

  /** 探测 0.2 home 的 qq profile 是否被某个 node 进程持有（用端口 + 日志心跳双重判断）。 */
  async function probeHost() {
    const net = await import('node:net')
    const portOpen = await new Promise((resolve) => {
      const s = new net.Socket()
      const done = (v) => {
        try {
          s.destroy()
        } catch {
          /* ignore */
        }
        resolve(v)
      }
      s.setTimeout(1200)
      s.once('connect', () => done(true))
      s.once('timeout', () => done(false))
      s.once('error', () => done(false))
      s.connect(WEB_PORT, '127.0.0.1')
    })
    return portOpen
  }

  async function statusPayload() {
    const tail = await readBootTail()
    const parsed = await parseBootLog(tail)
    const alive = await probeHost()
    const logLines = tail
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-12)
      .map((l) => l.trim())

    return {
      ok: true,
      alive,
      port: parsed.port || WEB_PORT,
      webUrl: parsed.webUrl,
      bindUrl: parsed.bindUrl,
      bound: parsed.bound,
      home: DSH_HOME_02,
      logFile: BOOT_LOG,
      logLines
    }
  }

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/status',
      handler: async (req, res) => {
        try {
          sendJson(res, 200, await statusPayload())
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
        }
      }
    })
  )

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/bind',
      handler: async (req, res) => {
        const tail = await readBootTail()
        const parsed = await parseBootLog(tail)
        sendJson(res, 200, { ok: !!parsed.bindUrl, bindUrl: parsed.bindUrl, bound: parsed.bound })
      }
    })
  )

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/open',
      handler: async (req, res) => {
        if ((req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const payload = await statusPayload()
          if (!payload.alive || !payload.webUrl) {
            sendJson(res, 409, {
              ok: false,
              error: 'QQ 大肥鱼主机未运行或没有可用的 token URL',
              webUrl: payload.webUrl
            })
            return
          }
          /*
           * 不能用 `cmd /c start "" URL`：cmd 把 URL 里的 `=` 当参数分隔，
           * 会把 `?token=xxx` 截成 `?token`（实测复现），浏览器打开的就是无 token 的 401 页。
           *
           * 正确做法：直接用系统 URL 处理器把整串 URL 交给 ShellExecute。
           * rundll32 url.dll,FileProtocolHandler 接受单个参数，不做二次拆分；
           * 打开失败再退回 explorer.exe（同样按整串 URL 处理）。
           */
          const cp = await import('node:child_process')
          const url = payload.webUrl
          const attempts = [
            ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
            ['explorer.exe', [url]]
          ]
          let opened = false
          let lastErr = ''
          for (const [file, args] of attempts) {
            try {
              const child = cp.spawn(file, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: false
              })
              child.unref()
              opened = true
              break
            } catch (e) {
              lastErr = String(e && e.message ? e.message : e)
            }
          }
          sendJson(res, opened ? 200 : 500, opened
            ? { ok: true, opened: url, via: attempts[0][0] }
            : { ok: false, error: lastErr || 'no url handler available', webUrl: url })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
        }
      }
    })
  )

  /*
   * 机器人名片：昵称 / QQ 号 / 加好友分享链接 / 二维码（SVG data URL）。
   * 加好友二维码由 QQ 官方 `users/@me` 的 share_url 生成，扫了就能把
   * 「大肥鱼」加到自己手机 QQ。缓存 10 分钟，`?force=1` 可强制刷新。
   */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/bot',
      handler: async (req, res) => {
        try {
          const force = /[?&]force=1/.test(req.url || '')
          sendJson(res, 200, await resolveBotCard(force))
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            error: String(err && err.message ? err.message : err)
          })
        }
      }
    })
  )

  /*
   * 聊天记录：列出 QQ 主机（~/.dsh-0.2）自己的会话。
   *
   * 这是桌面端会话列表里永远看不到的部分 —— 两个 DSH_HOME 的 sessions 互不相通，
   * 而 QQ 侧插件本身也没有任何聊天记录界面（它只管绑定与配置）。
   */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/sessions',
      handler: async (req, res) => {
        try {
          const m = /[?&]limit=(\d+)/.exec(req.url || '')
          const limit = m ? Math.min(Math.max(Number(m[1]), 1), 50) : 8
          const sessions = await listQqSessions(limit)
          sendJson(res, 200, { ok: true, dir: QQ_SESSIONS_DIR, sessions })
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            dir: QQ_SESSIONS_DIR,
            sessions: [],
            error: String(err && err.message ? err.message : err)
          })
        }
      }
    })
  )

  /*
   * 机器人配置：读 / 写 qq profile 的 im-qqbot 块。
   * 对应原作者插件设置页里的「服务范围 / 基础设置 / 模型 / 个性化提示词」。
   */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/config',
      handler: async (req, res) => {
        try {
          if ((req.method || 'GET').toUpperCase() === 'GET') {
            const snap = await readQqConfig()
            // appSecret 不回传：只告诉前端「有没有」
            const hasSecret =
              typeof snap.config.appSecret === 'string' && snap.config.appSecret !== ''
            const safe = { ...snap.config }
            delete safe.appSecret
            sendJson(res, 200, { ...snap, config: safe, hasSecret })
            return
          }
          if ((req.method || '').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const chunks = []
          for await (const c of req) chunks.push(c)
          let payload = {}
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid json' })
            return
          }
          const written = await writeQqConfig(payload)
          sendJson(res, 200, { ok: true, ...written, needsRestart: true })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
        }
      }
    })
  )

  /* 重启 QQ 主机（kill 已有 --profile qq 进程后重新拉起） */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/host/restart',
      handler: async (req, res) => {
        if ((req.method || '').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const cp = await import('node:child_process')
          // 1) 关掉现有 QQ 主机
          const list = cp.execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*--profile qq*\' } | Select-Object -ExpandProperty ProcessId"',
            { encoding: 'utf8', windowsHide: true }
          )
          const pids = list.split(/\s+/).filter((s) => /^\d+$/.test(s))
          for (const pid of pids) {
            try {
              process.kill(Number(pid))
            } catch {
              /* 已退出 */
            }
          }
          await new Promise((r) => setTimeout(r, 2500))
          // 2) 重新拉起（detached，脱离本进程树）
          const child = cp.spawn(
            'node',
            [
              'C:\\dsh-0.2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
              '--profile',
              'qq',
              '--no-open'
            ],
            {
              cwd: 'C:\\dsh-0.2',
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
              env: { ...process.env, DSH_HOME: DSH_HOME_02 }
            }
          )
          child.unref()
          sendJson(res, 200, { ok: true, killed: pids.length, respawned: true })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
        }
      }
    })
  )

  ctx.effect(() => () => {
    for (const d of disposers.reverse()) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* ignore */
      }
    }
  })
}
