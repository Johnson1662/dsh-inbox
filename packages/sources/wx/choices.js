#!/usr/bin/env node
/**
 * 面板「采集哪些会话」的取值来源。
 *
 * 单靠 `wx sessions` 不够：它只列有消息的会话，而且群名要现解联系人库，
 * 解不开就把 username 当名字发出来。所以这里补两手：
 *   1. 从 wx 自己解好密的联系人缓存里取群名（明文 sqlite，node:sqlite 直接读）；
 *   2. 把联系人里有、消息库里还没有的群也补进清单——用户能先勾上，等它有消息。
 *
 * stdout 只放 JSON，日志一律 stderr。取不到就退化成 `wx sessions` 的结果，不报错。
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const DEFAULT_CACHE_DIR = join(homedir(), '.wx-cli', 'cache')
/** 联系人库有坏页，按 rowid 分块读，坏一块不连累其它块。 */
const CHUNK = 200

function log(message) {
  process.stderr.write(`wx-choices: ${message}\n`)
}

/** `wx sessions` 的原始结果；失败当空清单，面板还能靠联系人补齐。 */
export async function readSessions({ bin = 'wx', timeoutMs = 20_000 } = {}) {
  try {
    const { stdout } = await run(bin, ['sessions', '-n', '500', '--json'], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    const payload = JSON.parse(stdout)
    return Array.isArray(payload?.sessions) ? payload.sessions : []
  } catch (error) {
    log(`wx sessions 取不到：${error?.message ?? error}`)
    return []
  }
}

/** wx 把「逻辑库 → 解好密的缓存文件」写在 _mtimes.json 里；找不到就扫目录。 */
export function findContactCache(dir = DEFAULT_CACHE_DIR) {
  const meta = join(dir, '_mtimes.json')
  if (existsSync(meta)) {
    try {
      const map = JSON.parse(readFileSync(meta, 'utf8'))
      for (const [key, entry] of Object.entries(map ?? {})) {
        if (!String(key).startsWith('contact/')) continue
        const path = entry?.path
        if (path && existsSync(path)) return path
      }
    } catch (error) {
      log(`_mtimes.json 读不出来：${error?.message ?? error}`)
    }
  }
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir)
    .filter(name => name.endsWith('.db'))
    .map(name => join(dir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  for (const path of candidates) {
    if (hasContactTable(path)) return path
  }
  return null
}

/**
 * wx 的缓存库是 WAL 模式，只读打开也要在库旁边建 -shm；缓存目录属于 wx 时我们写不进去。
 * 所以统一拷一份到临时目录再读，读完删掉——库有几十兆，拷一次是毫秒级。
 */
function withCopy(path, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wx-cache-'))
  const copy = join(dir, 'c.db')
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`)
    }
    return fn(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function hasContactTable(path) {
  try {
    return withCopy(path, copy => {
      const db = new DatabaseSync(copy, { readOnly: true })
      try {
        return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contact'").get())
      } finally {
        db.close()
      }
    })
  } catch {
    return false
  }
}

/**
 * 联系人缓存里的名字：username → { name, group, inRoom }。
 * 群用群名；人优先备注、其次昵称——微信自己也是这么显示的。
 * 已退出的群也留名字（会话还在时至少能显示成人话），但不往清单里新增。
 */
export function readContacts(path) {
  if (!path) return new Map()
  try {
    return withCopy(path, copy => readContactsFrom(copy))
  } catch (error) {
    log(`联系人缓存打不开：${error?.message ?? error}`)
    return new Map()
  }
}

function readContactsFrom(path) {
  const contacts = new Map()
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    let max = 0
    try {
      const row = db.prepare('SELECT max(rowid) AS n FROM contact').get()
      max = Number(row?.n ?? 0)
    } catch {
      // 统计页也可能坏；给个上界继续按块读，读不到自然停
      max = 20_000
    }
    // 坏页会让整块查询失败；二分下去，坏的那几行认了，其余照读
    const stack = []
    for (let lo = 0; lo <= max; lo += CHUNK) stack.push([lo, Math.min(lo + CHUNK, max + 1)])
    while (stack.length) {
      const [lo, hi] = stack.pop()
      let rows
      try {
        rows = db
          .prepare(
            'SELECT username, nick_name, remark, is_in_chat_room, delete_flag FROM contact WHERE rowid >= ? AND rowid < ?',
          )
          .all(lo, hi)
      } catch {
        if (hi - lo > 1) {
          const mid = (lo + hi) >> 1
          stack.push([lo, mid], [mid, hi])
        }
        continue
      }
      for (const row of rows) {
        const username = String(row?.username ?? '')
        if (!username) continue
        if (Number(row?.delete_flag ?? 0) !== 0) continue
        const group = username.endsWith('@chatroom')
        const candidates = group ? [row?.nick_name] : [row?.remark, row?.nick_name]
        const name = candidates.map(value => String(value ?? '').trim()).find(value => value && value !== username)
        if (!name) continue
        contacts.set(username, { name, group, inRoom: Number(row?.is_in_chat_room ?? 1) !== 0 })
      }
    }
  } finally {
    db.close()
  }
  return contacts
}

/**
 * 合并：会话在前（保持 wx 的最近顺序），缺名字的补上真名，
 * 联系人里有但一条消息都没有的群追加在后（人不追加，几千个没法选）。
 */
export function mergeChoices(sessions = [], contacts = new Map()) {
  const out = []
  const seen = new Set()
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue
    const username = String(session.username ?? '').trim()
    if (!username || seen.has(username)) continue
    seen.add(username)
    const current = String(session.chat ?? '').trim()
    // wx 自己解出名字时以它为准；只补它退化成 username 的那种
    const missing = !current || current === username
    const name = missing ? contacts.get(username)?.name : undefined
    out.push({ ...session, chat: name ?? (current || username) })
  }
  const extra = [...contacts.entries()]
    .filter(([username, contact]) => contact.group && contact.inRoom && !seen.has(username))
    .sort((left, right) => left[1].name.localeCompare(right[1].name, 'zh-Hans-CN'))
    .map(([username, contact]) => ({ username, chat: contact.name, is_group: true, chat_type: 'group', quiet: true }))
  return [...out, ...extra]
}

async function main() {
  const sessions = await readSessions()
  let contacts = new Map()
  try {
    contacts = readContacts(findContactCache())
  } catch (error) {
    log(`联系人缓存读不出来：${error?.message ?? error}`)
  }
  process.stdout.write(`${JSON.stringify({ sessions: mergeChoices(sessions, contacts) })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
