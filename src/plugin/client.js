/**
 * dsh-personal-context —— 浏览器半端：设置页里的「个人上下文」面板。
 *
 * DSH 没有「按 schema 自动生成表单」这回事（那是 Koishi 的行为），
 * 面板必须由插件自己注册进 `settings.section`。
 *
 * 结构由宿主给（`data.groups`），这里只负责画：
 *   一个来源一张卡 —— 开关、节奏、投给哪个会话，都在同一张卡里。
 *
 * 校验一律在宿主侧（settings.js），本文件只收集与呈现。
 */
const MODULE_LOADER =
  typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function'
    ? window.__ModuleLoader__
    : (() => {
        throw new Error('[dsh-personal-context] 需要 DSH ≥ 0.2.0-rc.2（宿主没有 window.__ModuleLoader__），请升级 DSH')
      })()

MODULE_LOADER.load({
  id: 'dsh-personal-context',
  factory: require => {
    const React = require('react')
    const h = React.createElement

    const API = '/personal-context'
    const TIMEOUT_MS = 10000

    const CSS = `
[data-pc]{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;}
[data-pc-group]{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;background:var(--dsw-alias-bg2,rgba(255,255,255,.03));}
[data-pc-group-title]{font-weight:600;font-size:13px;}
[data-pc-group-note]{font-size:11.5px;opacity:.6;margin-top:-4px;}
[data-pc-row]{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:3px 0;}
[data-pc-label]{display:flex;flex-direction:column;gap:1px;min-width:0;}
[data-pc-hint]{font-size:11.5px;opacity:.55;}
[data-pc-input]{width:112px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg1,transparent);color:inherit;font:inherit;text-align:right;}
[data-pc-input]:focus{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px;}
[data-pc-select]{min-width:190px;max-width:260px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg1,transparent);color:inherit;font:inherit;}
[data-pc-foot]{display:flex;align-items:center;gap:12px;padding-top:4px;}
[data-pc-btn]{padding:6px 14px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font:inherit;font-weight:600;cursor:pointer;}
[data-pc-btn][disabled]{opacity:.5;cursor:default;}
[data-pc-btn=ghost]{background:transparent;color:inherit;font-weight:400;}
[data-pc-msg=fail]{color:#dc2626;}
[data-pc-msg=ok]{color:#16a34a;}
[data-pc-note]{font-size:11.5px;opacity:.55;}
`

    async function request(path, init) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      let response
      try {
        response = await fetch(API + path, { credentials: 'same-origin', signal: controller.signal, ...init })
      } catch (error) {
        const aborted = error?.name === 'AbortError'
        throw new Error(aborted ? `请求超时（${TIMEOUT_MS / 1000} 秒）：${path}` : `连不上插件服务：${error?.message ?? error}`)
      } finally {
        clearTimeout(timer)
      }
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`服务返回了非 JSON（${response.status}）`)
      }
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? `请求失败（${response.status}）`)
      return body.data ?? body
    }

    function Row({ label, hint, children }) {
      return h('div', { 'data-pc-row': '' },
        h('div', { 'data-pc-label': '' },
          h('span', null, label),
          hint ? h('span', { 'data-pc-hint': '' }, hint) : null),
        children)
    }

    function Item({ item, settings, targets, onChange, onTarget, disabled }) {
      if (item.kind === 'boolean') {
        return h(Row, { label: item.label, hint: item.hint },
          h('input', {
            type: 'checkbox', checked: !!settings[item.key], disabled,
            onChange: event => onChange(item.key, event.target.checked),
          }))
      }
      if (item.kind === 'number') {
        return h(Row, { label: item.label, hint: item.hint },
          h('input', {
            'data-pc-input': '', type: 'number', value: String(settings[item.key] ?? ''),
            min: item.min, max: item.max, step: item.step, disabled,
            onChange: event => onChange(item.key, Number(event.target.value)),
          }))
      }
      if (item.kind === 'target') {
        const source = String(item.key).replace(/^target:/, '')
        return h(Row, { label: item.label, hint: item.hint },
          h('select', {
            'data-pc-select': '', value: targets[source] ?? '', disabled,
            onChange: event => onTarget(source, event.target.value),
          },
          h('option', { value: '' }, '（不投）'),
          item.options.map(option => h('option', { key: option.value, value: option.value }, option.label))))
      }
      return null
    }

    function Panel() {
      const [data, setData] = React.useState(null)
      const [settings, setSettings] = React.useState(null)
      const [targets, setTargets] = React.useState({})
      const [error, setError] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const adopt = next => {
        setData(next)
        setSettings(next.settings)
        setTargets({ ...(next.targets?.current ?? {}) })
      }

      const load = React.useCallback(() => {
        request('/config')
          .then(next => { adopt(next); setError('') })
          .catch(err => setError(err.message))
      }, [])
      React.useEffect(load, [load])

      const change = (key, value) => setSettings(prev => ({ ...prev, [key]: value }))
      const changeTarget = (source, value) => setTargets(prev => ({ ...prev, [source]: value }))

      const save = async () => {
        setBusy(true); setMsg(''); setError('')
        try {
          const next = await request('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings, targets }),
          })
          adopt(next)
          setMsg('已保存')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }

      if (error && !data) {
        return h('div', { 'data-pc': '' },
          h('div', { 'data-pc-msg': 'fail' }, error),
          h('button', { 'data-pc-btn': 'ghost', onClick: load }, '重试'))
      }
      if (!data || !settings) return h('div', { 'data-pc': '' }, '正在读取设置…')

      const groups = data.groups ?? []
      return h('div', { 'data-pc': '' },
        groups.map(group =>
          h('div', { 'data-pc-group': '', key: group.id ?? group.title },
            h('div', { 'data-pc-group-title': '' }, group.title),
            group.note ? h('div', { 'data-pc-group-note': '' }, group.note) : null,
            group.items.map(item => h(Item, {
              key: item.key,
              item,
              settings,
              targets,
              disabled: busy,
              onChange: change,
              onTarget: changeTarget,
            })))),
        h('div', { 'data-pc-foot': '' },
          h('button', { 'data-pc-btn': '', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { 'data-pc-btn': 'ghost', onClick: load, disabled: busy }, '重新读取'),
          error ? h('span', { 'data-pc-msg': 'fail' }, error) : null,
          msg ? h('span', { 'data-pc-msg': 'ok' }, msg) : null),
        h('div', { 'data-pc-note': '' }, data.note ?? ''))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-personal-context')
        style.textContent = CSS
        document.head.appendChild(style)
        if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'dsh-personal-context: 设置面板样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'personal-context', order: 33, label: '个人上下文' },
          Panel,
        ))
      },
    }
  },
})
