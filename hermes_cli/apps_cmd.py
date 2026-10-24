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


_ACTIONS = {
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
