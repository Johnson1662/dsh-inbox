import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toChoices } from '../choices.js'

test('仓库清单：自己的在前，再组织，再协作，同组按名字排', () => {
  const repos = [
    { full_name: 'alice/zeta', owner: { login: 'alice', type: 'User' } },
    { full_name: 'Johnson1662/dsh-inbox', owner: { login: 'Johnson1662', type: 'User' } },
    { full_name: 'acme/tools', owner: { login: 'acme', type: 'Organization' } },
    { full_name: 'acme/alpha', owner: { login: 'acme', type: 'Organization' } },
    { full_name: 'alice/beta', owner: { login: 'alice', type: 'User' } },
  ]
  assert.deepEqual(
    toChoices(repos, 'Johnson1662').map(item => [item.full_name, item.group]),
    [
      ['Johnson1662/dsh-inbox', '我的仓库'],
      ['acme/alpha', '组织'],
      ['acme/tools', '组织'],
      ['alice/beta', '协作'],
      ['alice/zeta', '协作'],
    ],
  )
})

test('仓库清单：空的和重复的丢掉', () => {
  const repos = [{ full_name: '' }, { full_name: 'a/b' }, { full_name: 'a/b' }, null]
  assert.deepEqual(toChoices(repos).map(item => item.full_name), ['a/b'])
})
