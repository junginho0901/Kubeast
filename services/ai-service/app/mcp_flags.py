"""The MCP switches and path, without the mcp SDK: main.py decides from these
whether to import app.mcp_server at all, so a service with MCP_ENABLED off
never loads the SDK (about 56 MB at idle)."""
import os

MCP_PATH = "/api/v1/ai/mcp"


def mcp_enabled() -> bool:
    return os.getenv("MCP_ENABLED", "false").strip().lower() == "true"


def mcp_write_tools_enabled() -> bool:
    """MCP_WRITE_TOOLS (chart mcp.writeTools, default off): offer the chat's write
    tools and request_access to keys whose ceiling is Write."""
    return os.getenv("MCP_WRITE_TOOLS", "false").strip().lower() == "true"
