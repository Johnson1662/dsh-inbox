#!/usr/bin/env node
/**
 * 设置面板的可选仓库清单。
 *
 * 面板只认识"跑一个命令、读一段 JSON"这一个约定：这里把 `gh` 的返回整理成
 * `{ repos: [{ full_name, group }] }`，面板按 full_name 显示、按 full_name 提交。
 *
 * 只读，不改任何东西；拿不到 token 就输出空清单，面板退化成手填。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PER_PAGE = 100

/** 名字里的 owner 分组，面板按组排：自己的在前，组织与协作的在后。 */
function groupOf(repo, viewer) {
  const owner = String(repo?.owner?.login ?? '')
  if (owner && owner === viewer) return '我的仓库'
  if (repo?.owner?.type === 'Organization') return '组织'
  return '协作'
}

/** gh 的 JSON → 面板要的 { value, label, group } 三件套（label 由值直接给）。 */
export function toChoices(repos = [], viewer = '') {
  const out = []
  const seen = new Set()
  for (const repo of repos) {
    const value = String(repo?.full_name ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push({ full_name: value, group: groupOf(repo, viewer), private: Boolean(repo?.private) })
  }
  const order = ['我的仓库', '组织', '协作']
  return out.sort((a, b) => {
    const byGroup = order.indexOf(a.group) - order.indexOf(b.group)
    return byGroup !== 0 ? byGroup : a.full_name.localeCompare(b.full_name)
  })
}

async function token(env = process.env, exec = run, bin = 'gh') {
  const direct = env.PERSONAL_CONTEXT_SOURCE_TOKEN || env.PERSONAL_CONTEXT_GITHUB_TOKEN
  if (direct) return String(direct).trim()
  const { stdout } = await exec(bin, ['auth', 'token'], { timeout: 10_000 })
  return String(stdout ?? '').trim()
}

/** 同一个 token 顺带问一次登录账号，用来把"我的仓库"分到第一组。 */
async function github(path, token, doFetch) {
  const response = await doFetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
  return response.json()
}

export async function fetchRepos(env = process.env, exec = run, bin = 'gh', doFetch = fetch) {
  const value = await token(env, exec, bin)
  if (!value) return { repos: [] }
  const [me, rows] = await Promise.all([
    github('/user', value, doFetch),
    github(
      `/user/repos?per_page=${PER_PAGE}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      value,
      doFetch,
    ),
  ])
  return { repos: toChoices(Array.isArray(rows) ? rows : [], String(me?.login ?? '')) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify(await fetchRepos())}\n`)
  } catch (error) {
    // 面板拿不到清单只是少了选择器，不该让整个设置页红掉
    process.stderr.write(`github: 拉仓库清单失败：${error?.message ?? error}\n`)
    process.stdout.write(`${JSON.stringify({ repos: [] })}\n`)
  }
}
