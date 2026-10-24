"""``hermes apps`` CLI — create, publish and inspect Hermes Apps for the active profile.

This is the agent's building surface too: Hermes edits files in the draft folder that
``hermes apps path`` prints, then publishes only after the user approves the preview.
"""

from __future__ import annotations

import argparse
import json
import sys

from hermes_cli import apps_store, apps_telemetry


def build_parser(parent_subparsers: argparse._SubParsersAction) -> argparse.ArgumentParser:
    parser = parent_subparsers.add_parser(
        "apps",
        help="Manage Hermes Apps (personal mini apps Hermes builds)",
        description=(
            "Hermes Apps are small web apps Hermes builds and improves from chat. They open in "
            "Hermes Desktop, any browser, and install to a phone home screen. State is per-profile."
        ),
    )
    sub = parser.add_subparsers(dest="apps_action")
    p_list = sub.add_parser("list", aliases=["ls"], help="List apps")
    p_list.add_argument("--json", action="store_true")
    p_create = sub.add_parser("create", help="Create an app with a starter draft")
    p_create.add_argument("slug", help="App id, e.g. 'invoices'")
    p_create.add_argument("--name", required=True)
    p_create.add_argument("--icon", default="")
    p_create.add_argument("--description", default="")
    for name, help_text in (("show", "Show an app's manifest"), ("path", "Print the app's draft folder")):
        sub.add_parser(name, help=help_text).add_argument("slug")
    p_publish = sub.add_parser("publish", help="Publish the draft as a new version")
    p_publish.add_argument("slug")
    p_publish.add_argument("--note", default="", help="What changed in this version")
    p_rollback = sub.add_parser("rollback", help="Make an earlier version current")
    p_rollback.add_argument("slug")
    p_rollback.add_argument("target_version", type=int, metavar="VERSION")
    p_set = sub.add_parser("set", help="Change name, icon, visibility or telemetry")
    p_set.add_argument("slug")
    p_set.add_argument("--name")
    p_set.add_argument("--icon")
    p_set.add_argument("--description")
    p_set.add_argument("--visibility", choices=apps_store.VISIBILITIES)
    p_set.add_argument("--telemetry", choices=("on", "off"))
    p_set.add_argument("--capture-values", choices=("on", "off"), dest="capture_values")
    p_insights = sub.add_parser("insights", help="Summarize recent usage for the improvement review")
    p_insights.add_argument("slug")
    p_insights.add_argument("--days", type=int, default=7)
    p_insights.add_argument("--json", action="store_true")
    p_agent = sub.add_parser("agent", help="Set the session setup an app's requests run with")
    p_agent.add_argument("slug")
    p_agent.add_argument("--prompt", help="Instructions every request from this app starts with")
    p_agent.add_argument("--skill", action="append", dest="skills", help="Skill to preload (repeatable)")
    p_agent.add_argument("--toolsets", help="Comma-separated toolsets (default: your CLI toolsets)")
    p_agent.add_argument("--clear", action="store_true", help="Remove the app's session setup")
    p_data = sub.add_parser("data", help="Read or write an app's saved records")
    data_sub = p_data.add_subparsers(dest="data_action")
    data_sub.add_parser("keys", help="List record keys").add_argument("slug")
    for name in ("get", "delete"):
        sp = data_sub.add_parser(name, help=f"{name.capitalize()} one record")
        sp.add_argument("slug")
        sp.add_argument("key")
    p_dset = data_sub.add_parser("set", help="Store one record (JSON)")
    p_dset.add_argument("slug")
    p_dset.add_argument("key")
    source = p_dset.add_mutually_exclusive_group(required=True)
    source.add_argument("--json", dest="value", help="JSON value")
    source.add_argument("--file", help="Path to a JSON file")
    p_jobs = sub.add_parser("jobs", help="List session requests an app made")
    p_jobs.add_argument("slug")
    p_jobs.add_argument("--json", action="store_true")
    p_review = sub.add_parser("review", help="Run one improvement review now (proposes up to 3 suggestions)")
    p_review.add_argument("slug")
    p_review.add_argument("--request-id", help=argparse.SUPPRESS)
    p_improve = sub.add_parser("improvements", help="Show or set improvement review settings")
    p_improve.add_argument("slug", nargs="?", help="App id; omit for the defaults every app inherits")
    p_improve.add_argument("--schedule", choices=("weekly", "daily", "after-session", "manual"))
    p_improve.add_argument("--token-budget", type=int, dest="token_budget")
    p_improve.add_argument("--enabled", choices=("on", "off"))
    p_improve.add_argument("--inherit", action="store_true", help="Drop this app's override")
    p_run = sub.add_parser("run-job", help=argparse.SUPPRESS)
    p_run.add_argument("slug")
    p_run.add_argument("job_id")
    parser.set_defaults(_apps_parser=parser)
    return parser


