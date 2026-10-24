/** Strings for the Apps improvements panel. English for now; other locales fall back to it. */
export const IMPROVEMENTS_COPY = {
  title: 'Improvements',
  intro:
    'Hermes looks at how you use each app and suggests up to three small changes, with the evidence. Nothing changes until you approve it, and you still publish yourself.',
  enabled: 'Review usage and suggest improvements',
  when: 'When',
  cap: 'Token cap per run',
  autoOff: 'Automatic changes are off: every suggestion waits for your approval. What you type into apps is never sent to the review.',
  save: 'Save',
  saved: 'Saved. Apps without their own setting follow this.',
  savedApp: 'Saved for this app.',
  ownSchedule: 'Use a different schedule for this app',
  following: (schedule: string, cap: number) => `${schedule}, up to ${cap.toLocaleString()} tokens per run.`,
  off: 'Reviews are off.',
  runNow: 'Run review now',
  running: 'Reviewing…',
  started: 'Review started. Suggestions appear here when it finishes.',
  lastRun: 'Last review',
  tokens: (used: number, cap: number) => `${used.toLocaleString()} of ${cap.toLocaleString()} tokens`,
  none: 'No suggestions waiting.',
  change: (path: string) => `Change in ${path}`,
  approve: 'Approve',
  dismiss: 'Dismiss',
  applied: 'Applied to the draft. Switch the preview to Draft, then publish when you are happy.',
  publish: 'Publish draft',
  publishTitle: 'Publish this draft?',
  publishBody: 'It replaces the live app on every device. Earlier versions stay available to restore.',
  published: (version: number) => `Published v${version}.`,
  schedules: {
    weekly: 'Weekly, Sunday 20:00',
    daily: 'Daily, 20:00',
    'after-session': 'After each app request',
    manual: 'Only when I run it'
  },
  runStatus: {
    done: 'Finished',
    running: 'Running',
    failed: 'Failed',
    budget_exhausted: 'Stopped at the token cap',
    no_evidence: 'Skipped: no usage recorded yet'
  } as Record<string, string>,
  installTitle: 'Install on this device',
  installMac: 'In Chrome or Edge: Open in browser, then the install icon in the address bar. In Safari on Mac: File, then Add to Dock.',
  installPhone:
    'On iPhone: open the app in Safari, tap Share, then Add to Home Screen. On Android: Chrome menu, then Install app. You sign in once inside the installed app.',
  installTip: 'Use this often? Install it and it opens like any other app.',
  notNow: 'Not now',
  showMe: 'Show me how'
}
