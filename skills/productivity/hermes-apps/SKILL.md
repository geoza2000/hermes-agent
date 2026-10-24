---
name: hermes-apps
description: Build, preview and improve personal Hermes Apps from chat.
version: 1.0.0
author: George Zaimis (geoza2000), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [apps, pwa, mini-apps, telemetry, desktop]
    category: productivity
    related_skills: [test-driven-development]
---

# Hermes Apps Skill

Hermes Apps are small web apps you build for the user and keep improving across sessions. They
appear under **Apps** in Hermes Desktop, open in any browser, and install to a phone home screen.
This skill covers creating an app, editing its draft, getting approval, publishing, and using its
usage data to propose improvements. It does not publish anything without the user's approval.

## When to Use

- The user asks for an app, tool, tracker, dashboard or "mini app" for something they do repeatedly.
- The user wants to continue, change or fix an existing app (they may name it or its slug).
- The user describes a workflow in chat that an existing app should handle: suggest the app change.
- A scheduled improvement review runs for the user's apps.

## Prerequisites

- The `hermes apps` CLI (part of Hermes). Apps live in the active profile's home under `apps/`.
- Use `terminal` for CLI calls and `write_file`, `patch`, `read_file` for the app's files.

## How to Run

Every app has a **draft** (what you edit) and published **versions** (what users see). Publishing
copies the draft into a new immutable version; rolling back switches the current version.

```
hermes apps list
hermes apps create invoices --name "Invoices" --icon "🧾" --description "Create and archive invoices"
hermes apps path invoices        # prints the draft folder to edit
hermes apps publish invoices --note "Add VAT selector"
hermes apps rollback invoices 3
hermes apps set invoices --visibility public
hermes apps insights invoices --days 7 --json
hermes apps agent invoices --prompt "Extract supplier, number, date, VAT and total." --skill invoice-processing
hermes apps data set invoices records --json '[]'
hermes apps data get invoices records
hermes apps jobs invoices
```

## Quick Reference

| Need | Do |
|---|---|
| Entry point | `draft/index.html` (required). Plain HTML, CSS and JS; relative asset paths. |
| Save records | `await hermes.data.set('invoices', rows)` / `await hermes.data.get('invoices')` |
| List or delete records | `await hermes.data.keys()` / `await hermes.data.delete('key')` |
| Custom usage event | `hermes.track('invoice_created', { lines: 3 })`, no personal values |
| Name a control in telemetry | `data-track="new-invoice"` on buttons and fields |
| Viewer type | `hermes.viewer` is `owner` or `public`; data is owner-only |
| Hand work to Hermes | `const job = await hermes.session.run({ prompt, files, context }, { onUpdate })` |
| Show progress | `onUpdate(job)` gets `job.status` and `job.steps`; `job.result.text` / `job.result.json` when done |
| Questions | Default: `hermes.ui.question` shows a form. Custom: pass `onQuestion: async q => ({ q0: 'answer' })` |
| Continue the conversation | `await job.send('Also mark it paid')` then `await job.wait()` |
| Unanswered questions | `await hermes.session.list({ pending: true })` on open; `await job.answer({ q0: '…' })` resumes it |

The runtime (`window.hermes`) is injected into every HTML page automatically. Do not add it yourself.

## Procedure

1. **Find or create the app.** Run `hermes apps list`. Reuse a matching app instead of creating a
   duplicate. For a new app choose a short lowercase slug and run `hermes apps create`.
2. **Agree on scope in one or two sentences** before writing much code: what the app does, the main
   screen, and what it stores. Ask one question only if the core purpose is ambiguous.
3. **Edit the draft** in the folder `hermes apps path <slug>` prints. Build mobile-first: a single
   column under 600px, touch targets at least 44px, `viewport-fit=cover`, system fonts. The same page
   renders in Desktop, a browser and a phone, so never branch on the device.
4. **Store data only through `hermes.data`.** Apps run in a sandboxed, opaque origin: `localStorage`,
   `IndexedDB` and cookies throw or vanish. Keep each key under 256 KB; split large collections.
