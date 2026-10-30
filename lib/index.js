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

/* ── 主动消息 & 表情包 ────────────────────────────────────────────────────
 *
 * 为什么不 fork dsh-qqbot：`bot` 实例只在 gateway/bootstrap.js 内部创建，
 * 没有对外暴露，改它意味着维护上游同步。这里直接打 QQ 官方 HTTP API，
 * 完全绕开插件 —— 只要拿到 appId/appSecret + 对端 openid 就能推。
 *
 * 主动消息 vs 被动回复（QQ 官方规则）：
 *   · 带 msg_id  = 被动回复（绑定到触发消息，几乎无限制）
 *   · 不带 msg_id = 主动推送（有月配额，一般 4 条/用户/月）
 * 主动推送超配额会返回 403，必须做本地节流。
 *
 * openid 从哪来：`~/.dsh-qqbot/model-prefs.json` 的 key 是
 * `qqbot:<appId>:<c2c|group>:<peerId>`，peerId 就是 openid。
 * 这份文件只在该 peer 用过 /model 或 /preset 时才写；没写过时，
 * 从 QQ 主机日志里扫，或让用户在设置页手填。
 */

/** QQ 官方 API 根 */
const QQ_API = 'https://api.sgroup.qq.com'
/*
 * 注：原 PROACTIVE_MONTHLY_QUOTA / PROACTIVE_LEDGER 已移除。
 * QQ 官方公告「主动推送能力于 2025-04-21 起不再提供」，配额计数无意义。
 * 真正的主动开口走 OneBot（个人号协议，无此限制）。
 */

/** 取 access_token（缓存到过期前 60 秒） */
const tokenCache = { appId: '', token: '', exp: 0 }
async function getAccessToken(appId, appSecret, force = false) {
  const now = Date.now()
  if (!force && tokenCache.appId === appId && tokenCache.token && now < tokenCache.exp - 60000) {
    return tokenCache.token
  }
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret })
  })
  if (!res.ok) throw new Error('getAppAccessToken HTTP ' + res.status)
  const body = await res.json()
  const token = typeof body.access_token === 'string' ? body.access_token : ''
  if (!token) throw new Error('未返回 access_token')
  const expiresIn = Number(body.expires_in) || 7200
  tokenCache.appId = appId
  tokenCache.token = token
  tokenCache.exp = now + expiresIn * 1000
  return token
}

/** 调 QQ API */
async function qqApi(appId, appSecret, pathName, init = {}) {
  const token = await getAccessToken(appId, appSecret)
  const res = await fetch(QQ_API + pathName, {
    ...init,
    headers: {
      authorization: 'QQBot ' + token,
      'x-union-appid': appId,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  })
  const text = await res.text()
  let body = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 400) }
  }
  return { ok: res.ok, status: res.status, body }
}

/* ── OneBot v11 action 调用 ────────────────────────────────────────────────
 *
 * OneBot 的 HTTP API 是 `POST <base>/<action>`，body 是 JSON 参数，
 * 返回 `{ status:'ok', retcode:0, data:{...}, message:'' }`。
 * retcode 为 0 且 status 为 ok 才算成功。
 *
 * 这是「凭空开口」的唯一通道：QQ 官方机器人 2025-04-21 起已移除主动推送，
 * OneBot 走个人号协议没有这个限制。
 */
const ONEBOT_BASE = 'http://127.0.0.1:3000'

async function oneBotAction(action, params, timeoutMs = 15000) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      ctrl.abort()
    }, timeoutMs)
    let res
    try {
      res = await fetch(ONEBOT_BASE + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params || {}),
        signal: ctrl.signal
      })
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    let body = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      return { ok: false, error: 'OneBot 返回非 JSON: ' + text.slice(0, 200), raw: text.slice(0, 400) }
    }
    const ok = body.status === 'ok' && body.retcode === 0
    return {
      ok,
      data: body.data,
      error: ok ? '' : 'OneBot retcode=' + body.retcode + ' ' + (body.message || body.wording || ''),
      raw: ok ? undefined : JSON.stringify(body).slice(0, 400)
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    return {
      ok: false,
      error: '连不上 OneBot（' + ONEBOT_BASE + '）：' + msg,
      raw: msg
    }
  }
}

