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
  delivered_at TEXT,
  ticket       TEXT,
  leased_until TEXT
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
  migrate(db)

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
  const countPending = db.prepare("SELECT COUNT(*) AS n FROM events WHERE sink=? AND state='pending'")

  const claimable = db.prepare(
    "SELECT id,source,at,actor,text,meta,attempts FROM events WHERE sink=? AND state='pending' AND (leased_until IS NULL OR leased_until < ?) ORDER BY at, seq LIMIT ?",
  )
  const lease = db.prepare('UPDATE events SET ticket=?, leased_until=? WHERE id=? AND state=\'pending\'')
  const releaseExpired = db.prepare(
    "UPDATE events SET ticket=NULL, leased_until=NULL WHERE state='pending' AND leased_until IS NOT NULL AND leased_until < ?",
  )
  const releaseTicket = db.prepare("UPDATE events SET ticket=NULL, leased_until=NULL WHERE ticket=? AND state='pending'")
  const releaseSome = db.prepare("UPDATE events SET ticket=NULL, leased_until=NULL WHERE ticket=? AND state='pending' AND id=?")
  const deliverTicket = db.prepare(
    "UPDATE events SET state='delivered', delivered_at=?, ticket=NULL, leased_until=NULL WHERE ticket=? AND state='pending' AND id=?",
  )
  const pendingCount = db.prepare("SELECT COUNT(*) AS n FROM events WHERE sink=? AND state='pending'")
  const ticketIds = ticket => ticketIdsOf(db, ticket)

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

    /** 该 sink 还有多少条待投。只读、只数；积压放大用它决定这一轮的批次上限。 */
    pending(sink) {
      return Number(countPending.get(sink)?.n ?? 0)
    },

    ack(ids) {
      const at = now().toISOString()
      for (const id of ids) markDelivered.run(at, id)
    },

    fail(ids, reason = '') {
      for (const id of ids) markFailed.run(String(reason).slice(0, 500), id)
    },

    /**
     * 取一批待投的，并给它们上一把租约（小票）。
     *
     * 与 take 的区别：take 只读，谁都能看；takeBatch 把这几条"划走"，
     * 别的消费者拿不到，直到 done / retry / 租约超时。
     */
    takeBatch(sink, limit = 50, { leaseMs = 300_000, ticket } = {}) {
      const at = now()
      const iso = at.toISOString()
      releaseExpired.run(iso)

      const id = ticket ?? `t:${at.getTime().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
      const until = new Date(at.getTime() + leaseMs).toISOString()
      const rows = claimable.all(sink, iso, limit)
      for (const row of rows) lease.run(id, until, row.id)

      return {
        ticket: id,
        events: rows.map(row => ({
          id: row.id,
          source: row.source,
          at: row.at,
          actor: row.actor,
          text: row.text,
          meta: JSON.parse(row.meta),
          attempts: row.attempts,
        })),
        backlog: pendingCount.get(sink).n,
        expiresAt: until,
      }
    },

    /** 投完了：只把点名的几条标已投，同小票里没点名的放回队列。 */
    done(ticket, ids = []) {
      const at = now().toISOString()
      let delivered = 0
      const keep = new Set(ids)
      for (const id of keep) delivered += deliverTicket.run(at, ticket, id).changes
      let released = 0
      if (keep.size) {
        for (const id of ticketIds(ticket)) if (!keep.has(id)) released += releaseSome.run(ticket, id).changes
      } else {
        released += releaseTicket.run(ticket).changes
      }
      return { delivered, released }
    },

    /** 没投成：整张小票退回队列，记一次失败原因。 */
    retry(ticket, reason = '') {
      const ids = ticketIds(ticket)
      for (const id of ids) markFailed.run(String(reason).slice(0, 500), id)
      const released = releaseTicket.run(ticket).changes
      return { released, ids }
    },

    /** 当前有多少条被划走还没回话（调试用）。 */
    leased(sink) {
      return db.prepare("SELECT COUNT(*) AS n FROM events WHERE sink=? AND state='pending' AND ticket IS NOT NULL").get(sink).n
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

/** 某张小票现在攥着哪些事件 id。 */
function ticketIdsOf(db, ticket) {
  return db.prepare("SELECT id FROM events WHERE ticket=? AND state='pending'").all(ticket).map(row => row.id)
}

/** 老库补列：ticket / leased_until 是后加的，已有 profile 不该因为升级而炸。 */
function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(events)').all().map(row => row.name))
  if (!columns.has('ticket')) db.exec('ALTER TABLE events ADD COLUMN ticket TEXT')
  if (!columns.has('leased_until')) db.exec('ALTER TABLE events ADD COLUMN leased_until TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS events_lease ON events(sink, state, leased_until)')
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
