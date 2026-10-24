# Hermes Apps dashboard checkpoint

Branch: `feat/hermes-apps`. This continues the Apps implementation based at
`8bb77947ff99c6a519afcdcb2ca3cd3505f1ede4`; it is **not the complete improvement-loop feature**.

## Implemented

- Apps navigation and `/apps` page in the existing dashboard SPA/server.
- Profile-scoped list, private starter-draft creation, sandboxed draft preview with full-screen
  preview link, publish confirmation, and recent request status (pending questions direct the
  owner back into the app). The app itself opens full-screen in a separate browser tab.
- Public Hermes address saved as `apps.public_base_url` in the selected profile's config through
  the existing config API, with read-back verification. Copy phone link uses the stable
  `/apps/<profile>/<slug>/` entry, preserving a configured proxy prefix. It never copies an
  expiring capability URL as a permanent install link.
- Gentle dismissible device-specific install guidance after dashboard starter creation, plus an
  install-help button on every app card. It is guidance, not a forced browser install prompt.
- Existing session/capability security stays intact: `/apps/` is still protected, app content
  still has an opaque CSP sandbox (no `allow-same-origin`), and capabilities retain their expiry.
- Regression tests exercise the existing OAuth `next` round trip back to a private app, and
  prove revocation still rejects a capability while the installed manifest starts at sign-in.
  These passed without needing an authentication implementation change.

## Explicitly unfinished

- Global/per-app improvement settings, weekly Sunday-evening/daily/after-session/manual scheduling,
  real per-run token-budget enforcement, and an evidence-backed review runner.
- Maximum-three suggestions, approve/dismiss persistence, approved edits into the draft, and
  revision-bound approval/publish for that review workflow. No settings UI pretends these work.
- Inline pending-question answer controls; the current dashboard only shows request status and
  directs answers to the app's existing session interface.
- Install suggestions for apps created outside this dashboard form (for example by CLI/chat),
  a persistent per-device "do not suggest again" preference, and an app overflow menu (help is
  currently an explicit card button).
- A dashboard rollback control. The existing backend/CLI rollback implementation is unchanged.
- Physical iPhone/Android installation and the actual Cloudflare/Portal deployment round trip.
  Browser emulation is not a substitute for real-device installation. No claim about an iPhone
  cookie problem has been established.

The preview is the existing live draft capability, not an immutable approval snapshot. The new
publish control is an explicit manual publish of the current draft. Revision-bound review
approval must be implemented before describing the unfinished improvement workflow as safe to ship.

## Verification

```sh
HERMES_PYTHON="$PWD/.venv/bin/python" scripts/run_tests.sh \
  tests/hermes_cli/test_apps_create_route.py \
  tests/hermes_cli/test_apps_installed_entry.py \
  tests/hermes_cli/test_apps_routes.py \
  tests/hermes_cli/test_apps_sessions_routes.py \
  tests/hermes_cli/test_apps_jobs.py tests/hermes_cli/test_apps_store.py
npm test --workspace web
npm run typecheck --workspace web
npm run lint --workspace web
npm run build --workspace web
.venv/bin/python scripts/check --base 8bb77947ff99c6a519afcdcb2ca3cd3505f1ede4
git diff --check
```

Real Chrome verification ran against an isolated dashboard on loopback, with separate fixture
`HOME`, `HERMES_HOME` and `HERMES_REAL_HOME`, not the running dashboard or tunnel. It exercised
creation, config persistence/reload, copied phone URL, draft preview, cancelled and confirmed
publication, recent requests and install help. Desktop and iPhone viewport captures were visually
inspected; the successful flow had zero page errors and zero external requests. The OAuth tests
use the repository's stub provider, not live Portal credentials.

## Running the branch

George installs/tests this branch himself. No live deployment, launcher, tunnel or other profile
was changed. Pull the fork branch and build/run its backend and dashboard together; an older
backend does not have the new create route. For phone use configure the existing HTTPS dashboard
address, sign in through its existing authentication, and open the signed-in app entry. A PWA
installation neither bypasses authentication nor extends a 12-hour capability link.