/** 从 model-prefs.json 里抠 openid */
async function discoverPeers() {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const out = []
  const candidates = [
    path.join(os.homedir(), '.dsh-qqbot', 'model-prefs.json'),
    path.join(DSH_HOME_02, '..', '.dsh-qqbot', 'model-prefs.json')
  ]
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file, 'utf8')
      const json = JSON.parse(text)
      const walk = (obj) => {
        for (const key of Object.keys(obj || {})) {
          const m = /^qqbot:(\d+):(c2c|group):(.+)$/.exec(key)
          if (m) {
            const id = m[1] + ':' + m[2] + ':' + m[3]
            if (!out.some((p) => p.id === id)) {
              out.push({ id, appId: m[1], scope: m[2], peerId: m[3], source: path.basename(file) })
            }
          }
          const v = obj[key]
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v)
        }
      }
      walk(json)
    } catch {
      /* 文件不存在就跳过 */
    }
  }
  return out
}

/** 表情包目录（用户可以往里丢 gif/png） */
const STICKER_DIR = DSH_HOME_02 + '\\dafeiyu-stickers'

/** 已发现 peer 的持久化台账（从日志扫到的 openid 存这里，重启不丢） */
const PEER_STORE = DSH_HOME_02 + '\\dafeiyu-peers.json'
/** dsh-qqbot 补丁落盘的原始事件流（每收到一条消息追加一行） */
const PEER_EVENTS = DSH_HOME_02 + '\\dafeiyu-peer-events.jsonl'

/**
 * 读 dsh-qqbot 补丁落盘的 openid 事件流。
 *
 * 这是最可靠的一源：`dist/transport/inbound.js` 收到消息时会把
 * `{ scope, peerId, senderId, at }` 追加进 dafeiyu-peer-events.jsonl。
 * 因为 session 文件里不含 openid（只有内容），logger.info 的输出又被
 * DSH 的环形日志吃掉、不落 qqboot.log，只有这个补丁能稳定拿到 peerId。
 */
