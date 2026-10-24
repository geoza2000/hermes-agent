"""In-chat songwriting: local source retention, editable scores and offline audio."""
from pathlib import Path


def register(ctx):
    from .tool import SCHEMA, handle
    ctx.register_tool(name="songwriting", toolset="songwriting", schema=SCHEMA,
                      handler=handle, check_fn=lambda: True,
                      description="Local in-chat songwriting", emoji="🎹")
    ctx.register_skill("in-chat-songwriting", Path(__file__).parent / "skills/in-chat-songwriting/SKILL.md",
                       "Use when writing songs in the current conversation.")
