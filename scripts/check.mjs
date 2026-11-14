#!/usr/bin/env node
/**
 * 守恒检查：库里条数 = 待投 + 已投，不存在第三种状态。
 * 用法：node scripts/check.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const stateDir = (process.env.PC_STATE_DIR ?? '~/.dsh/state/personal-context').replace(/^~/, homedir())
const db = new DatabaseSync(join(stateDir, 'context.sqlite'))

const states = db.prepare('SELECT state, COUNT(*) AS n FROM events GROUP BY state').all()
const bySource = db.prepare('SELECT source, state, COUNT(*) AS n FROM events GROUP BY source, state ORDER BY source').all()
const total = states.reduce((sum, row) => sum + row.n, 0)
const known = states.filter(row => row.state === 'pending' || row.state === 'delivered')
const unknown = states.filter(row => row.state !== 'pending' && row.state !== 'delivered')

console.log(`总条数 ${total}`)
for (const row of states) console.log(`  ${row.state.padEnd(10)} ${row.n}`)
console.log('按来源：')
for (const row of bySource) console.log(`  ${row.source.padEnd(12)} ${row.state.padEnd(10)} ${row.n}`)

if (unknown.length) {
  console.error(`✗ 出现第三种状态：${unknown.map(row => `${row.state}=${row.n}`).join(', ')}`)
  process.exit(1)
}
const counted = known.reduce((sum, row) => sum + row.n, 0)
if (counted !== total) {
  console.error(`✗ 条数不守恒：${counted} != ${total}`)
  process.exit(1)
}
console.log('✓ 条数守恒（只有 pending / delivered 两种状态）')