async function readPeerEvents() {
  const fs = await import('node:fs/promises')
  const out = new Map()
  try {
    const text = await fs.readFile(PEER_EVENTS, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (typeof e.peerId !== 'string' || e.peerId.length < 10) continue
        const scope = e.scope === 'group' ? 'group' : 'c2c'
        out.set(scope + ':' + e.peerId, {
          scope,
          peerId: e.peerId,
          senderId: e.senderId || e.peerId,
          at: e.at || 0,
          source: 'inbound-event'
        })
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 文件还没生成 */
  }
  return [...out.values()].sort((a, b) => b.at - a.at)
}

/** 读 peer 台账 */
async function readPeerStore() {
  try {
    const fs = await import('node:fs/promises')
    const text = await fs.readFile(PEER_STORE, 'utf8')
    const arr = JSON.parse(text)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 写 peer 台账（合并去重） */
async function savePeerStore(peers) {
  try {
    const fs = await import('node:fs/promises')
    await fs.writeFile(PEER_STORE, JSON.stringify(peers, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * 从 QQ 主机日志里扫 openid。
 *
 * dsh-qqbot 的 transport/inbound.js 在收到消息时会打印：
 *   `Processing: scope=c2c peerId=<OPENID> body="..."`
 * 这就是我们拿 openid 的唯一可靠来源（QQ 不提供「列出会话」的接口）。
 *
 * 扫描范围：启动日志 + 0.2 home 下的全部 .log/.out/.err。
 * 扫到的 peer 落进 PEER_STORE，之后即使日志被清也能主动推。
 */
async function scanPeersFromLogs() {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const found = new Map()

  const files = [BOOT_LOG, BOOT_LOG + '.err']
  try {
    const dir = path.join(DSH_HOME_02, 'logs')
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isFile()) files.push(path.join(dir, e.name))
    }
  } catch {
    /* 目录不存在 */
  }
  try {
    for (const e of await fs.readdir(DSH_HOME_02, { withFileTypes: true })) {
      if (e.isFile() && /\.(log|out|err)$/i.test(e.name)) files.push(path.join(DSH_HOME_02, e.name))
    }
  } catch {
    /* ignore */
  }

  for (const file of files) {
    let text = ''
    try {
      const st = await fs.stat(file)
      // 只读尾部 512KB，日志太大时避免整读
      const start = Math.max(0, st.size - 512 * 1024)
      const fh = await fs.open(file, 'r')
      try {
        const buf = Buffer.alloc(Math.min(512 * 1024, st.size))
        await fh.read(buf, 0, buf.length, start)
        text = buf.toString('utf8')
      } finally {
        await fh.close()
      }
    } catch {
      continue
    }
    for (const m of text.matchAll(/Processing:\s*scope=(c2c|group)\s+peerId=(\S+)/g)) {
      const scope = m[1]
      const peerId = m[2].replace(/[",)'\]]+$/, '')
      if (!peerId || peerId.length < 10) continue
      found.set(scope + ':' + peerId, { scope, peerId, source: path.basename(file) })
    }
  }
  return [...found.values()]
}

/** 合并三个来源的 peer：日志扫描 > model-prefs > 已知台账 */
async function collectPeers(appId) {
  const merged = new Map()
  const add = (p) => {
    const key = p.scope + ':' + p.peerId
    if (!merged.has(key)) merged.set(key, p)
  }

  for (const p of await readPeerStore()) add(p)
  // inbound 事件流是最可靠的一源（补丁落盘），优先采用
  for (const p of await readPeerEvents()) add(p)
  for (const p of await scanPeersFromLogs()) add(p)
  for (const p of await discoverPeers()) {
    add({ scope: p.scope, peerId: p.peerId, source: p.source })
  }

  const list = [...merged.values()]
  const changed = list.length !== (await readPeerStore()).length
  if (changed) await savePeerStore(list)
  return list.map((p) => ({ ...p, appId: appId || '' }))
}

/** 列出表情包 */
async function listStickers() {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const out = []
  try {
    await fs.mkdir(STICKER_DIR, { recursive: true })
    const entries = await fs.readdir(STICKER_DIR, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile()) continue
      if (!/\.(gif|png|jpg|jpeg|webp)$/i.test(e.name)) continue
      const full = path.join(STICKER_DIR, e.name)
      const st = await fs.stat(full)
      out.push({ name: e.name, size: st.size, mtime: st.mtimeMs, path: full })
    }
  } catch {
    /* 目录不可读就返回空 */
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

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

  /*
   * 主动消息与表情包 —— 直连 QQ 官方 API，不经过 dsh-qqbot。
   */

  /* GET /peers：从 model-prefs.json 里找出已知 openid */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/peers',
      handler: async (req, res) => {
        try {
          const conf = await readQqConfig()
          const peers = await collectPeers(conf.config.appId)
          /*
           * 只返回已知 openid。不再带「月配额」——QQ 官方已于 2025-04-21
           * 移除主动推送能力，那里的配额计数没有意义。
           * 主动开口要靠 OneBot（见 docs/onebot-proactive.md）。
           */
          sendJson(res, 200, { ok: true, peers })
        } catch (err) {
          sendJson(res, 200, { ok: false, peers: [], error: String(err && err.message ? err.message : err) })
        }
      }
    })
  )

  /*
   * GET /onebot：探测 OneBot 实现（NapCat / LLOneBot）是否在跑。
   *
   * QQ 官方机器人不能主动开口（2025-04-21 已移除主动推送），
   * 真正的「自己想起来找你」只能走 OneBot 个人号协议 —— 那条路没有官方配额。
   * dsh-onebot 本身不暴露 service，所以这里直接探端口 + 调 get_login_info。
   */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/onebot',
      handler: async (req, res) => {
        const probes = [
          { name: 'NapCat/LLOneBot forward-ws', url: 'http://127.0.0.1:3001' },
          { name: 'go-cqhttp HTTP', url: 'http://127.0.0.1:5700' },
          { name: 'NapCat HTTP', url: 'http://127.0.0.1:3000' }
        ]
        const results = []
        let running = false
        let url = ''
        let selfId = ''
        let nickname = ''

        for (const p of probes) {
          let reachable = false
          try {
            const ctrl = new AbortController()
            const timer = setTimeout(() => {
              ctrl.abort()
            }, 2000)
            const r = await fetch(p.url + '/get_login_info', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              signal: ctrl.signal
            })
            clearTimeout(timer)
            reachable = true
            const body = await r.json().catch(() => ({}))
            const data = body && body.data ? body.data : {}
            if (data.user_id) {
              running = true
              url = p.url
              selfId = String(data.user_id)
              nickname = String(data.nickname || '')
            }
          } catch {
            /* 该端点没跑 */
          }
          results.push({ name: p.name, url: p.url, reachable })
        }

        sendJson(res, 200, {
          ok: true,
          running,
          url,
          selfId,
          nickname,
          probes: results,
          note: running
            ? 'OneBot 已在线，可用 send_private_msg 主动发消息'
            : 'OneBot 未运行。装 NapCat/LLOneBot 并开启 HTTP 或正向 WS 后重试'
        })
      }
    })
  )

  /*
   * POST /onebot/send：通过 OneBot 主动发消息（真正的「先开口」）。
   *
   * 这是唯一能凭空开口的通道 —— QQ 官方机器人 2025-04-21 起已移除主动推送，
   * 而 OneBot 走个人号协议，没有这个限制。
   *
   * 失败时把 OneBot 的原始返回透出来，便于排查（例如 100 未登录、
   * 1200 消息过长、1400 风控）。
   */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/onebot/send',
      handler: async (req, res) => {
        if ((req.method || '').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const { userId, groupId, message } = payload
          const text = typeof message === 'string' ? message : ''
          if (!text.trim()) {
            sendJson(res, 400, { ok: false, error: 'message 不能为空' })
            return
          }
          const target = groupId ? 'group_id' : 'user_id'
          const id = String(groupId || userId || '').trim()
          if (!/^\d{5,15}$/.test(id)) {
            sendJson(res, 400, { ok: false, error: '需要合法的 QQ 号（5-15 位数字）' })
            return
          }
          const action = groupId ? 'send_group_msg' : 'send_private_msg'
          const body = { [target]: Number(id), message: text }

          const r = await oneBotAction(action, body)
          if (r.ok) {
            sendJson(res, 200, {
              ok: true,
              sent: true,
              action,
              target: id,
              messageId: r.data && r.data.message_id ? r.data.message_id : ''
            })
          } else {
            sendJson(res, 200, {
              ok: false,
              error: r.error || 'OneBot 发送失败',
              raw: r.raw
            })
          }
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
        }
      }
    })
  )

  /*
   * POST /onebot/send-image：通过 OneBot 发图片（表情包走这里）。
   * OneBot 支持 base64:// 与本地路径，比官方 API 的富媒体上传简单得多。
   */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/onebot/send-image',
      handler: async (req, res) => {
        if ((req.method || '').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const { userId, groupId, name } = payload
          const id = String(groupId || userId || '').trim()
          if (!/^\d{5,15}$/.test(id)) {
            sendJson(res, 400, { ok: false, error: '需要合法的 QQ 号（5-15 位数字）' })
            return
          }
          if (!name || !/^[^/\\]+\.(gif|png|jpg|jpeg|webp)$/i.test(name)) {
            sendJson(res, 400, { ok: false, error: '非法文件名' })
            return
          }
          const path = await import('node:path')
          const fs = await import('node:fs/promises')
          const full = path.join(STICKER_DIR, name)
          const buf = await fs.readFile(full)
          const seg = '[CQ:image,file=base64://' + buf.toString('base64') + ']'

          const action = groupId ? 'send_group_msg' : 'send_private_msg'
          const body = groupId
            ? { group_id: Number(id), message: seg }
            : { user_id: Number(id), message: seg }
          const r = await oneBotAction(action, body)
          sendJson(res, 200, r.ok
            ? { ok: true, sent: true, target: id, messageId: (r.data && r.data.message_id) || '' }
            : { ok: false, error: r.error || '发送失败', raw: r.raw })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
        }
      }
    })
  )

  /* GET /stickers：列出表情包目录 */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/stickers',
      handler: async (req, res) => {
        try {
          const items = await listStickers()
          sendJson(res, 200, { ok: true, dir: STICKER_DIR, items })
        } catch (err) {
          sendJson(res, 200, { ok: false, dir: STICKER_DIR, items: [], error: String(err && err.message ? err.message : err) })
        }
      }
    })
  )

  /*
   * POST /sticker/send：把表情包当图片发给某个 peer。
   * QQ 机器人 API 不支持真正的「表情包」消息类型，唯一可行路径是
   * 当图片发送（gif/png）。这里读文件 → base64 → 调富媒体上传 → 发消息。
   */
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/sticker/send',
      handler: async (req, res) => {
        if ((req.method || '').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const { peerId, scope, name } = payload
          if (!peerId || !name) {
            sendJson(res, 400, { ok: false, error: 'peerId 与 name 必填' })
            return
          }
          const path = await import('node:path')
          const fs = await import('node:fs/promises')
          if (!/^[^/\\]+\.(gif|png|jpg|jpeg|webp)$/i.test(name)) {
            sendJson(res, 400, { ok: false, error: '非法文件名' })
            return
          }
          const full = path.join(STICKER_DIR, name)
          const buf = await fs.readFile(full)
          const conf = await readQqConfig()
          const { appId, appSecret } = conf.config
          if (!appId || !appSecret) {
            sendJson(res, 400, { ok: false, error: 'qq profile 里没有 appId/appSecret' })
            return
          }
          const sc = scope || 'c2c'
          const uploadPath =
            sc === 'group'
              ? '/v2/groups/' + encodeURIComponent(peerId) + '/files'
              : '/v2/users/' + encodeURIComponent(peerId) + '/files'
          const up = await qqApi(appId, appSecret, uploadPath, {
            method: 'POST',
            body: JSON.stringify({
              file_type: 1,
              file_data: buf.toString('base64'),
              srv_send_msg: false
            })
          })
          if (!up.ok) {
            sendJson(res, 200, {
              ok: false,
              error: '上传失败 ' + up.status + ': ' + JSON.stringify(up.body).slice(0, 300)
            })
            return
          }
          const fileInfo = (up.body && up.body.file_info) || ''
          const sendPath =
            sc === 'group'
              ? '/v2/groups/' + encodeURIComponent(peerId) + '/messages'
              : '/v2/users/' + encodeURIComponent(peerId) + '/messages'
          const sent = await qqApi(appId, appSecret, sendPath, {
            method: 'POST',
            body: JSON.stringify({ msg_type: 7, media: { file_info: fileInfo }, content: ' ' })
          })
          sendJson(res, 200, {
            ok: sent.ok,
            sent: sent.ok,
            id: (sent.body && sent.body.id) || '',
            error: sent.ok ? '' : '发送失败 ' + sent.status + ': ' + JSON.stringify(sent.body).slice(0, 300)
          })
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
