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

function walk(dir, out = [], extension = ['.js', '.mjs']) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out, extension)
    else if (extension.some(ext => name.endsWith(ext))) out.push(path)
  }
  return out
}

const walkPy = dir => walk(dir, [], ['.py'])

const files = walk(root)
const pyFiles = walkPy(root)
let bad = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    bad += 1
    console.error(`✖ 语法错误：${relative(root, file)}\n${error.stderr?.toString() ?? error}`)
  }
}
console.log(`语法检查：${files.length} 个 JS 文件，${bad} 个有问题`)

// Python 那一侧单独检查：来源进程不许 import 本项目，语法错却同样会拖垮采集
let pyBad = 0
for (const file of pyFiles) {
  try {
    // 用 compile() 而不是 py_compile：后者会写 __pycache__，把工作区弄脏
    execFileSync('python3', ['-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', file], { stdio: 'pipe' })
  } catch (error) {
    pyBad += 1
    console.error(`✖ Python 语法错误：${relative(root, file)}\n${error.stderr?.toString() ?? error}`)
  }
}
console.log(`语法检查：${pyFiles.length} 个 Python 文件，${pyBad} 个有问题`)
if (bad || pyBad) process.exit(1)

try {
  execFileSync('node', ['--test', 'packages/core/test/**/*.test.js', 'packages/sources/feishu/test/**/*.test.js'], {
    cwd: root, stdio: 'inherit',
  })
} catch {
  process.exit(1)
}
