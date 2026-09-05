"""Newline-delimited JSON-RPC 2.0 over stdio: the MCP subset both harnesses need (spec §6.1)."""

import json

PROTOCOL_VERSION = "2025-06-18"

TOOL = {
    "name": "event",
    "description": "Transport for agent-irc hooks. Not for direct use.",
    "inputSchema": {
        "type": "object",
        "properties": {"event": {"type": "string", "description": "hook_event_name"}},
        "required": ["event"],
        "additionalProperties": True,
    },
}


def _write(stdout, message):
    stdout.write(json.dumps(message) + "\n")
    stdout.flush()


def _error(code, text):
    return {"error": {"code": code, "message": text}}


def _dispatch(method, params, on_initialize, on_event, log, version):
    if method == "initialize":
        try:
            on_initialize(params)
        except Exception as e:
            log("agent-irc: initialize handler failed: %r" % e)
        return {"result": {
            "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "agent-irc", "version": version},
        }}
    if method == "ping":
        return {"result": {}}
    if method == "tools/list":
        return {"result": {"tools": [TOOL]}}
    if method == "tools/call":
        if params.get("name") != TOOL["name"]:
            return _error(-32602, "unknown tool: %r" % params.get("name"))
        arguments = params.get("arguments")
        try:
            on_event(arguments if isinstance(arguments, dict) else {})
        except Exception as e:
            log("agent-irc: event handler failed: %r" % e)
        return {"result": {"content": [], "isError": False}}
    return _error(-32601, "method not found: %s" % method)


def serve(stdin, stdout, on_initialize, on_event, log, version="0"):
    for raw in stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            log("agent-irc: stdin line is not JSON, ignored")
            continue
        if not isinstance(message, dict) or "method" not in message:
            continue
        if "id" not in message or message["id"] is None:
            continue  # notification
        params = message.get("params")
        if not isinstance(params, dict):
            params = {}
        response = {"jsonrpc": "2.0", "id": message["id"]}
        response.update(_dispatch(message["method"], params, on_initialize, on_event, log, version))
        try:
            _write(stdout, response)
        except (OSError, ValueError) as e:  # BrokenPipeError is an OSError; ValueError = closed file
            log("agent-irc: stdout gone (%s), stopping" % e.__class__.__name__)
            return
