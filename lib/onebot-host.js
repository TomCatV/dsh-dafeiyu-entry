/**
 * dafeiyu-onebot-host — OneBot 主机生命周期管理
 *
 * 目标：用户在插件里扫码绑定一次，之后永远免扫码，随时能主动发消息。
 *
 * 免扫码的原理：
 *   NapCat 的 `launcher.bat <QQ号>` 走「快速登录」，凭据来自 **QQ 客户端自己**
 *   保存的登录态（`D:\QQFile\<QQ号>\nt_qq`），不是 NapCat 存的。
 *   所以只要 QQ 客户端的登录态还在，重启 NapCat 就不需要再扫码。
 *
 * 扫码绑定流程：
 *   1. 无绑定 → 以「无 -q 参数」启动 NapCat（二维码登录模式）
 *   2. 从 NapCat 日志里抓 `二维码解码URL:` 并渲染成大图给前端
 *   3. 从日志里抓登录成功后的 QQ 号
 *   4. 拿到 QQ 号后写 onebot11_<qq>.json（HTTP 3000 + WS 3001）
 *   5. 记进绑定台账，后续启动一律用 `launcher.bat <qq>` 快速登录
 *
 * 为什么不走 NapCat WebUI API：它的 /api/* 需要浏览器会话，
 * Bearer/query token 都被拒（已验证 4 种头 + query 全 401）。
 * 日志是唯一稳定可读的事实源。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** NapCat 安装目录（可用 config.napcatDir 覆盖） */
export const DEFAULT_NAPCAT_DIR = 'C:\\Users\\Vincent\\dsh\\tmp\\napcat\\shell'
/** 绑定台账：记住用户选定的 QQ 号，之后一律快速登录 */
const BINDING_FILE = 'onebot-binding.json'
/** NapCat 日志（launcher 重定向到这里） */
const LOG_FILE = 'napcat.out.log'
/** 二维码图片（NapCat 自己写的） */
const QR_FILE = join('cache', 'qrcode.png')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 主机管理器的构造函数。
 *
 * @param {object} opts
 * @param {string} opts.dataDir - 存绑定台账的目录（DSH_HOME）
 * @param {string} [opts.napcatDir] - NapCat shell 目录
 * @param {function} [opts.logger] - 日志
 * @param {function} [opts.onQrReady] - 抓到新二维码时的回调（可选，便于前端联动）
 */
