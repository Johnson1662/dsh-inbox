/**
 * 来源包的发现：不再写死 `src/sources/<name>.js`，而是认一份声明。
 *
 * 约定：装了 `dsh-personal-context-source-*` 这类包之后，它的 package.json 里写着
 *   "dsh": { "source": { "name": "telegram", "runtime": "python", "entry": "worker.py", "fields": [...] } }
 * 守护进程只管按 runtime + entry 起进程，不认识具体来源。
 *
 * 找不到声明时退回老路径（仓库里的 src/sources/<name>.{js,py}），保证升级不断档。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_SOURCE_DIRS = [
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules'),
]

/** 扫若干目录，收集所有带 dsh.source 声明的包。重复名字以先出现的为准。 */
export function loadSourceManifests({ dirs = DEFAULT_SOURCE_DIRS } = {}) {
  const found = new Map()
  for (const dir of dirs) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const candidates = []
    for (const name of entries) {
      if (name.startsWith('.')) continue
      if (name.startsWith('@')) {
        // scoped：@scope/pkg
        try {
          for (const inner of readdirSync(join(dir, name))) candidates.push(join(dir, name, inner))
        } catch {}
      } else {
        candidates.push(join(dir, name))
      }
    }
    for (const pkgDir of candidates) collect(pkgDir, found)
  }
  return [...found.values()]
}

function collect(pkgDir, found) {
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) return
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return
  }
  const source = pkg?.dsh?.source
  if (!source?.name) return
  if (found.has(source.name)) return
  const entry = join(pkgDir, source.entry ?? '')
  found.set(source.name, {
    name: String(source.name),
    label: String(source.label ?? source.name),
    package: String(pkg.name ?? ''),
    version: String(pkg.version ?? ''),
    runtime: String(source.runtime ?? 'node'),
    entry,
    dir: pkgDir,
    fields: Array.isArray(source.fields) ? source.fields : [],
    present: existsSync(entry),
  })
}

/** 声明 → 怎么起进程。runtime 只有两种，别的直接报错，不猜。 */
export function spawnSpec(manifest) {
  if (!manifest?.present) return null
  const runtime = manifest.runtime
  if (runtime === 'python') return { command: 'python3', args: [manifest.entry] }
  if (runtime === 'node') return { command: process.execPath, args: [manifest.entry] }
  throw new Error(`来源 ${manifest.name} 的 runtime 不认识：${runtime}（只支持 node / python）`)
}

/** 目录里"像来源"的子目录：给仓库内老路径兜底用。 */
export function legacySpec(name, root) {
  for (const [extension, command] of [['.js', process.execPath], ['.py', 'python3']]) {
    const path = join(root, `${name}${extension}`)
    if (statSync(path, { throwIfNoEntry: false })?.isFile()) return { command, args: [path], path }
  }
  return null
}
