/**
 * dsh-dafeiyu-entry — 浏览器半侧
 * ----------------------------------------------------------------------------
 * 以 dsh.client bundle 格式加载（手写 ModuleLoader bundle，无需构建）。
 *
 * 在 DSH 设置里注册 `settings.section`（id `dafeiyu`，左侧导航「大肥鱼」），
 * 页面分四个标签页，把 QQ 主机那边的能力都搬到桌面侧栏：
 *
 *   概览   —— 主机状态、Web UI 入口、机器人名片（加好友二维码）
 *   聊天   —— QQ 会话记录（含每条对话；桌面端会话列表看不到这些）
 *   机器人 —— 原作者插件设置页的全部配置项（服务范围/基础/模型/提示词）
 *   排障   —— 启动命令、实时日志、重启主机
 *
 * 为什么要自己实现：原作者的 @tencent-connect/dsh-qqbot 只装在 qq profile，
 * 桌面端跑的是 desktop profile，两个 profile 互不可见 —— 桌面侧栏里
 * 根本没有「QQ 机器人」入口。
 *
 * 注册 id 必须等于 **package name**（dsh-dafeiyu-entry），不是 patch entry 的短 id，
 * 否则同一个 bundle 会被执行两次并报 duplicate factory registration。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dafeiyu-entry',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var API = '/dafeiyu'

    /* ── 样式 ────────────────────────────────────────────────────────────── */
    var CSS = [
      '.__dfy_root{max-width:820px;display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.__dfy_head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.__dfy_dot{width:8px;height:8px;border-radius:50%;flex:none;transition:box-shadow .2s}',
      '.__dfy_dot_on{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}',
      '.__dfy_dot_off{background:#71717a;box-shadow:0 0 0 3px rgba(113,113,122,.14)}',
      '.__dfy_title{font-size:15px;font-weight:650;letter-spacing:.01em}',
      '.__dfy_badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
      '.__dfy_headSpacer{flex:1}',
      '.__dfy_tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.__dfy_tab{appearance:none;background:none;border:none;border-bottom:2px solid transparent;padding:8px 14px 9px;margin-bottom:-1px;font:inherit;font-size:13px;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:color .15s,border-color .15s}',
      '.__dfy_tab:hover{color:var(--dsw-alias-label-primary)}',
      '.__dfy_tabOn{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.__dfy_card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:11px}',
      '.__dfy_cardTitle{font-size:11px;font-weight:650;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.__dfy_row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.__dfy_col{display:flex;flex-direction:column;gap:14px}',
      '.__dfy_grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.__dfy_kv{display:flex;gap:10px;font-size:12.5px;line-height:1.65;align-items:baseline}',
      '.__dfy_k{color:var(--dsw-alias-label-tertiary);min-width:72px;flex:none}',
      '.__dfy_v{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;word-break:break-all;color:var(--dsw-alias-label-primary)}',
      '.__dfy_field{display:flex;flex-direction:column;gap:5px}',
      '.__dfy_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.__dfy_hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.__dfy_input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font:inherit;font-size:12.5px;outline:none;transition:border-color .15s}',
      '.__dfy_input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.__dfy_area{min-height:66px;resize:vertical;line-height:1.6;font-family:inherit}',
      '.__dfy_seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}',
      '.__dfy_segBtn{appearance:none;background:none;border:none;border-right:1px solid var(--dsw-alias-border-l2);padding:5px 13px;font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .15s,color .15s}',
      '.__dfy_segBtn:last-child{border-right:none}',
      '.__dfy_segBtn:hover{color:var(--dsw-alias-label-primary)}',
      '.__dfy_segOn{background:var(--dsw-alias-state-business-primary);color:#fff;font-weight:600}',
      '.__dfy_segOn:hover{color:#fff}',
      '.__dfy_switchRow{display:flex;align-items:flex-start;gap:12px;justify-content:space-between}',
      '.__dfy_switchMeta{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.__dfy_switch{position:relative;width:38px;height:21px;border-radius:999px;border:none;background:var(--dsw-alias-border-l2);cursor:pointer;flex:none;transition:background .18s;padding:0}',
      '.__dfy_switchOn{background:var(--dsw-alias-state-business-primary)}',
      '.__dfy_knob{position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;transition:transform .18s;box-shadow:0 1px 2px rgba(0,0,0,.25)}',
      '.__dfy_knobOn{transform:translateX(17px)}',
      '.__dfy_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:12.5px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:border-color .15s,opacity .15s}',
      '.__dfy_btn:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.__dfy_btn:disabled{opacity:.45;cursor:not-allowed}',
      '.__dfy_btnP{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.__dfy_btnDanger{border-color:#f87171;color:#f87171}',
      '.__dfy_qrWrap{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}',
      '.__dfy_qr{width:168px;height:168px;flex:none;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:#fff;padding:8px;box-sizing:border-box}',
      '.__dfy_qrSide{display:flex;flex-direction:column;gap:8px;flex:1;min-width:200px}',
      '.__dfy_sess{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}',
      '.__dfy_sessHead{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;background:none;border:none;padding:9px 12px;font:inherit;cursor:pointer;text-align:left;color:inherit;transition:background .15s}',
      '.__dfy_sessHead:hover{background:var(--dsw-alias-bg-layer-3)}',
      '.__dfy_sessTitle{font-size:12.5px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.__dfy_sessMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace;flex:none}',
      '.__dfy_caret{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .15s}',
      '.__dfy_caretOn{transform:rotate(90deg)}',
      '.__dfy_sessBody{padding:10px 12px 12px;display:flex;flex-direction:column;gap:9px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.__dfy_msg{display:flex;flex-direction:column;gap:3px;max-width:88%}',
      '.__dfy_msgU{align-self:flex-end;align-items:flex-end}',
      '.__dfy_msgA{align-self:flex-start}',
      '.__dfy_msgRole{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.__dfy_bubble{padding:7px 11px;border-radius:10px;font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word}',
      '.__dfy_bubbleU{background:var(--dsw-alias-state-business-primary);color:#fff;border-bottom-right-radius:3px}',
      '.__dfy_bubbleA{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-bottom-left-radius:3px}',
      '.__dfy_pre{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.65;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
      '.__dfy_warn{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-tertiary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px}',
      '.__dfy_ok{color:#22c55e}',
      '.__dfy_no{color:#a1a1aa}',
      '.__dfy_empty{padding:22px 0;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.__dfy_sess{display:flex;flex-direction:column;gap:8px}',
      '.__dfy_stickerGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}',
      '.__dfy_sticker{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.__dfy_stickerName{font-size:11px;font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.__dfy_toast{font-size:12px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2)}'
    ].join('')

    var STYLE_ID = 'dafeiyu-entry-css'

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ── 数据 ────────────────────────────────────────────────────────────── */
    function jsonFetch(path, init) {
      return fetch(API + path, Object.assign({ credentials: 'same-origin' }, init || {})).then(
        function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json()
        }
      )
    }

    function useAsync(loader, autoReloadMs) {
      var s = react.useState({ loading: true, data: null, error: '' })
      var state = s[0]
      var setState = s[1]
      var load = react.useCallback(function (arg) {
        setState(function (prev) {
          return { loading: true, data: prev.data, error: '' }
        })
        loader(arg)
          .then(function (d) {
            setState({ loading: false, data: d, error: '' })
          })
          .catch(function (e) {
            setState({ loading: false, data: null, error: String(e && e.message ? e.message : e) })
          })
      }, [])
      react.useEffect(function () {
        load()
        if (!autoReloadMs) return undefined
        var t = setInterval(function () {
          load()
        }, autoReloadMs)
        return function () {
          clearInterval(t)
        }
      }, [load])
      return { state: state, reload: load }
    }

    function useCopy() {
      var s = react.useState('')
      var copied = s[0]
      var setCopied = s[1]
      var copy = react.useCallback(function (text, label) {
        if (!text) return
        var done = function () {
          setCopied(label)
          setTimeout(function () {
            setCopied('')
          }, 1500)
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, done)
            return
          }
        } catch (e) {
          /* fallthrough */
        }
        try {
          var ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
          done()
        } catch (e) {
          /* ignore */
        }
      }, [])
      return { copied: copied, copy: copy }
    }

    /* ── 基础组件 ────────────────────────────────────────────────────────── */
    function KV(props) {
      var value = props.v === '' || props.v == null ? '—' : props.v
      return h(
        'div',
        { className: '__dfy_kv' },
        h('span', { className: '__dfy_k' }, props.k),
        props.children || h('span', { className: '__dfy_v' }, value)
      )
    }

    function Btn(props) {
      var attrs = {
        key: props.k,
        className:
          '__dfy_btn' + (props.primary ? ' __dfy_btnP' : '') + (props.danger ? ' __dfy_btnDanger' : '')
      }
      if (props.href) {
        attrs.href = props.href
        attrs.target = '_blank'
        attrs.rel = 'noreferrer noopener'
      } else {
        attrs.type = 'button'
        attrs.onClick = props.onClick
        attrs.disabled = props.disabled
      }
      if (props.title) attrs.title = props.title
      return h(props.href ? 'a' : 'button', attrs, props.children)
    }

    function Switch(props) {
      return h(
        'div',
        { className: '__dfy_switchRow' },
        h(
          'div',
          { className: '__dfy_switchMeta' },
          h('span', { className: '__dfy_label' }, props.label),
          props.help ? h('span', { className: '__dfy_hint' }, props.help) : null
        ),
        h(
          'button',
          {
            type: 'button',
            className: '__dfy_switch' + (props.checked ? ' __dfy_switchOn' : ''),
            onClick: function () {
              props.onChange(!props.checked)
            },
            'aria-pressed': props.checked ? 'true' : 'false'
          },
          h('span', { className: '__dfy_knob' + (props.checked ? ' __dfy_knobOn' : '') })
        )
      )
    }

    function Segmented(props) {
      return h(
        'div',
        { className: '__dfy_field' },
        h('span', { className: '__dfy_label' }, props.label),
        h(
          'div',
          { className: '__dfy_seg' },
          props.options.map(function (o) {
            return h(
              'button',
              {
                type: 'button',
                key: o.value,
                className: '__dfy_segBtn' + (props.value === o.value ? ' __dfy_segOn' : ''),
                onClick: function () {
                  props.onChange(o.value)
                }
              },
              o.label
            )
          })
        ),
        props.help ? h('span', { className: '__dfy_hint' }, props.help) : null
      )
    }

    function Field(props) {
      return h(
        'div',
        { className: '__dfy_field' },
        h('span', { className: '__dfy_label' }, props.label),
        h('input', {
          className: '__dfy_input',
          value: props.value == null ? '' : props.value,
          placeholder: props.placeholder || '',
          onChange: function (e) {
            props.onChange(e.target.value)
          }
        }),
        props.help ? h('span', { className: '__dfy_hint' }, props.help) : null
      )
    }

    function Area(props) {
      return h(
        'div',
        { className: '__dfy_field' },
        h('span', { className: '__dfy_label' }, props.label),
        h('textarea', {
          className: '__dfy_input __dfy_area',
          value: props.value == null ? '' : props.value,
          placeholder: props.placeholder || '',
          onChange: function (e) {
            props.onChange(e.target.value)
          }
        }),
        props.help ? h('span', { className: '__dfy_hint' }, props.help) : null
      )
    }

    /* ── 概览 ────────────────────────────────────────────────────────────── */
    function OverviewTab(props) {
      var c = props.copy
      var st = props.status
      var bot = props.bot
      var data = st.state.data || {}
      var botData = bot.state.data || {}
      var alive = !!data.alive
      return h(
        'div',
        { className: '__dfy_col' },
        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '主机'),
          h(
            'div',
            { className: '__dfy_kv' },
            h('span', { className: '__dfy_k' }, '状态'),
            h('span', { className: '__dfy_v ' + (alive ? '__dfy_ok' : '__dfy_no') }, alive ? '在线 · 端口 ' + (data.port || 3080) : '离线')
          ),
          h(KV, { k: 'Web UI', v: data.webUrl || '（主机未启动）' }),
          h(KV, { k: '机器人', v: data.bound ? '已绑定' : '未绑定' }),
          h(KV, { k: '数据目录', v: data.home || 'C:\\Users\\Vincent\\.dsh-0.2' }),
          h(
            'div',
            { className: '__dfy_row' },
            data.webUrl
              ? h(Btn, { href: data.webUrl, primary: true }, '打开 Web UI')
              : h(Btn, { disabled: true }, '打开 Web UI'),
            data.webUrl
              ? h(Btn, { onClick: function () { c.copy(data.webUrl, 'web') } }, c.copied === 'web' ? '已复制' : '复制地址')
              : null,
            h(Btn, { onClick: function () { st.reload() }, disabled: st.state.loading }, st.state.loading ? '刷新中…' : '刷新状态'),
            props.onRestart ? h(Btn, { onClick: props.onRestart, danger: true }, '重启主机') : null
          )
        ),
        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '机器人名片 · 加好友'),
          botData.qr
            ? h(
                'div',
                { className: '__dfy_qrWrap' },
                h('img', { className: '__dfy_qr', src: botData.qr, alt: '大肥鱼 加好友二维码' }),
                h(
                  'div',
                  { className: '__dfy_qrSide' },
                  h(KV, { k: '昵称', v: botData.name || '—' }),
                  h(KV, { k: 'QQ 号', v: botData.robotUin || '—' }),
                  h(KV, { k: 'AppID', v: botData.appId || '—' }),
                  h('span', { className: '__dfy_hint' }, '手机 QQ → 扫一扫，或直接搜索上面的 QQ 号 / 昵称。'),
                  h(
                    'div',
                    { className: '__dfy_row' },
                    botData.shareUrl ? h(Btn, { href: botData.shareUrl, primary: true }, '打开分享页') : null,
                    botData.shareUrl
                      ? h(Btn, { onClick: function () { c.copy(botData.shareUrl, 'share') } }, c.copied === 'share' ? '已复制' : '复制链接')
                      : null,
                    h(Btn, { onClick: function () { bot.reload(true) }, disabled: bot.state.loading }, bot.state.loading ? '刷新中…' : '刷新名片')
                  )
                )
              )
            : h(
                'div',
                { className: '__dfy_empty' },
                bot.state.loading ? '正在读取机器人名片…' : '暂无二维码：' + (bot.state.error || botData.error || '机器人尚未绑定')
              ),
          h('div', { className: '__dfy_warn' }, '这是加好友码，长期有效；和「绑定」的一次性扫码不是一回事。')
        )
      )
    }

    /* ── 聊天 ────────────────────────────────────────────────────────────── */
    function SessionsTab(props) {
      var c = props.copy
      var s = props.sessions
      var d = s.state.data || {}
      var list = d.sessions || []
      var openState = react.useState('')
      var openId = openState[0]
      var setOpenId = openState[1]

      react.useEffect(function () {
        if (!openId && list.length > 0) setOpenId(list[0].id)
      }, [list.length])

      if (s.state.loading && list.length === 0) return h('div', { className: '__dfy_empty' }, '正在读取会话…')
      if (s.state.error) return h('div', { className: '__dfy_warn' }, '读取失败：' + s.state.error)
      if (list.length === 0) {
        return h(
          'div',
          { className: '__dfy_col' },
          h('div', { className: '__dfy_empty' }, '还没有 QQ 对话。去手机 QQ 给「大肥鱼」发一条消息试试。'),
          h('div', { className: '__dfy_row' }, h(Btn, { onClick: function () { s.reload() } }, '刷新'))
        )
      }

      return h(
        'div',
        { className: '__dfy_col' },
        h(
          'div',
          { className: '__dfy_row' },
          h('span', { className: '__dfy_hint' }, '共 ' + list.length + ' 个会话'),
          h('span', { style: { flex: 1 } }),
          h(Btn, { onClick: function () { s.reload() }, disabled: s.state.loading }, s.state.loading ? '刷新中…' : '刷新'),
          h(Btn, { onClick: function () { c.copy(d.dir || '', 'dir') } }, c.copied === 'dir' ? '已复制' : '复制目录')
        ),
        list.map(function (sess) {
          var open = openId === sess.id
          return h(
            'div',
            { className: '__dfy_sess', key: sess.id },
            h(
              'button',
              {
                type: 'button',
                className: '__dfy_sessHead',
                onClick: function () {
                  setOpenId(open ? '' : sess.id)
                }
              },
              h('span', { className: '__dfy_caret' + (open ? ' __dfy_caretOn' : '') }, '▶'),
              h('span', { className: '__dfy_sessTitle' }, sess.title || '(无标题)'),
              h('span', { className: '__dfy_sessMeta' }, new Date(sess.mtime).toLocaleString('zh-CN'))
            ),
            open
              ? h(
                  'div',
                  { className: '__dfy_sessBody' },
                  (sess.msgs || []).length === 0
                    ? h('div', { className: '__dfy_empty' }, '这个会话里没有可显示的对话。')
                    : (sess.msgs || []).map(function (m, i) {
                        var isUser = m.role === 'user'
                        return h(
                          'div',
                          { className: '__dfy_msg ' + (isUser ? '__dfy_msgU' : '__dfy_msgA'), key: i },
                          h('span', { className: '__dfy_msgRole' }, isUser ? '你' : '大肥鱼'),
                          h('div', { className: '__dfy_bubble ' + (isUser ? '__dfy_bubbleU' : '__dfy_bubbleA') }, m.text)
                        )
                      })
                )
              : null
          )
        })
      )
    }

    /* ── 机器人配置 ──────────────────────────────────────────────────────── */
    function BotTab(props) {
      var cfg = props.config
      var d = cfg.state.data || {}
      var initial = d.config || null
      var draftState = react.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var saveState = react.useState('')
      var saveMsg = saveState[0]
      var setSaveMsg = saveState[1]

      react.useEffect(function () {
        if (initial && draft === null) setDraft(JSON.parse(JSON.stringify(initial)))
      }, [initial])

      if (!draft) {
        return h('div', { className: '__dfy_empty' }, cfg.state.loading ? '正在读取配置…' : '读不到配置：' + (cfg.state.error || '未知'))
      }

      function patch(p) {
        setDraft(Object.assign({}, draft, p))
      }
      function patchAccess(p) {
        patch({ access: Object.assign({}, draft.access || {}, p) })
      }

      var dirty = JSON.stringify(draft) !== JSON.stringify(initial)

      function save() {
        setSaveMsg('saving')
        jsonFetch('/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft)
        })
          .then(function (r) {
            setSaveMsg(r.ok ? 'saved' : 'err:' + (r.error || '?'))
            cfg.reload()
          })
          .catch(function (e) {
            setSaveMsg('err:' + (e && e.message ? e.message : e))
          })
      }

      var accessOpts = [
        { value: 'open', label: '所有人' },
        { value: 'allowlist', label: '白名单' },
        { value: 'off', label: '禁用' }
      ]

      return h(
        'div',
        { className: '__dfy_col' },
        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '服务范围'),
          h(Segmented, {
            label: '私聊',
            value: (draft.access || {}).c2cMode || 'open',
            options: accessOpts,
            onChange: function (v) {
              patchAccess({ c2cMode: v })
            },
            help: '白名单模式下只回名单内的 QQ 号。'
          }),
          (draft.access || {}).c2cMode === 'allowlist'
            ? h(Field, {
                label: '私聊白名单（逗号分隔）',
                value: ((draft.access || {}).c2cAllow || []).join(','),
                placeholder: '例如 123456789,987654321',
                onChange: function (v) {
                  patchAccess({ c2cAllow: v.split(/[,，\s]+/).filter(Boolean) })
                }
              })
            : null,
          h(Segmented, {
            label: '群聊',
            value: (draft.access || {}).groupMode || 'open',
            options: accessOpts,
            onChange: function (v) {
              patchAccess({ groupMode: v })
            }
          }),
          (draft.access || {}).groupMode === 'allowlist'
            ? h(Field, {
                label: '群聊白名单（逗号分隔）',
                value: ((draft.access || {}).groupAllow || []).join(','),
                placeholder: '例如 10001,10002',
                onChange: function (v) {
                  patchAccess({ groupAllow: v.split(/[,，\s]+/).filter(Boolean) })
                }
              })
            : null
        ),
        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '基础设置'),
          h(Switch, {
            label: '群聊仅回复 @机器人 的消息',
            help: '开启后机器人只回应 @ 它的群消息。',
            checked: !!draft.requireMention,
            onChange: function (v) {
              patch({ requireMention: v })
            }
          }),
          h(Switch, {
            label: '流式输出',
            help: '回复内容分段时间推送到聊天。',
            checked: !!draft.streaming,
            onChange: function (v) {
              patch({ streaming: v })
            }
          }),
          h(Switch, {
            label: '显示工具调用结果',
            help: '在聊天中展示 agent 工具调用的结构化结果。',
            checked: !!draft.showToolResults,
            onChange: function (v) {
              patch({ showToolResults: v })
            }
          }),
          h(Switch, {
            label: '调试日志',
            help: '输出更详细的运行日志，排查问题时用。',
            checked: !!draft.debug,
            onChange: function (v) {
              patch({ debug: v })
            }
          })
        ),
        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '模型'),
          h(
            'div',
            { className: '__dfy_grid2' },
            h(Field, {
              label: 'Provider',
              value: draft.provider,
              placeholder: '留空继承宿主默认',
              onChange: function (v) {
                patch({ provider: v })
              }
            }),
            h(Field, {
              label: 'Model',
              value: draft.model,
              placeholder: '留空继承宿主默认',
              onChange: function (v) {
                patch({ model: v })
              }
            })
          ),
          h(Field, {
            label: 'Preset',
            value: draft.preset,
            placeholder: 'Agent preset id，留空继承宿主默认',
            onChange: function (v) {
              patch({ preset: v })
            }
          }),
          h('span', { className: '__dfy_hint' }, '可用模型：deepseek-flash / deepseek-v4-pro。'),
          h(
            'div',
            { className: '__dfy_grid2' },
            h(Field, {
              label: '文本分片上限',
              value: draft.textChunkLimit,
              onChange: function (v) {
                patch({ textChunkLimit: Number(v) || 0 })
              }
            }),
            h(Field, {
              label: '历史条数',
              value: draft.historyLimit,
              onChange: function (v) {
                patch({ historyLimit: Number(v) || 0 })
              }
            })
          )
        ),
        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '个性化提示词'),
          h(Area, {
            label: '群聊额外 system prompt',
            value: draft.groupPrompt,
            placeholder: '只在群聊追加，留空不追加',
            onChange: function (v) {
              patch({ groupPrompt: v })
            }
          }),
          h(Area, {
            label: '私聊额外 system prompt',
            value: draft.directPrompt,
            placeholder: '只在私聊追加，留空不追加',
            onChange: function (v) {
              patch({ directPrompt: v })
            }
          })
        ),
        h(
          'div',
          { className: '__dfy_row' },
          h(Btn, { primary: true, onClick: save, disabled: !dirty || saveMsg === 'saving' }, saveMsg === 'saving' ? '保存中…' : '保存配置'),
          dirty
            ? h(
                Btn,
                {
                  onClick: function () {
                    setDraft(JSON.parse(JSON.stringify(initial)))
                    setSaveMsg('')
                  }
                },
                '放弃修改'
              )
            : null,
          h(Btn, { onClick: function () { cfg.reload() }, disabled: cfg.state.loading }, '重新读取'),
          saveMsg === 'saved' ? h('span', { className: '__dfy_toast __dfy_ok' }, '已保存，重启主机后生效') : null,
          saveMsg.indexOf('err:') === 0 ? h('span', { className: '__dfy_toast __dfy_no' }, saveMsg.slice(4)) : null,
          dirty ? h('span', { className: '__dfy_hint' }, '有未保存的修改') : null
        ),
        h('div', { className: '__dfy_warn' }, '配置写入 qq profile 的 cordis.patch.yml，需要重启 QQ 主机才生效（概览页有「重启主机」）。'),
        h('div', { className: '__dfy_warn' }, 'AppID/AppSecret 不在页面显示，避免泄露；更换凭据请用 QQ 主机 Web UI 的「QQ 机器人」页。'),
        d.hasSecret === false ? h('div', { className: '__dfy_warn' }, '⚠ qq profile 里没读到 AppSecret，机器人可能无法登录。') : null
      )
    }

    /* ── 排障 ────────────────────────────────────────────────────────────── */
    function DebugTab(props) {
      var c = props.copy
      var st = props.status
      var d = st.state.data || {}
      var lines = d.logLines || []
      return h(
        'div',
        { className: '__dfy_col' },
        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '启动与日志'),
          h(KV, { k: '启动命令', v: 'C:\\dsh-0.2\\start-qq-dafeiyu.cmd' }),
          h(
            'div',
            { className: '__dfy_row' },
            h(Btn, { onClick: function () { c.copy('C:\\dsh-0.2\\start-qq-dafeiyu.cmd', 'cmd') } }, c.copied === 'cmd' ? '已复制' : '复制启动命令'),
            h(Btn, { onClick: function () { st.reload() }, disabled: st.state.loading }, '刷新日志')
          ),
          h(KV, { k: '日志文件', v: d.logFile || '—' }),
          lines.length ? h('pre', { className: '__dfy_pre' }, lines.join('\n')) : h('div', { className: '__dfy_empty' }, '暂无日志。')
        ),
        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '数据位置'),
          h(KV, { k: 'DSH_HOME', v: d.home || 'C:\\Users\\Vincent\\.dsh-0.2' }),
          h(KV, { k: '会话目录', v: '...\\.dsh-0.2\\sessions' }),
          h(KV, { k: '机器人配置', v: '...\\.dsh-0.2\\profiles\\qq\\cordis.patch.yml' }),
          h(KV, { k: 'B站值班', v: '...\\.dsh-0.2\\bili-duty' })
        )
      )
    }

    /* ── 主面板 ──────────────────────────────────────────────────────────── */
    /* ── 主动消息 & 表情包 ────────────────────────────────────────────────── */
    function SendTab(props) {
      var c = props.copy
      var peers = props.peers
      var stickers = props.stickers

      var peerList = ((peers.state.data || {}).peers) || []
      var stickerList = ((stickers.state.data || {}).items) || []

      var selState = react.useState('')
      var selPeer = selState[0]
      var setSelPeer = selState[1]
      var textState = react.useState('')
      var text = textState[0]
      var setText = textState[1]
      var msgState = react.useState('')
      var result = msgState[0]
      var setResult = msgState[1]

      react.useEffect(function () {
        if (!selPeer && peerList.length > 0) setSelPeer(peerList[0].id)
      }, [peerList.length])

      function sendProactive() {
        if (!selPeer || !text.trim()) return
        var p = peerList.find(function (x) {
          return x.id === selPeer
        })
        if (!p) return
        setResult('sending')
        jsonFetch('/proactive', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ peerId: p.peerId, scope: p.scope, text: text })
        })
          .then(function (r) {
            setResult(r.ok ? 'sent' : 'err:' + (r.error || '?'))
            if (r.ok) {
              setText('')
              peers.reload()
            }
          })
          .catch(function (e) {
            setResult('err:' + (e && e.message ? e.message : e))
          })
      }

      function sendSticker(name) {
        if (!selPeer) return
        var p = peerList.find(function (x) {
          return x.id === selPeer
        })
        if (!p) return
        setResult('sending')
        jsonFetch('/sticker/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ peerId: p.peerId, scope: p.scope, name: name })
        })
          .then(function (r) {
            setResult(r.ok ? 'sticker-sent' : 'err:' + (r.error || '?'))
          })
          .catch(function (e) {
            setResult('err:' + (e && e.message ? e.message : e))
          })
      }

      return h(
        'div',
        { className: '__dfy_col' },

        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '发送对象'),
          peerList.length === 0
            ? h(
                'div',
                { className: '__dfy_empty' },
                '还没有发现任何 QQ 会话对象。先在手机 QQ 给「大肥鱼」发一条消息，openid 会自动从日志里抓出来。'
              )
            : h(
                'div',
                { className: '__dfy_col' },
                h(
                  'select',
                  {
                    className: '__dfy_input',
                    value: selPeer,
                    onChange: function (e) {
                      setSelPeer(e.target.value)
                    }
                  },
                  peerList.map(function (p) {
                    return h(
                      'option',
                      { key: p.id, value: p.id },
                      (p.scope === 'group' ? '群 ' : '私聊 ') +
                        p.peerId.slice(0, 12) +
                        '… · 本月剩 ' +
                        p.remaining +
                        '/' +
                        p.quota
                    )
                  })
                ),
                h(
                  'div',
                  { className: '__dfy_row' },
                  h(Btn, { onClick: function () { peers.reload() }, disabled: peers.state.loading }, peers.state.loading ? '刷新中…' : '刷新对象'),
                  h(Btn, { onClick: function () { props.config.reload() } }, '刷新配额')
                )
              )
        ),

        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '主动消息'),
          h('span', { className: '__dfy_hint' }, '不回复任何消息，直接推一条给指定的人。受月配额限制（本地保守 3 条/人）。'),
          h('textarea', {
            className: '__dfy_input __dfy_area',
            placeholder: '想说的话…',
            value: text,
            onChange: function (e) {
              setText(e.target.value)
            }
          }),
          h(
            'div',
            { className: '__dfy_row' },
            h(Btn, { primary: true, onClick: sendProactive, disabled: !selPeer || !text.trim() || result === 'sending' }, result === 'sending' ? '发送中…' : '发送'),
            result === 'sent' ? h('span', { className: '__dfy_toast __dfy_ok' }, '已推送，配额 -1') : null,
            result === 'sticker-sent' ? h('span', { className: '__dfy_toast __dfy_ok' }, '表情包已发送') : null,
            result.indexOf('err:') === 0 ? h('span', { className: '__dfy_toast __dfy_no' }, result.slice(4).slice(0, 160)) : null
          ),
          h(
            'div',
            { className: '__dfy_warn' },
            'QQ 官方给主动推送的月配额很小（一般 4 条/用户），本地台账只记 3 条留余量。超了 QQ 会返回 403。'
          )
        ),

        h(
          'div',
          { className: '__dfy_card' },
          h('div', { className: '__dfy_cardTitle' }, '表情包'),
          h(KV, { k: '目录', v: (stickers.state.data || {}).dir || '—' }),
          h(
            'div',
            { className: '__dfy_row' },
            h(Btn, { onClick: function () { stickers.reload() }, disabled: stickers.state.loading }, '刷新'),
            h(
              Btn,
              {
                onClick: function () {
                  c.copy((stickers.state.data || {}).dir || '', 'stickdir')
                }
              },
              c.copied === 'stickdir' ? '已复制' : '复制目录'
            )
          ),
          stickerList.length === 0
            ? h('div', { className: '__dfy_empty' }, '目录里还没有图片。把 gif/png 丢进去再点刷新。')
            : h(
                'div',
                { className: '__dfy_stickerGrid' },
                stickerList.map(function (s) {
                  return h(
                    'div',
                    { className: '__dfy_sticker', key: s.name },
                    h('div', { className: '__dfy_stickerName', title: s.name }, s.name),
                    h(
                      'div',
                      { className: '__dfy_row' },
                      h(Btn, { onClick: function () { c.copy(s.path, 'sp') } }, c.copied === 'sp' ? '已复制' : '复制路径'),
                      h(Btn, { primary: true, onClick: function () { sendSticker(s.name) }, disabled: !selPeer }, '发送')
                    )
                  )
                })
              ),
          h('div', { className: '__dfy_warn' }, 'QQ 机器人没有「表情包」消息类型，这里是把图当图片发（msg_type 7 富媒体）。gif 会动。')
        )
      )
    }

    function Panel() {
      ensureStyle()
      var copyApi = useCopy()
      var status = useAsync(function () {
        return jsonFetch('/status')
      }, 8000)
      var bot = useAsync(function (force) {
        return jsonFetch('/bot' + (force ? '?force=1' : ''))
      })
      var sessions = useAsync(function () {
        return jsonFetch('/sessions?limit=12')
      })
      var config = useAsync(function () {
        return jsonFetch('/config')
      })
      var peers = useAsync(function () {
        return jsonFetch('/peers')
      })
      var stickers = useAsync(function () {
        return jsonFetch('/stickers')
      })

      var tabState = react.useState('overview')
      var tab = tabState[0]
      var setTab = tabState[1]

      var restartState = react.useState('')
      var restartMsg = restartState[0]
      var setRestartMsg = restartState[1]

      var data = status.state.data || {}
      var alive = !!data.alive

      function restartHost() {
        setRestartMsg('restarting')
        jsonFetch('/host/restart', { method: 'POST' })
          .then(function (r) {
            setRestartMsg(r.ok ? 'restarted' : 'err:' + (r.error || '?'))
            setTimeout(function () {
              status.reload()
              sessions.reload()
            }, 12000)
          })
          .catch(function (e) {
            setRestartMsg('err:' + (e && e.message ? e.message : e))
          })
      }

      var tabs = [
        { id: 'overview', label: '概览' },
        { id: 'sessions', label: '聊天' },
        { id: 'send', label: '发送' },
        { id: 'bot', label: '机器人' },
        { id: 'debug', label: '排障' }
      ]

      return h(
        'div',
        { className: '__dfy_root' },
        h(
          'div',
          { className: '__dfy_head' },
          h('span', { className: '__dfy_dot ' + (alive ? '__dfy_dot_on' : '__dfy_dot_off') }),
          h('span', { className: '__dfy_title' }, '大肥鱼 QQ'),
          h('span', { className: '__dfy_badge' }, alive ? '主机在线' : '主机离线'),
          h('span', { className: '__dfy_badge' }, data.bound ? '已绑定' : '未绑定'),
          h('span', { className: '__dfy_headSpacer' }),
          restartMsg === 'restarting' ? h('span', { className: '__dfy_hint' }, '正在重启主机…') : null,
          restartMsg === 'restarted' ? h('span', { className: '__dfy_hint __dfy_ok' }, '已重启，稍等几秒') : null,
          restartMsg.indexOf('err:') === 0 ? h('span', { className: '__dfy_hint __dfy_no' }, restartMsg.slice(4)) : null
        ),
        h(
          'div',
          { className: '__dfy_tabs' },
          tabs.map(function (t) {
            return h(
              'button',
              {
                type: 'button',
                key: t.id,
                className: '__dfy_tab' + (tab === t.id ? ' __dfy_tabOn' : ''),
                onClick: function () {
                  setTab(t.id)
                }
              },
              t.label
            )
          })
        ),
        tab === 'overview' ? h(OverviewTab, { status: status, bot: bot, copy: copyApi.copy, onRestart: restartHost }) : null,
        tab === 'sessions' ? h(SessionsTab, { sessions: sessions, copy: copyApi.copy }) : null,
        tab === 'send' ? h(SendTab, { peers: peers, stickers: stickers, config: config, copy: copyApi.copy }) : null,
        tab === 'bot' ? h(BotTab, { config: config }) : null,
        tab === 'debug' ? h(DebugTab, { status: status, copy: copyApi.copy }) : null
      )
    }

    /* ── 插件 ────────────────────────────────────────────────────────────── */
    var inject = ['slots']

    /**
     * 注册设置分区。全程 try/catch：只加一个入口，绝不能因为席位契约变化
     * 或 slot 缺失把 web boot 打失败（那会让 NEXT 进安全模式）。
     */
    function apply(ctx) {
      try {
        var slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots || typeof slots.inject !== 'function') return
        slots.inject('settings.section', function () {
          try {
            return slots.register(
              { name: 'settings.section', id: 'dafeiyu', order: 28, label: '大肥鱼' },
              function () {
                return h(Panel, {})
              }
            )
          } catch (e) {
            return undefined
          }
        })
      } catch (e) {
        /* 静默降级：没有入口不影响宿主与其它插件 */
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
