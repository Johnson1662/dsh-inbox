;(() => {
/**
 * dsh-inbox —— 浏览器半端：设置页里的「个人上下文」面板。
 *
 * DSH 没有「按 schema 自动生成表单」这回事（那是 Koishi 的行为），
 * 面板必须由插件自己注册进 `settings.section`。
 *
 * 结构由宿主给（`data.groups`），这里只负责画：
 *   一个来源一张卡 —— 开关、节奏、投给哪个会话，都在同一张卡里。
 *
 * 校验一律在宿主侧（settings.js），本文件只收集与呈现。
 */
const loader =
  typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function'
    ? window.__ModuleLoader__
    : (() => {
        throw new Error('[dsh-inbox] 需要 DSH ≥ 0.2.0-rc.2（宿主没有 window.__ModuleLoader__），请升级 DSH')
      })()

loader.load({
  id: 'dsh-inbox-core',
  factory: require => {
    const React = require('react')
    const h = React.createElement

    const API = '/personal-context'
    const TIMEOUT_MS = 10000

    const CSS = `
/* 全部用 DSH 自己的设计 token，不猜颜色、不写死字号：
   字体走 --dsw-font-*-{font-family,font-size,font-weight,line-height}，
   颜色走 --dsw-alias-label-* / border-* / card-fill / button-primary-*，
   圆角走 --dsw-radius-*。这样亮暗主题切换不用我们操心。 */
[data-pc]{
  display:flex;flex-direction:column;gap:12px;
  font:var(--dsw-font-s-14-font-weight) var(--dsw-font-s-14-font-size)/var(--dsw-font-s-14-line-height) var(--dsw-font-s-14-font-family);
  color:var(--dsw-alias-label-primary);
}
[data-pc-group]{
  display:flex;flex-direction:column;gap:2px;padding:16px;
  background:var(--dsw-alias-card-fill);
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);
}
[data-pc-group-title]{
  font:var(--dsw-font-s-strong-14-font-weight) var(--dsw-font-s-strong-14-font-size)/var(--dsw-font-s-strong-14-line-height) var(--dsw-font-s-strong-14-font-family);
  color:var(--dsw-alias-label-primary);
  padding-bottom:2px;
}
[data-pc-group-note]{
  font:var(--dsw-font-xs-13-font-weight) var(--dsw-font-xs-13-font-size)/var(--dsw-font-xs-13-line-height) var(--dsw-font-xs-13-font-family);
  color:var(--dsw-alias-label-tertiary);
  padding-bottom:8px;
}
[data-pc-row]{
  display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:7px 0;
}
[data-pc-label]{
  display:flex;flex-direction:column;gap:1px;min-width:0;
  color:var(--dsw-alias-label-primary);
}
[data-pc-picker]{display:flex;flex-direction:column;gap:6px;align-items:flex-end;max-width:420px;}
[data-pc-chips]{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;}
[data-pc-chip]{
  display:inline-flex;align-items:center;gap:6px;
  font:var(--dsw-font-xs-13-font-weight) var(--dsw-font-xs-13-font-size)/var(--dsw-font-xs-13-line-height) var(--dsw-font-xs-13-font-family);
  color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-l2);border:1px solid var(--dsw-alias-border-l2);
  border-radius:999px;padding:2px 4px 2px 10px;max-width:100%;
}
[data-pc-chip] span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pc-chip-x]{
  border:none;background:transparent;cursor:pointer;padding:0 4px;
  color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;
}
[data-pc-chip-x]:hover{color:var(--dsw-alias-label-error);}
[data-pc-empty]{
  font:var(--dsw-font-xs-13-font-weight) var(--dsw-font-xs-13-font-size)/var(--dsw-font-xs-13-line-height) var(--dsw-font-xs-13-font-family);
  color:var(--dsw-alias-label-quaternary);
}
[data-pc-input],[data-pc-select]{
  font:inherit;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-l1);
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);
  padding:5px 9px;
  transition:border-color .12s ease;
}
[data-pc-input]{width:112px;text-align:right;}
[data-pc-select]{min-width:190px;max-width:260px;}
[data-pc-input]:hover,[data-pc-select]:hover{border-color:var(--dsw-alias-border-l3);}
[data-pc-input]:focus-visible,[data-pc-select]:focus-visible{
  outline:none;border-color:var(--dsw-alias-border-selected);
  box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-border-selected) 24%, transparent);
}
[data-pc-row] input[type=checkbox]{
  width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;
}
[data-pc-foot]{display:flex;align-items:center;gap:10px;padding-top:2px;}
[data-pc-btn]{
  font:var(--dsw-font-s-strong-14-font-weight) var(--dsw-font-s-strong-14-font-size)/var(--dsw-font-s-strong-14-line-height) var(--dsw-font-s-strong-14-font-family);
  color:var(--dsw-alias-label-on-color);
  background:var(--dsw-alias-button-primary-fill);
  border:none;border-radius:var(--dsw-radius-md);
  padding:7px 16px;cursor:pointer;
  transition:background .12s ease;
}
[data-pc-btn]:hover:not([disabled]){background:var(--dsw-alias-button-primary-hover);}
[data-pc-btn][disabled]{background:var(--dsw-alias-button-primary-dimmed);cursor:default;}
[data-pc-btn=ghost]{
  color:var(--dsw-alias-label-secondary);
  background:transparent;
  border:1px solid var(--dsw-alias-border-l2);
}
[data-pc-btn=ghost]:hover:not([disabled]){background:var(--dsw-alias-button-ghost-active-fill);}
[data-pc-msg=fail]{
  font:var(--dsw-font-xs-13-font-weight) var(--dsw-font-xs-13-font-size)/var(--dsw-font-xs-13-line-height) var(--dsw-font-xs-13-font-family);
  color:var(--dsw-alias-label-error);
}
[data-pc-msg=ok]{
  font:var(--dsw-font-xs-13-font-weight) var(--dsw-font-xs-13-font-size)/var(--dsw-font-xs-13-line-height) var(--dsw-font-xs-13-font-family);
  color:var(--dsw-alias-state-success-primary);
}
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

    function Row({ label, children }) {
      return h('div', { 'data-pc-row': '' },
        h('div', { 'data-pc-label': '' }, h('span', null, label)),
        children)
    }

    /**
     * 白名单之类别让用户填 username：来源已经把「名字 ↔ username」给过来了，
     * 面板只画名字，提交的仍是能用的 username。
     */
    function Picker({ item, settings, choices, disabled, onChange }) {
      const selected = String(settings[item.key] ?? '').split(',').map(value => value.trim()).filter(Boolean)
      const nameOf = value => choices.find(choice => choice.value === value)?.label ?? value
      const remaining = choices.filter(choice => !selected.includes(choice.value))
      // 按 group 收拢成 optgroup，保留后端给的顺序（群聊在前）
      const buckets = []
      for (const choice of remaining) {
        const group = choice.group ?? ''
        const last = buckets[buckets.length - 1]
        if (last && last.group === group) last.items.push(choice)
        else if (!group) buckets.push({ group: '', items: [choice] })
        else {
          const existing = buckets.find(bucket => bucket.group === group)
          if (existing) existing.items.push(choice)
          else buckets.push({ group, items: [choice] })
        }
      }
      const commit = values => onChange(item.key, values.join(','))
      return h(Row, { label: item.label },
        h('div', { 'data-pc-picker': '' },
          h('div', { 'data-pc-chips': '' },
            selected.length
              ? selected.map(value => h('span', { 'data-pc-chip': '', key: value },
                  h('span', null, nameOf(value)),
                  h('button', {
                    'data-pc-chip-x': '', type: 'button', title: '移除', disabled,
                    onClick: () => commit(selected.filter(other => other !== value)),
                  }, '×')))
              : h('span', { 'data-pc-empty': '' }, '未选择')),
          h('select', {
            'data-pc-select': '', value: '', disabled: disabled || !remaining.length,
            onChange: event => {
              const picked = event.target.value
              event.target.value = ''
              if (picked && !selected.includes(picked)) commit([...selected, picked])
            },
          },
          h('option', { value: '' }, !choices.length ? '会话列表读不到，等一下再试' : remaining.length ? '添加…' : '没有更多可选项'),
          buckets.map(bucket => bucket.group
            ? h('optgroup', { key: bucket.group, label: bucket.group },
                bucket.items.map(choice => h('option', { key: choice.value, value: choice.value }, choice.label)))
            : bucket.items.map(choice => h('option', { key: choice.value, value: choice.value }, choice.label))))))
    }

    function Item({ item, settings, targets, choices, onChange, onTarget, disabled }) {
      if (item.kind === 'boolean') {
        return h(Row, { label: item.label },
          h('input', {
            type: 'checkbox', checked: !!settings[item.key], disabled,
            onChange: event => onChange(item.key, event.target.checked),
          }))
      }
      if (item.kind === 'number') {
        return h(Row, { label: item.label },
          h('input', {
            'data-pc-input': '', type: 'number', value: String(settings[item.key] ?? ''),
            min: item.min, max: item.max, step: item.step, disabled,
            onChange: event => onChange(item.key, Number(event.target.value)),
          }))
      }
      if ((item.kind === 'list' || item.kind === 'text') && item.choicesKey) {
        return h(Picker, { item, settings, choices, disabled, onChange })
      }
      if (item.kind === 'list' || item.kind === 'text') {
        return h(Row, { label: item.label },
          h('input', {
            'data-pc-input': '', type: 'text', value: String(settings[item.key] ?? ''),
            placeholder: item.placeholder ?? '', disabled,
            onChange: event => onChange(item.key, event.target.value),
          }))
      }
      if (item.kind === 'target') {
        const source = String(item.key).replace(/^target:/, '')
        return h(Row, { label: item.label },
          h('select', {
            'data-pc-select': '', value: targets[source] ?? '', disabled,
            onChange: event => onTarget(source, event.target.value),
          },
          h('option', { value: '' }, '（不投）'),
          item.options.map(option => h('option', { key: option.value, value: option.value }, option.label))))
      }
      return null
    }

    const SAVE_DELAY_MS = 700
    const REFRESH_MS = 15000

    /**
     * 没有保存按钮：改完就存（停顿 0.7 秒），后台每 15 秒自己取一次最新值。
     * 正在改的时候不刷新，免得把输入冲掉。
     */
    function Panel() {
      const [data, setData] = React.useState(null)
      const [settings, setSettings] = React.useState(null)
      const [targets, setTargets] = React.useState({})
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState('idle')

      const latest = React.useRef({ settings: null, targets: {}, touched: {} })
      const editing = React.useRef(false)
      const timer = React.useRef(null)
      const flash = React.useRef(null)

      const adopt = next => {
        setData(next)
        setSettings(next.settings)
        latest.current = { settings: next.settings, targets: { ...(next.targets?.current ?? {}) }, touched: {} }
        setTargets({ ...(next.targets?.current ?? {}) })
      }

      const load = React.useCallback(() => {
        if (editing.current) return
        request('/config')
          .then(next => {
            if (editing.current) return
            adopt(next)
            setError('')
          })
          .catch(err => setError(err.message))
      }, [])

      React.useEffect(() => {
        load()
        const id = setInterval(load, REFRESH_MS)
        return () => { clearInterval(id); clearTimeout(timer.current); clearTimeout(flash.current) }
      }, [load])

      const flush = React.useCallback(async () => {
        const payload = { settings: latest.current.settings }
        if (Object.keys(latest.current.touched).length) payload.targets = latest.current.targets
        setStatus('saving')
        setError('')
        try {
          const next = await request('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          adopt(next)
          editing.current = false
          setStatus('saved')
          clearTimeout(flash.current)
          flash.current = setTimeout(() => setStatus(current => (current === 'saved' ? 'idle' : current)), 1600)
        } catch (err) {
          // 存失败就把编辑状态留着：自动刷新不能拿服务端的旧值盖掉用户刚改的东西
          setStatus('error')
          setError(err.message)
        }
      }, [])

      const schedule = () => {
        editing.current = true
        clearTimeout(timer.current)
        timer.current = setTimeout(flush, SAVE_DELAY_MS)
      }

      const change = (key, value) => {
        setSettings(prev => {
          const next = { ...prev, [key]: value }
          latest.current.settings = next
          return next
        })
        schedule()
      }

      const changeTarget = (source, value) => {
        setTargets(prev => {
          const next = { ...prev, [source]: value }
          latest.current.targets = next
          return next
        })
        latest.current.touched[source] = true
        schedule()
      }

      if (error && !data) {
        return h('div', { 'data-pc': '' }, h('div', { 'data-pc-msg': 'fail' }, error))
      }
      if (!data || !settings) return h('div', { 'data-pc': '' }, '正在读取设置…')

      const choicesOf = item => (item.choicesKey ? data.choices?.[item.choicesKey] ?? [] : [])
      const groups = data.groups ?? []
      return h('div', { 'data-pc': '' },
        groups.map(group =>
          h('div', { 'data-pc-group': '', key: group.id ?? group.title },
            h('div', { 'data-pc-group-title': '' }, group.title),
            group.items.map(item => h(Item, {
              key: item.key,
              item,
              settings,
              targets,
              choices: choicesOf(item),
              disabled: false,
              onChange: change,
              onTarget: changeTarget,
            })))),
        h('div', { 'data-pc-foot': '' },
          status === 'saving' ? h('span', { 'data-pc-msg': 'ok' }, '保存中…') : null,
          status === 'saved' ? h('span', { 'data-pc-msg': 'ok' }, '已保存') : null,
          error ? h('span', { 'data-pc-msg': 'fail' }, error) : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-inbox')
        style.textContent = CSS
        document.head.appendChild(style)
        if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'dsh-inbox: 设置面板样式')

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

})()
