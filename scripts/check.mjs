#!/usr/bin/env node
/**
 * 提交前的统一检查：语法 + 测试。
 * 不引第三方 lint——运行时零依赖是底线，也免得贡献者为了跑检查装一堆东西。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const SKIP = new Set(['node_modules', '.git', '.scratch', 'local-pkgs'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(path)
  }
  return out
}

const files = walk(root)
let bad = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    bad += 1
    console.error(`✖ 语法错误：${relative(root, file)}\n${error.stderr?.toString() ?? error}`)
  }
}
console.log(`语法检查：${files.length} 个文件，${bad} 个有问题`)
if (bad) process.exit(1)

try {
  execFileSync('node', ['--test', 'packages/core/test/**/*.test.js', 'packages/sources/feishu/test/**/*.test.js'], {
    cwd: root, stdio: 'inherit',
  })
} catch {
  process.exit(1)
}
