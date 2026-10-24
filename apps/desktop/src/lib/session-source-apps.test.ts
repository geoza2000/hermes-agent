import { describe, expect, it } from 'vitest'

import { isMessagingSource, MESSAGING_SESSION_SOURCE_IDS, sessionSourceLabel } from './session-source'

// Sessions an app hands to Hermes are tagged `apps` by the worker (hermes_cli/apps_job_runner.py).
// They get their own sidebar section, like a messaging platform, and stay out of local recents.
describe('Hermes Apps session source', () => {
  it('groups app sessions in their own labelled sidebar section', () => {
    expect(isMessagingSource('apps')).toBe(true)
    expect(MESSAGING_SESSION_SOURCE_IDS).toContain('apps')
    expect(sessionSourceLabel('apps')).toBe('Apps')
  })
})
