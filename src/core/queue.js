import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT    NOT NULL UNIQUE,
  source       TEXT    NOT NULL,
  sink         TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  actor        TEXT    NOT NULL,
  text         TEXT    NOT NULL DEFAULT '',
  meta         TEXT    NOT NULL DEFAULT '{}',
  state        TEXT    NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  ingested_at  TEXT    NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS events_pending ON events(sink, state, at, seq);
`

/**
 * 队列：整套状态机藏在这五个方法后面。
 *
 * 不变式（调用方必须知道）：
 *  - ingest 幂等：同一 id 重复提交返回 duplicate，不是错误
 *  - take 只读，不改状态；只有 ack / fail 改
 *  - ack 幂等
 *  - 没有任何删除、过期、截断路径
 *  - 同一 sink 同时只有一个消费者（由调用方保证）
 */
export function openQueue(path, { routes = [], now = () => new Date() } = {}) {
  const resolve = createRouter(routes)
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)

  const insert = db.prepare(
    'INSERT OR IGNORE INTO events(id,source,sink,at,actor,text,meta,ingested_at) VALUES (?,?,?,?,?,?,?,?)',
  )
  const select = db.prepare(
    "SELECT id,source,at,actor,text,meta,attempts FROM events WHERE sink=? AND state='pending' ORDER BY at, seq LIMIT ?",
  )
  const markDelivered = db.prepare(
    "UPDATE events SET state='delivered', delivered_at=? WHERE id=? AND state='pending'",
  )
  const markFailed = db.prepare('UPDATE events SET attempts=attempts+1, last_error=? WHERE id=?')
  const countBySource = db.prepare('SELECT source, state, COUNT(*) AS n FROM events GROUP BY source, state')

  return {
    path,

    ingest(envelope) {
      const sink = resolve(envelope.source)
      const result = insert.run(
        envelope.id,
        envelope.source,
        sink,
        envelope.at,
        envelope.actor,
        envelope.text ?? '',
        JSON.stringify(envelope.meta ?? {}),
        now().toISOString(),
      )
      return { id: envelope.id, sink, duplicate: result.changes === 0 }
    },

    take(sink, limit = 100) {
      return select.all(sink, limit).map(row => ({
        id: row.id,
        source: row.source,
        at: row.at,
        actor: row.actor,
        text: row.text,
        meta: JSON.parse(row.meta),
        attempts: row.attempts,
      }))
    },

    ack(ids) {
      const at = now().toISOString()
      for (const id of ids) markDelivered.run(at, id)
    },

    fail(ids, reason = '') {
      for (const id of ids) markFailed.run(String(reason).slice(0, 500), id)
    },

    stats() {
      const perSource = {}
      let pending = 0
      let delivered = 0
      for (const row of countBySource.all()) {
        const bucket = (perSource[row.source] ??= { pending: 0, delivered: 0 })
        if (row.state === 'pending') { pending += row.n; bucket.pending += row.n }
        else { delivered += row.n; bucket.delivered += row.n }
      }
      return { pending, delivered, perSource }
    },

    close() {
      db.close()
    },
  }
}

/** 路由在 ingest 时定下并存成列；没有兜底规则就是配置错误，启动即失败。 */
function createRouter(routes) {
  const list = routes.map(route => ({ sources: route.sources.map(String), sink: String(route.sink) }))
  if (!list.some(route => route.sources.includes('*'))) {
    throw new Error('routes 缺少兜底规则 {"sources":["*"],"sink":"..."}')
  }
  return source => {
    for (const route of list) {
      if (route.sources.includes('*') || route.sources.includes(source)) return route.sink
    }
    throw new Error(`没有任何路由匹配来源 ${source}`)
  }
}