def add_parser(subparsers: argparse._SubParsersAction) -> None:
    """Self-wiring registration: ``hermes apps`` dispatches straight to :func:`apps_command`."""
    build_parser(subparsers).set_defaults(func=apps_command)


def _home():
    from hermes_constants import get_hermes_home

    return get_hermes_home()


def _cmd_list(args) -> int:
    apps = apps_store.list_apps(_home())
    if args.json:
        print(json.dumps(apps, indent=2, ensure_ascii=False))
        return 0
    if not apps:
        print("No apps yet. Create one with: hermes apps create <slug> --name <name>")
        return 0
    for app in apps:
        version = app.get("current_version")
        state = f"v{version}" if version else "draft only"
        print(f"{app.get('icon', '')} {app['slug']:<24} {app['name']:<28} {state:<11} {app['visibility']}")
    return 0


def _cmd_create(args) -> int:
    manifest = apps_store.create_app(_home(), args.slug, args.name, icon=args.icon, description=args.description)
    _schedule_reviews()
    print(f"Created {manifest['slug']}. Edit the draft in {apps_store.app_dir(_home(), args.slug) / 'draft'}")
    return 0


def _cmd_show(args) -> int:
    print(json.dumps(apps_store.load_manifest(_home(), args.slug), indent=2, ensure_ascii=False))
    return 0


def _cmd_path(args) -> int:
    apps_store.load_manifest(_home(), args.slug)
    print(apps_store.app_dir(_home(), args.slug) / "draft")
    return 0


def _cmd_publish(args) -> int:
    manifest = apps_store.publish(_home(), args.slug, note=args.note)
    print(f"Published {args.slug} v{manifest['current_version']}.")
    return 0


def _cmd_rollback(args) -> int:
    apps_store.rollback(_home(), args.slug, args.target_version)
    print(f"{args.slug} now serves v{args.target_version}.")
    return 0


def _cmd_set(args) -> int:
    changes: dict = {k: getattr(args, k) for k in ("name", "icon", "description", "visibility") if getattr(args, k) is not None}
    telemetry = {}
    if args.telemetry is not None:
        telemetry["enabled"] = args.telemetry == "on"
    if args.capture_values is not None:
        telemetry["capture_values"] = args.capture_values == "on"
    if telemetry:
        changes["telemetry"] = telemetry
    if not changes:
        print("Nothing to change.", file=sys.stderr)
        return 2
    print(json.dumps(apps_store.update_app(_home(), args.slug, changes), indent=2, ensure_ascii=False))
    return 0


def _cmd_insights(args) -> int:
    summary = apps_telemetry.summarize(_home(), args.slug, days=max(1, args.days))
    if args.json:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0
    print(f"{args.slug}: {summary['total_events']} events, {summary['sessions']} sessions, last {summary['days']} days")
    for row in summary["top_interactions"][:10]:
        print(f"  {row['count']:>5}  {row['label']}")
    for row in summary["errors"]:
        print(f"  error {row['count']:>3}  {row['target']}")
    return 0


def _cmd_agent(args) -> int:
    if args.clear:
        apps_store.update_app(_home(), args.slug, {"agent": None})
        print(f"Cleared the session setup for {args.slug}.")
        return 0
    current = apps_store.load_manifest(_home(), args.slug).get("agent") or {}
    agent = {
        "prompt": args.prompt if args.prompt is not None else current.get("prompt", ""),
        "skills": args.skills if args.skills is not None else current.get("skills", []),
        "toolsets": ([t.strip() for t in args.toolsets.split(",") if t.strip()] if args.toolsets is not None
                     else current.get("toolsets")),
    }
    manifest = apps_store.update_app(_home(), args.slug, {"agent": agent})
    print(json.dumps(manifest["agent"], indent=2, ensure_ascii=False))
    return 0


