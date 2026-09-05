import io
import json
import unittest

from agent_irc import mcp


def run(messages, on_initialize=None, on_event=None):
    stdin = io.StringIO("".join(json.dumps(m) + "\n" for m in messages) + "not json\n\n")
    stdout = io.StringIO()
    logs = []
    inits, events = [], []
    mcp.serve(stdin, stdout, on_initialize or inits.append, on_event or events.append, logs.append, version="9.9")
    responses = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
    return responses, inits, events, logs


class McpTests(unittest.TestCase):
    def test_initialize_echoes_protocol_version(self):
        responses, inits, _, _ = run([{"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                       "params": {"protocolVersion": "2024-11-05", "clientInfo": {"name": "claude-code"}}},
                                      {"jsonrpc": "2.0", "method": "notifications/initialized"}])
        self.assertEqual(responses, [{"jsonrpc": "2.0", "id": 1, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
            "serverInfo": {"name": "agent-irc", "version": "9.9"}}}])
        self.assertEqual(inits, [{"protocolVersion": "2024-11-05", "clientInfo": {"name": "claude-code"}}])

    def test_initialize_default_protocol_version(self):
        responses, _, _, _ = run([{"jsonrpc": "2.0", "id": "a", "method": "initialize", "params": {}}])
        self.assertEqual(responses[0]["result"]["protocolVersion"], mcp.PROTOCOL_VERSION)

    def test_tools_list_and_call(self):
        responses, _, events, _ = run([
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "event", "arguments": {"event": "Stop", "session_id": "x"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "other"}},
            {"jsonrpc": "2.0", "id": 5, "method": "ping"},
            {"jsonrpc": "2.0", "id": 6, "method": "resources/list"},
        ])
        self.assertEqual(responses[0]["result"], {"tools": [mcp.TOOL]})
        self.assertEqual(responses[1], {"jsonrpc": "2.0", "id": 3, "result": {"content": [], "isError": False}})
        self.assertEqual(responses[2]["error"]["code"], -32602)
        self.assertEqual(responses[3], {"jsonrpc": "2.0", "id": 5, "result": {}})
        self.assertEqual(responses[4]["error"]["code"], -32601)
        self.assertEqual(events, [{"event": "Stop", "session_id": "x"}])

    def test_tool_definition(self):
        self.assertEqual(mcp.TOOL["name"], "event")
        self.assertEqual(mcp.TOOL["inputSchema"]["required"], ["event"])
        self.assertTrue(mcp.TOOL["inputSchema"]["additionalProperties"])
        self.assertIn("Not for direct use", mcp.TOOL["description"])

    def test_handler_exceptions_are_logged_not_fatal(self):
        def boom(_):
            raise RuntimeError("nope")
        responses, _, _, logs = run([
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "event", "arguments": {"event": "X"}}},
            {"jsonrpc": "2.0", "id": 2, "method": "ping"}], on_event=boom)
        self.assertEqual(responses[0]["result"]["isError"], False)
        self.assertEqual(responses[1]["result"], {})
        self.assertTrue(any("nope" in l for l in logs))

    def test_junk_lines_are_logged(self):
        _, _, _, logs = run([])
        self.assertTrue(any("not JSON" in l for l in logs))


if __name__ == "__main__":
    unittest.main()
