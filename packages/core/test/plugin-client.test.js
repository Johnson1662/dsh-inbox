import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/**
 * 浏览器半端没法真跑，但能验两件事：文件能求值、注册的确落在 settings.section 上。
 * 宿主加载失败时最典型的表现是「加载了但什么都没注册」，这个测试就是防它。
 */
function loadClient() {
  const loaded = []
  const injected = []
  const registered = []
  const styles = []

  const slots = {
    inject(name, factory) { injected.push(name); factory() },
    register(options, component) { registered.push({ options, component }); return () => {} },
  }
  const ctx = {
    effect(factory) { return factory() },
    get(name) { return name === 'slots' ? slots : undefined },
  }
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
  }
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) { loaded.push({ id, module: factory(name => (name === 'react' ? fakeReact : null)) }) },
    },
  }

  const sandbox = {
    window,
    document: {
      createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }),
      head: { appendChild: node => styles.push(node) },
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{"ok":true,"data":{}}' }),
    setTimeout,
    clearTimeout,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL('../src/plugin/client.js', import.meta.url), 'utf8'), sandbox)

  assert.equal(loaded.length, 1, 'client.js 应当调用一次 ModuleLoader.load')
  const { module } = loaded[0]
  module.apply(ctx)
  return { loaded: loaded[0], injected, registered, styles, module }
}

test('client.js 注册进 settings.section，并挂上自己的样式', () => {
  const { loaded, injected, registered, styles } = loadClient()
  assert.equal(loaded.id, 'dsh-personal-context-core', 'id 必须与包名一致，否则 client-modules 报重复注册')
  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'personal-context')
  assert.equal(typeof registered[0].options.order, 'number')
  assert.ok(registered[0].options.label)
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(styles.length, 1, '样式应当被插进 head')
  assert.match(styles[0].textContent, /data-pc/)
})

test('没有 slots 服务时安静退出，不抛', () => {
  const sandboxWindow = {
    __ModuleLoader__: { load: ({ factory }) => { const m = factory(() => ({ createElement: () => null })); m.apply({ effect: f => f(), get: () => undefined }) } },
  }
  const sandbox = {
    window: sandboxWindow,
    document: { createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }), head: { appendChild() {} } },
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  assert.doesNotThrow(() => vm.runInContext(readFileSync(new URL('../src/plugin/client.js', import.meta.url), 'utf8'), sandbox))
})