def _data_keys(home, args) -> None:
    print("\n".join(apps_store.data_keys(home, args.slug)))


def _data_get(home, args) -> None:
    print(json.dumps(apps_store.data_get(home, args.slug, args.key), indent=2, ensure_ascii=False))


def _data_delete(home, args) -> None:
    print("deleted" if apps_store.data_delete(home, args.slug, args.key) else "not found")


def _data_set(home, args) -> None:
    from pathlib import Path

    raw = Path(args.file).read_bytes() if args.file else args.value.encode("utf-8")
    apps_store.data_put(home, args.slug, args.key, raw)
    print(f"Saved {args.slug}/{args.key}.")


_DATA_ACTIONS = {"keys": _data_keys, "get": _data_get, "delete": _data_delete, "set": _data_set}


def _cmd_data(args) -> int:
    handler = _DATA_ACTIONS.get(getattr(args, "data_action", None) or "")
    if handler is None:
        print("usage: hermes apps data {keys,get,set,delete} ...", file=sys.stderr)
        return 2
    handler(_home(), args)
    return 0


def _cmd_jobs(args) -> int:
    from hermes_cli import apps_jobs

    jobs = apps_jobs.list_jobs(_home(), args.slug)
    if args.json:
        print(json.dumps([apps_jobs.public_view(j) for j in jobs], indent=2, ensure_ascii=False))
        return 0
    for job in jobs:
        prompt = " ".join((job.get("prompt") or "").split())[:50]
        print(f"{job['id']}  {job['status']:<11} {job.get('session_id') or '-':<28} {prompt}")
    return 0


def _schedule_reviews() -> None:
    """New apps inherit the review schedule. Best effort: a cron hiccup must not fail creation."""
    try:
        from hermes_cli.apps_improvement_schedule import sync_schedule

        sync_schedule(_home())
    except Exception as exc:  # health: allow BLE001 -- surfaced, creation already succeeded
        print(f"Note: could not schedule improvement reviews yet ({exc}).", file=sys.stderr)


def _cmd_review(args) -> int:
    from hermes_cli.apps_improvements import load_state, run_request

    code = run_request(_home(), args.slug, args.request_id)
    state = load_state(_home(), args.slug)
    if not args.request_id:
        run = state["runs"][-1] if state.get("runs") else {"status": "skipped"}
        print(json.dumps({"run": run, "pending": [s for s in state["suggestions"] if s["status"] == "pending"]},
                         indent=2, ensure_ascii=False))
    return code


def _cmd_improvements(args) -> int:
    from hermes_cli.apps_improvement_settings import save_settings, settings

    changes = {k: v for k, v in (("schedule", args.schedule), ("token_budget", args.token_budget)) if v is not None}
    if args.enabled is not None:
        changes["enabled"] = args.enabled == "on"
    if args.inherit:
        if not args.slug:
            print("--inherit needs an app id.", file=sys.stderr)
            return 2
        result = save_settings(_home(), None, slug=args.slug)
    elif changes:
        if args.slug:
            changes = {**_override(args.slug), **changes}
        result = save_settings(_home(), changes, slug=args.slug)
    else:
        result = settings(_home(), args.slug)
    print(json.dumps(result, indent=2))
    return 0


def _override(slug: str) -> dict:
    from hermes_cli.apps_improvements import load_state

    return load_state(_home(), slug).get("override") or {}


def _cmd_run_job(args) -> int:
    from hermes_cli.apps_job_runner import run_job

    return run_job(_home(), args.slug, args.job_id)


_ACTIONS = {
    "agent": _cmd_agent, "data": _cmd_data, "jobs": _cmd_jobs, "run-job": _cmd_run_job,
    "review": _cmd_review, "improvements": _cmd_improvements,
    "list": _cmd_list, "ls": _cmd_list, "create": _cmd_create, "show": _cmd_show, "path": _cmd_path,
    "publish": _cmd_publish, "rollback": _cmd_rollback, "set": _cmd_set, "insights": _cmd_insights,
}


def apps_command(args: argparse.Namespace) -> int:
    action = getattr(args, "apps_action", None)
    handler = _ACTIONS.get(action or "")
    if handler is None:
        parser = getattr(args, "_apps_parser", None)
        if parser is not None:
            parser.print_help()
        return 0
    try:
        return handler(args)
    except apps_store.AppError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