5. **Use the user's connections from the agent side, not the app.** An app cannot call Google Drive,
   email or other connectors directly. When the user wants files in Drive or a sent email, do it in the
   chat with the connected tool, and have the app hold the records. Say this plainly when it matters.
6. **Show the draft.** Tell the user to open the app in Desktop and switch the preview to **Draft**,
   or describe what changed. Never claim a visual result you have not checked.
7. **Publish only after approval** of the exact change: `hermes apps publish <slug> --note "<what changed>"`.
   A previous version is always one `hermes apps rollback` away.
8. **Apps are personal for now.** Never change visibility on your own. Public apps are reachable by anyone with the link. Set
   `--visibility public` only when the user explicitly asks, and remind them their app data stays private.

### Apps that hand work to Hermes

Use this when the app needs Hermes itself: reading a photo or PDF, judging, asking, or using the
user's connections (for example invoices filed in Drive). The app is the interface, a skill holds
the rules, and the Hermes session does the work.

1. Put the rules in a skill (create or reuse one), then set the app's session setup:
   `hermes apps agent <slug> --prompt "<what every request is for>" --skill <skill>`.
2. In the app, call `hermes.session.run({ prompt, files, context })`. Files come from an
   `<input type="file" accept="image/*,application/pdf" capture>` or drag and drop.
3. Each request runs as its own Hermes session tagged `apps`. Desktop groups these under **Apps**
   in the sidebar, and the app's page lists them with an Open session link.
4. The session asks with the `clarify` tool; the question appears in the app and the answer
   returns to the same turn. If nobody answers within 2 minutes, the turn ends and the request
   becomes `waiting` (question and session id kept). `job.wait()` returns it with `job.pending`
   true. On open, list `hermes.session.list({ pending: true })` and show what needs input;
   `job.answer(...)` later resumes the same session. The app owns how it shows pending items.
5. For structured results, the prompt asks for a final fenced `json` block; the app reads
   `job.result.json`. Either the app saves it with `hermes.data.set`, or the session saves it with
   `hermes apps data set`. Pick one owner per record to avoid double writes.
6. Apps are personal: sessions are owner-only and unattended: dangerous commands are refused unless the owner set
   `approvals.unattended_mode: approve`. At most two requests per app run at once.

### Improving from usage

- **In chat, immediately:** if the user asks for something the app should do, offer the concrete app
  change right then (one sentence, then edit the draft if they agree).
- **On review (weekly by default):** run `hermes apps insights <slug> --days 7 --json` for each app.
  Look for repeated manual work (the same field edited after every create), unused features, errors
  and slow actions. Propose at most three concrete, low-risk changes per app, each with the evidence
  ("you changed the due date on 9 of 10 invoices"). Do not apply them until the user approves.
- If the user wants a scheduled review, create it with the cron tool only after they choose the cadence
  (after each session, daily, weekly or manual), and keep its output as proposals for approval.

## Pitfalls

- `hermes apps publish` fails when `draft/index.html` is missing. Keep the entry point there.
- Absolute asset paths (`/style.css`) escape the app's base path and 404. Use relative paths.
- Telemetry never includes typed values unless the owner enabled them; never ask the user to turn
  that on to make your job easier, and never put personal data into `hermes.track` properties.
- External scripts and CDNs work, but the app must still function offline from its own files when
  possible. Prefer small inline code over large frameworks.
- Public viewers get `hermes.data` and `hermes.session` errors by design. Design public apps to work without them.
- `hermes.session` needs Hermes running on the owner's machine. Show the job status, and a clear
  message when a request fails, instead of assuming it finished.

## Verification

- `hermes apps show <slug>` reports the expected `current_version` after a publish.
- Open the app in Desktop (Apps > the app) and confirm the Live preview shows the published change.
- After real use, `hermes apps insights <slug>` shows events; zero events with telemetry on means the
  app has not been opened since the change, not that the runtime failed.
