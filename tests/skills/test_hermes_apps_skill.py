"""The hermes-apps skill teaches the agent CLI commands; every one it documents must be a real,
parseable ``hermes apps`` invocation, and its documented workflow must run end to end."""

from __future__ import annotations

import argparse
import re
import shlex
from pathlib import Path

import pytest

from hermes_cli import apps_cmd, apps_store

SKILL = Path(__file__).resolve().parents[2] / "skills" / "productivity" / "hermes-apps" / "SKILL.md"
COMMAND_RE = re.compile(r"^hermes apps [^#\n]+", re.MULTILINE)


def _parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="hermes")
    apps_cmd.build_parser(root.add_subparsers(dest="command"))
    return root


def _documented_commands() -> list[list[str]]:
    return [shlex.split(m.group(0).strip())[1:] for m in COMMAND_RE.finditer(SKILL.read_text(encoding="utf-8"))]


def test_skill_documents_cli_commands():
    assert len(_documented_commands()) >= 6


@pytest.mark.parametrize("argv", _documented_commands(), ids=" ".join)
def test_every_documented_command_parses(argv):
    args = _parser().parse_args(argv)
    assert args.apps_action in apps_cmd._ACTIONS


def test_documented_workflow_runs_against_a_real_home(tmp_path, monkeypatch, capsys):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    parser = _parser()
    for argv in _documented_commands():
        if argv[1] == "rollback":
            argv = [*argv[:-1], "1"]
        assert apps_cmd.apps_command(parser.parse_args(argv)) == 0, argv
    manifest = apps_store.load_manifest(home, "invoices")
    assert manifest["current_version"] == 1
    assert manifest["visibility"] == "public"
