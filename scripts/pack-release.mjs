#!/usr/bin/env node
/**
 * 打一个可直接安装的发布包：dist/dsh-inbox-<version>.tgz
 *
 * 发布包是自包含的：core 与四路来源都在包内的 packages/ 下，package.json 不写任何
 * 运行依赖，所以 npm 与 pnpm 装出来是同一个结果。入口 index.js 在包根，包内还有
 * cordis.patch.yml（bundle 清单）与各来源的 dsh.source 清单。
 *
 * 用法：node scripts/pack-release.mjs [--out dist]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outIndex = process.argv.indexOf('--out')
const OUT_DIR = resolve(REPO, outIndex === -1 ? 'dist' : process.argv[outIndex + 1])

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'))
const root = readJson(join(REPO, 'package.json'))

/** 包里必须有的东西：入口、bundle 清单、各来源清单。断一项就不出包。 */
function checkContents(dir) {
  const entry = root.main?.replace(/^\.\//, '')
  if (typeof entry !== 'string' || !fs.existsSync(join(dir, entry))) {
    throw new Error(`package.json 的 main 指向的文件不存在：${root.main}`)
  }
  const patch = root.dsh?.bundle?.patch?.replace(/^\.\//, '')
  if (!fs.existsSync(join(dir, patch))) throw new Error(`bundle 清单不存在：${root.dsh?.bundle?.patch}`)
  const sources = fs
    .readdirSync(join(dir, 'packages/sources'))
    .map((name) => readJson(join(dir, 'packages/sources', name, 'package.json')))
  for (const source of sources) {
    if (source.dsh?.source?.name === undefined) {
      throw new Error(`${source.name} 缺 dsh.source 清单，设置面板会长不出这一路`)
    }
  }
  return { entry, patch, sources: sources.map((source) => source.name) }
}

if (Object.keys(root.dependencies ?? {}).length > 0) {
  throw new Error('发布包必须自包含：package.json 不应有 dependencies')
}

const stage = fs.mkdtempSync(join(os.tmpdir(), 'dsh-inbox-pack-'))
const pkgDir = join(stage, 'package')
try {
  fs.mkdirSync(pkgDir)
  const manifest = Object.fromEntries(
    ['name', 'version', 'type', 'description', 'license', 'main', 'exports', 'files', 'dsh',
      'peerDependencies', 'peerDependenciesMeta', 'repository', 'homepage', 'bugs', 'keywords']
      .filter((key) => root[key] !== undefined)
      .map((key) => [key, root[key]]),
  )
  fs.writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const name of root.files) {
    if (name === 'package.json') continue
    const from = join(REPO, name)
    if (!fs.existsSync(from)) throw new Error(`files 里列的 ${name} 不存在`)
    fs.cpSync(from, join(pkgDir, name), {
      recursive: true,
      filter: (source) => !source.includes('/node_modules') && !source.includes('/.git'),
    })
  }
  const contents = checkContents(pkgDir)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const target = join(OUT_DIR, `dsh-inbox-${root.version}.tgz`)
  fs.rmSync(target, { force: true })
  execFileSync('tar', ['czf', target, '-C', stage, 'package'])

  const entries = execFileSync('tar', ['tzf', target], { encoding: 'utf8' }).split('\n').filter(Boolean)
  if (!entries.includes(`package/${contents.entry}`)) {
    throw new Error(`包内缺少入口 package/${contents.entry}`)
  }
  console.log(`产物 ${target}`)
  console.log(`大小 ${fs.statSync(target).size} 字节，${entries.length} 个条目`)
  console.log(`入口 package/${contents.entry}，bundle 清单 package/${contents.patch}`)
  console.log(`来源清单 ${contents.sources.length} 个：${contents.sources.join(', ')}`)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
