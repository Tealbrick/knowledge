"""Teal Brick Knowledge Hermes plugin."""

from __future__ import annotations

from .tools import TOOLS
from .research_tools import RESEARCH_TOOLS
from .native_tools import NATIVE_TOOLS


def register(ctx) -> None:
    """Register Knowledge tools through Hermes PluginContext."""
    for name, schema, handler in (*TOOLS, *RESEARCH_TOOLS, *NATIVE_TOOLS):
        ctx.register_tool(
            name=name,
            toolset="knowledge",
            schema=schema,
            handler=handler,
        )
