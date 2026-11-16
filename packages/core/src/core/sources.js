/**
 * 来源包的发现：不再写死 `src/sources/<name>.js`，而是认一份声明。
 *
 * 约定：装了 `dsh-inbox-source-*` 这类包之后，它的 package.json 里写着
 *   "dsh": { "source": { "name": "telegram", "runtime": "python", "entry": "worker.py", "fields": [...] } }
 * 守护进程只管按 runtime + entry 起进程，不认识具体来源。
 *
 * 找不到声明时退回老路径（仓库里的 src/sources/<name>.{js,py}），保证升级不断档。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 两处：装进 profile 的来源包，以及源码树里并排的 packages/（开发时）
const PROFILE_MODULES = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
const SIBLING_PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const DEFAULT_SOURCE_DIRS = [PROFILE_MODULES, SIBLING_PACKAGES]

/** 一个目录下所有可能是包的目录：平铺的，以及 @scope/pkg 两层。 */
function candidateDirs(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (!name.startsWith('@')) {
      out.push(join(dir, name))
      continue
    }
    try {
      for (const inner of readdirSync(join(dir, name))) out.push(join(dir, name, inner))
    } catch {}
  }
  return out
}

/** 分组目录（packages/sources/telegram 这类）里的下一层。 */
function groupedDirs(pkgDir) {
  try {
    return readdirSync(pkgDir)
      .filter(name => !name.startsWith('.'))
      .map(name => join(pkgDir, name))
  } catch {
    return []
  }
}

/** 扫若干目录，收集所有带 dsh.source 声明的包。重复名字以先出现的为准。 */
export function loadSourceManifests({ dirs = DEFAULT_SOURCE_DIRS } = {}) {
  const found = new Map()
  for (const dir of dirs) {
    for (const pkgDir of candidateDirs(dir)) {
      // 有 package.json 就不是分组目录，不必再往下看
      if (collect(pkgDir, found)) continue
      for (const inner of groupedDirs(pkgDir)) collect(inner, found)
    }
  }
  return [...found.values()]
}

/** 读一个目录的 package.json：没有 → undefined，读坏了 → null。 */
function readManifest(pkgDir) {
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

/** 包声明 → 我们认识的来源清单。没有 dsh.source 就不是来源包。 */
function toSourceManifest(pkgDir, pkg) {
  const source = pkg?.dsh?.source
  if (!source?.name) return null
  const entry = join(pkgDir, source.entry ?? '')
  return {
    name: String(source.name),
    label: String(source.label ?? source.name),
    package: String(pkg.name ?? ''),
    version: String(pkg.version ?? ''),
    runtime: String(source.runtime ?? 'node'),
    entry,
    dir: pkgDir,
    fields: Array.isArray(source.fields) ? source.fields : [],
    present: existsSync(entry),
  }
}

/** 收下一个包。返回「这个目录算不算包目录」，调用方据此决定要不要再往里看。 */
function collect(pkgDir, found) {
  const pkg = readManifest(pkgDir)
  if (pkg === undefined) return false
  if (pkg === null) return true
  const manifest = toSourceManifest(pkgDir, pkg)
  if (manifest && !found.has(manifest.name)) found.set(manifest.name, manifest)
  return true
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