export function createOneBotHost({ dataDir, napcatDir = DEFAULT_NAPCAT_DIR, logger = console } = {}) {
  if (!dataDir) throw TypeError('dataDir required')

  const shellDir = napcatDir
  const logPath = join(shellDir, LOG_FILE)
  const qrPath = join(shellDir, QR_FILE)
  const bindingPath = join(dataDir, BINDING_FILE)

  /** 启动中标志，避免并发拉起多个 NapCat */
  let starting = false
  /** 上一次读到的日志长度（增量解析用） */
  let logOffset = 0
  /** 最近一次抓到的二维码 URL */
  let lastQrUrl = ''
  /** 最近一次抓到的二维码时间 */
  let lastQrAt = 0
  /** 登录成功的 QQ 号（运行期缓存） */
  let loggedInUin = ''

  /* ── 绑定台账 ──────────────────────────────────────────────────────── */

  function readBinding() {
    try {
      const raw = readFileSync(bindingPath, 'utf8')
      const j = JSON.parse(raw)
      return {
        qq: typeof j.qq === 'string' ? j.qq : '',
        nickname: typeof j.nickname === 'string' ? j.nickname : '',
        boundAt: Number(j.boundAt) || 0
      }
    } catch {
      return { qq: '', nickname: '', boundAt: 0 }
    }
  }

  function writeBinding(next) {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(bindingPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch (err) {
      logger.warn?.('[onebot-host] 绑定台账写入失败：' + (err?.message || err))
    }
  }

  /* ── 日志增量读取 ──────────────────────────────────────────────────── */

  /** 读日志尾部，从上次位置继续（文件被截断时回到 0） */
  function readLogDelta() {
    try {
      const st = statSync(logPath)
      if (st.size < logOffset) logOffset = 0
      if (st.size === logOffset) return ''
      const fs = readFileSync(logPath)
      const chunk = fs.subarray(logOffset).toString('utf8')
      logOffset = st.size
      return chunk
    } catch {
      return ''
    }
  }

  /** 全量读日志尾部 N 字节（用于首次解析/诊断） */
  function readLogTail(bytes = 256 * 1024) {
    try {
      const st = statSync(logPath)
      const start = Math.max(0, st.size - bytes)
      const buf = readFileSync(logPath)
      return buf.subarray(start).toString('utf8')
    } catch {
      return ''
    }
  }

  /**
   * 从日志文本里抽状态：二维码 URL、登录成功、进程退出。
   *
   * NapCat 的日志形态（实测）：
   *   二维码解码URL: https://txz.qq.com/p?k=...&f=1600001604
   *   10-30 15:02:39 [info] 正在快速登录  3969466650
   *   10-30 14:57:06 [debug] 本账号数据/缓存目录： D:\QQFile\NapCat\data
   *   HTTP服务: 127.0.0.1:3000, : 已启动
   */
  function parseLog(text) {
    const out = {}
    const qr = [...text.matchAll(/二维码解码URL[:：]\s*(\S+)/g)]
    if (qr.length) {
      out.qrUrl = qr[qr.length - 1][1]
      out.qrAt = Date.now()
    }
    // 快速登录成功：日志会进入 adapter 初始化，同时 config 里出现 onebot11_<qq>.json
    const quick = [...text.matchAll(/正在快速登录\s+(\d{5,15})/g)]
    if (quick.length) out.quickLoginUin = quick[quick.length - 1][1]
    // 扫码登录成功后会有「登录成功」或 account 相关行
    const ok = [...text.matchAll(/登录成功[^\n]*?(\d{5,15})/g)]
    if (ok.length) out.loggedInUin = ok[ok.length - 1][1]
    if (/HTTP服务:\s*127\.0\.0\.1:3000/.test(text)) out.httpStarted = true
    if (/WebSocket服务:\s*127\.0\.0\.1:3001/.test(text)) out.wsStarted = true
    return out
  }

  /* ── 进程控制 ──────────────────────────────────────────────────────── */

  /** 关掉所有 NapCat / QQ 进程（NapCat 接管时 QQ 是子进程） */
  async function killAll() {
    try {
      await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        "Get-Process -Name 'QQ','NapCatWinBootMain' -ErrorAction SilentlyContinue | Stop-Process -Force"
      ], { windowsHide: true, timeout: 20000 })
    } catch {
      /* 没有进程时 powershell 也会返回 0，这里只是兜底 */
    }
    await sleep(4000)
  }

  /**
   * 启动 NapCat。
   *
   * @param {string} qq - 传了就走快速登录（免扫码）；不传则二维码登录
   * @returns {Promise<{ok:boolean, mode:string, qq:string, error?:string}>}
   */
  async function start(qq = '') {
    if (starting) return { ok: false, mode: 'busy', qq, error: '正在启动中' }
    starting = true
    try {
      if (!existsSync(join(shellDir, 'launcher.bat'))) {
        return { ok: false, mode: 'missing', qq, error: '找不到 NapCat：' + shellDir }
      }
      await killAll()

      // 清空日志，便于从头解析
      try {
        writeFileSync(logPath, '', 'utf8')
      } catch {
        /* 没权限就算了 */
      }
      logOffset = 0
      lastQrUrl = ''
      lastQrAt = 0
      loggedInUin = ''

      const arg = /^\d{5,15}$/.test(qq) ? ' ' + qq : ''
      const cmd = `launcher.bat${arg} > "${logPath}" 2> "${join(shellDir, 'napcat.err.log')}"`
      const child = spawn('cmd.exe', ['/c', cmd], {
        cwd: shellDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()

      return { ok: true, mode: qq ? 'quick' : 'qr', qq }
    } catch (err) {
      return { ok: false, mode: 'error', qq, error: String(err?.message || err) }
    } finally {
      starting = false
    }
  }

  /** 停止 NapCat（保留 QQ 客户端登录态，下次快速登录免扫码） */
  async function stop() {
    await killAll()
    return { ok: true }
  }

  /* ── 二维码 ────────────────────────────────────────────────────────── */

  /**
   * 取当前待扫的二维码。
   *
   * 优先从日志增量里抓最新的 `二维码解码URL`；
   * 抓不到就回退到 NapCat 自己写的 cache/qrcode.png（那是同一条码的图片）。
   *
   * @returns {{ ok:boolean, url:string, at:number, imagePath:string, error?:string }}
   */
  function currentQr() {
    const delta = readLogDelta()
    const parsed = parseLog(delta)
    if (parsed.qrUrl) {
      lastQrUrl = parsed.qrUrl
      lastQrAt = parsed.qrAt
    }
    if (!lastQrUrl) {
      // 首次调用或日志被清：全量扫一次
      const tail = readLogTail()
      const p2 = parseLog(tail)
      if (p2.qrUrl) {
        lastQrUrl = p2.qrUrl
        lastQrAt = p2.qrAt
      }
    }
    const hasImage = existsSync(qrPath)
    if (!lastQrUrl && !hasImage) {
      return { ok: false, url: '', at: 0, imagePath: '', error: '暂无二维码，NapCat 可能还没启动完成' }
    }
    return { ok: true, url: lastQrUrl, at: lastQrAt, imagePath: hasImage ? qrPath : '' }
  }

  /** 读二维码 PNG（base64），给前端直接 <img src="data:image/png;base64,..."> */
  function qrImageBase64() {
    try {
      if (!existsSync(qrPath)) return ''
      const buf = readFileSync(qrPath)
      // NapCat 存的文件名是 .png，实际可能是 jpeg，让浏览器按内容嗅探
      return 'data:image/png;base64,' + buf.toString('base64')
    } catch {
      return ''
    }
  }

  /* ── 状态聚合 ──────────────────────────────────────────────────────── */

  /**
   * 综合状态：进程 + 端口 + 登录号 + 绑定台账。
   *
   * @returns {Promise<object>}
   */
  async function status() {
    const binding = readBinding()
    const tail = readLogTail(64 * 1024)
    const parsed = parseLog(tail)

    // 日志里出现过的 QQ 号（快速登录或已绑定配置文件名）
    let configQq = ''
    let configHttp = 0
    let configWs = 0
    try {
      const cfgDir = join(shellDir, 'config')
      const names = existsSync(cfgDir) ? readdirSyncSafe(cfgDir) : []
      const onebotFiles = names.filter((n) => /^onebot11_\d+\.json$/.test(n))
      if (onebotFiles.length) {
        const f = onebotFiles.sort().pop()
        const m = /onebot11_(\d+)\.json/.exec(f)
        configQq = m ? m[1] : ''
        try {
          const j = JSON.parse(readFileSync(join(shellDir, 'config', f), 'utf8'))
          configHttp = Array.isArray(j?.network?.httpServers) ? j.network.httpServers.filter((x) => x.enable).length : 0
          configWs = Array.isArray(j?.network?.websocketServers) ? j.network.websocketServers.filter((x) => x.enable).length : 0
        } catch {
          /* 配置坏就当 0 */
        }
      }
    } catch {
      /* 目录不可读 */
    }

    // 端口探测（OneBot HTTP）
    let httpAlive = false
    if (parsed.httpStarted || configHttp > 0) {
      httpAlive = await probePort(3000, 800)
    }

    // 进程探测
    let processAlive = false
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        "@(Get-Process -Name 'QQ','NapCatWinBootMain' -ErrorAction SilentlyContinue).Count"
      ], { windowsHide: true, timeout: 8000 })
      processAlive = Number(String(stdout).trim()) > 0
    } catch {
      processAlive = false
    }

    // 登录号：优先 real HTTP 探测，其次日志/配置
    let selfId = ''
    let nickname = ''
    if (httpAlive) {
      try {
        const r = await fetch('http://127.0.0.1:3000/get_login_info', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(3000)
        })
        const j = await r.json()
        if (j && j.status === 'ok' && j.data) {
          selfId = String(j.data.user_id || '')
          nickname = String(j.data.nickname || '')
          if (selfId) {
            loggedInUin = selfId
            // 首次成功登录 → 落绑定台账，后续免扫码
            if (binding.qq !== selfId) {
              writeBinding({ qq: selfId, nickname, boundAt: Date.now() })
            }
          }
        }
      } catch {
        /* 探不到就空着 */
      }
    }

    const qr = currentQr()

    /*
     * 自我修复：只要探测到已登录，就把 QQ 号写进绑定台账。
     *
     * 这样即使用户是「手动 launcher.bat 快速登录」进来的、或台账被删过，
     * 下次 start() 也能读懂该用哪个号免扫码，不需要用户再扫一次。
     */
    let bound = Boolean(binding.qq)
    let bindingNow = binding
    const effectiveUin = selfId || configQq || binding.qq || parsed.quickLoginUin || ''
    if (effectiveUin && binding.qq !== effectiveUin) {
      bindingNow = {
        qq: effectiveUin,
        nickname: nickname || binding.nickname || '',
        boundAt: binding.boundAt || Date.now()
      }
      writeBinding(bindingNow)
      bound = true
    }

    return {
      ok: true,
      // 进程/端口
      processAlive,
      httpAlive,
      wsPort: configWs > 0,
      // 登录
      loggedIn: Boolean(selfId),
      selfId: selfId || configQq || binding.qq || parsed.quickLoginUin || '',
      nickname: nickname || binding.nickname || '',
      // 绑定台账
      bound,
      binding: bindingNow,
      // 二维码（未登录时才需要）
      qr: !selfId && qr.ok ? { url: qr.url, at: qr.at, image: qrImageBase64() } : null,
      // 配置就绪度
      configReady: configHttp > 0 && configWs > 0,
      // 目录
      napcatDir: shellDir,
      // 结论：能不能立刻主动发消息
      ready: Boolean(selfId) && httpAlive && configHttp > 0
    }
  }

  /* ── 工具 ──────────────────────────────────────────────────────────── */

  async function probePort(port, timeoutMs = 800) {
    const net = await import('node:net')
    return new Promise((resolve) => {
      const s = new net.Socket()
      const done = (v) => {
        try {
          s.destroy()
        } catch {
          /* ignore */
        }
        resolve(v)
      }
      s.setTimeout(timeoutMs)
      s.once('connect', () => done(true))
      s.once('timeout', () => done(false))
      s.once('error', () => done(false))
      s.connect(port, '127.0.0.1')
    })
  }

  function readdirSyncSafe(dir) {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }

  return {
    start,
    stop,
    status,
    currentQr,
    qrImageBase64,
    readBinding,
    writeBinding,
    paths: { shellDir, logPath, qrPath, bindingPath }
  }
}
