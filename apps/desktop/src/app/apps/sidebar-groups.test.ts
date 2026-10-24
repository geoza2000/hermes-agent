import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { buildAppSessionGroups } from './sidebar-groups'

const row = (id: string, extra: Partial<SessionInfo> = {}) => ({ id, source: 'apps', ...extra }) as SessionInfo

describe('buildAppSessionGroups', () => {
  it('groups Apps sessions by the app that started them, unknown ones last under Other', () => {
    const index = {
      apps: { beat: { icon: '🎛️', name: 'Beat Lab' }, invoices: { icon: '🧾', name: 'Invoices' } },
      sessions: { s1: 'invoices', s2: 'beat', s3: 'invoices', root: 'beat' }
    }

    const groups = buildAppSessionGroups(
      [row('s1'), row('s2'), row('s3'), row('s4'), row('tip', { _lineage_root_id: 'root' })],
      index,
      'Other'
    )

    expect(groups.map(group => [group.label, group.sessions.map(s => s.id)])).toEqual([
      ['🎛️ Beat Lab', ['s2', 'tip']],
      ['🧾 Invoices', ['s1', 's3']],
      ['Other', ['s4']]
    ])
    expect(groups.every(group => group.mode === 'source' && group.sourceId === 'apps')).toBe(true)
  })

  it('puts everything under Other until the index loads', () => {
    expect(buildAppSessionGroups([row('s1')], null, 'Other').map(group => group.label)).toEqual(['Other'])
  })
})
