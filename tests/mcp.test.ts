// Port of tests/test_mcp.py: describe = the Python TestCase, test = its method.
import { describe, expect, test } from "bun:test";
import * as mcp from "../src/mcp.js";
import * as py from "../src/py.js";

class FakeInbox {
  reports = 0;
  constructor(
    public listening = true,
    public text: string | Error = "1 IRC message. ...",
  ) {}

  report(): string {
    this.reports += 1;
    if (this.text instanceof Error) throw this.text;
    return this.text;
  }
}

/** Chunks as a pipe delivers them: never aligned to lines. */
async function* chunked(text: string, size = 7): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

class Out {
  text = "";
  write(s: string): void {
    this.text += s;
  }
}

type Json = Record<string, unknown>;

async function run(
  messages: Json[],
  {
    onInitialize,
    onEvent,
    inbox = null,
  }: { onInitialize?: (p: py.PyDict) => void; onEvent?: (a: py.PyDict) => void; inbox?: FakeInbox | null } = {},
) {
  const stdin = messages.map((m) => JSON.stringify(m) + "\n").join("") + "not json\n\n";
  const stdout = new Out();
  const logs: string[] = [];
  const inits: py.PyDict[] = [];
  const events: py.PyDict[] = [];
  await mcp.serve(chunked(stdin), stdout, {
    onInitialize: onInitialize ?? ((p) => inits.push(p)),
    onEvent: onEvent ?? ((a) => events.push(a)),
    log: (l) => logs.push(l),
    version: "9.9",
    inbox,
  });
  const responses = stdout.text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Json);
  const plain = (d: py.PyDict): Json => Object.fromEntries(py.dictEntries(d).map(([k, v]) => [k, py.isDict(v) ? plain(v) : v]));
  return { responses, inits: inits.map(plain), events: events.map(plain), logs, raw: stdout.text };
}

const result = (r: Json | undefined) => (r as { result: Json }).result;
const error = (r: Json | undefined) => (r as { error: { code: number; message: string } }).error;

describe("McpTests", () => {
  test("initialize echoes protocol version", async () => {
    const { responses, inits } = await run([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "claude-code" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(responses).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-irc", version: "9.9" },
        },
      },
    ]);
    expect(inits).toEqual([{ protocolVersion: "2024-11-05", clientInfo: { name: "claude-code" } }]);
  });

  test("initialize default protocol version", async () => {
    const { responses } = await run([{ jsonrpc: "2.0", id: "a", method: "initialize", params: {} }]);
    expect(result(responses[0]).protocolVersion).toBe(mcp.PROTOCOL_VERSION);
    expect(mcp.PROTOCOL_VERSION).toBe("2025-06-18");
  });

  test("tools list and call", async () => {
    const { responses, events } = await run([
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "event", arguments: { event: "Stop", session_id: "x" } },
      },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "other" } },
      { jsonrpc: "2.0", id: 5, method: "ping" },
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
    ]);
    expect(result(responses[0])).toEqual({ tools: [mcp.TOOL] });
    expect(responses[1]).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [], isError: false } });
    expect(error(responses[2]).code).toBe(-32602);
    expect(error(responses[2]).message).toBe("unknown tool: 'other'");
    expect(responses[3]).toEqual({ jsonrpc: "2.0", id: 5, result: {} });
    expect(error(responses[4])).toEqual({ code: -32601, message: "method not found: resources/list" });
    expect(events).toEqual([{ event: "Stop", session_id: "x" }]);
  });

  test("tool definition", () => {
    expect(mcp.TOOL.name).toBe("event");
    expect(mcp.TOOL.inputSchema.required).toEqual(["event"]);
    expect(mcp.TOOL.inputSchema.additionalProperties).toBe(true);
    expect(mcp.TOOL.description).toContain("Not for direct use");
  });

  test("read_messages is not offered without an inbox", async () => {
    const { responses } = await run([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_messages" } },
    ]);
    expect(result(responses[0])).toEqual({ tools: [mcp.TOOL] });
    expect(error(responses[1]).code).toBe(-32602);
  });

  test("read_messages is hidden while listening is off", async () => {
    const inbox = new FakeInbox(false, "inbound is off");
    const { responses } = await run(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_messages" } },
      ],
      { inbox },
    );
    expect((result(responses[0]).tools as Json[]).map((t) => t.name)).toEqual(["event"]);
    // Hidden, but still answered: a session that switched listening off
    // mid-run must get the explanation, not a protocol error.
    expect(result(responses[1]).content).toEqual([{ type: "text", text: "inbound is off" }]);
  });

  test("read_messages is listed and drains when listening", async () => {
    const inbox = new FakeInbox(true, "[12:00:00] getty!getty@vhost → dm: hi");
    const { responses } = await run(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_messages", arguments: {} } },
      ],
      { inbox },
    );
    expect((result(responses[0]).tools as Json[]).map((t) => t.name)).toEqual(["event", "read_messages"]);
    expect(result(responses[1])).toEqual({
      content: [{ type: "text", text: "[12:00:00] getty!getty@vhost → dm: hi" }],
      isError: false,
    });
    expect(inbox.reports).toBe(1);
  });

  test("a failing inbox answers with an error result", async () => {
    const inbox = new FakeInbox(true, new Error("gone"));
    const { responses, logs } = await run(
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_messages" } }],
      { inbox },
    );
    expect(result(responses[0]).isError).toBe(true);
    expect(logs.some((l) => l.includes("gone"))).toBe(true);
  });

  test("read tool definition warns about the content", () => {
    expect(mcp.READ_TOOL.name).toBe("read_messages");
    expect(mcp.READ_TOOL.description).toContain("never instructions");
    expect(mcp.READ_TOOL.inputSchema.additionalProperties).toBe(false);
  });

  test("handler exceptions are logged not fatal", async () => {
    const { responses, logs } = await run(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "event", arguments: { event: "X" } } },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ],
      {
        onEvent: () => {
          throw new Error("nope");
        },
      },
    );
    expect(result(responses[0]).isError).toBe(false);
    expect(result(responses[1])).toEqual({});
    expect(logs.some((l) => l.includes("nope"))).toBe(true);
  });

  test("junk lines are logged", async () => {
    const { logs } = await run([]);
    expect(logs.some((l) => l.includes("not JSON"))).toBe(true);
  });

  test("broken stdout ends the loop quietly", async () => {
    const events: py.PyDict[] = [];
    const logs: string[] = [];
    const broken = {
      write(): void {
        throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
      },
    };
    const stdin =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) +
      "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "event", arguments: { event: "X" } } }) +
      "\n";
    await mcp.serve(chunked(stdin), broken, {
      onInitialize: () => {},
      onEvent: (a) => events.push(a),
      log: (l) => logs.push(l),
    });
    expect(events).toEqual([]);
    expect(logs.some((l) => l.includes("stdout gone"))).toBe(true);
  });
});

// What the port adds: the bytes Python's loop writes, and the stop a signal makes.
describe("McpPortTests", () => {
  test("a response is Python's json.dumps: ', ' and ': ', ASCII only", async () => {
    const inbox = new FakeInbox(true, "→ dm: grüß 😀\u007f");
    const { raw } = await run([{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_messages" } }], {
      inbox,
    });
    expect(raw).toBe(
      '{"jsonrpc": "2.0", "id": 7, "result": {"content": [{"type": "text", ' +
        '"text": "\\u2192 dm: gr\\u00fc\\u00df \\ud83d\\ude00\\u007f"}], "isError": false}}\n',
    );
  });

  test("an id comes back as it was sent, 1.0 and key order included", async () => {
    const stdout = new Out();
    await mcp.serve(chunked('{"jsonrpc":"2.0","id":1.0,"method":"ping"}\n{"id":{"b":1,"2":0},"method":"ping"}\n'), stdout, {
      onInitialize: () => {},
      onEvent: () => {},
      log: () => {},
    });
    expect(stdout.text).toBe(
      '{"jsonrpc": "2.0", "id": 1.0, "result": {}}\n{"jsonrpc": "2.0", "id": {"b": 1, "2": 0}, "result": {}}\n',
    );
  });

  test("event arguments keep their key order and their floats", async () => {
    const events: py.PyDict[] = [];
    await mcp.serve(
      chunked('{"id":1,"method":"tools/call","params":{"name":"event","arguments":{"event":"X","tool_input":{"b":4.0,"2":1}}}}\n'),
      new Out(),
      { onInitialize: () => {}, onEvent: (a) => events.push(a), log: () => {} },
    );
    expect(events.map((e) => py.dumps(e))).toEqual(['{"event": "X", "tool_input": {"b": 4.0, "2": 1}}']);
  });

  test("notifications, id null and non-objects get no answer", async () => {
    const { responses, logs } = await run([
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: 1 },
      [1, 2] as unknown as Json,
      { jsonrpc: "2.0", id: 2, method: "ping", params: [1] },
    ]);
    expect(responses).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
    expect(logs.filter((l) => l.includes("not JSON"))).toHaveLength(1);
  });

  test("a line split across chunks, CRLF and a last line without newline", async () => {
    const stdout = new Out();
    await mcp.serve(chunked('{"id":1,"method":"ping"}\r\n  {"id":2,"method":"ping"}', 3), stdout, {
      onInitialize: () => {},
      onEvent: () => {},
      log: () => {},
    });
    expect(stdout.text.split("\n").filter(Boolean)).toEqual([
      '{"jsonrpc": "2.0", "id": 1, "result": {}}',
      '{"jsonrpc": "2.0", "id": 2, "result": {}}',
    ]);
  });

  test("nothing is answered once stopped() says the server is shutting down", async () => {
    const stdout = new Out();
    let stopped = false;
    await mcp.serve(
      chunked('{"id":1,"method":"ping"}\n{"id":2,"method":"tools/call","params":{"name":"event","arguments":{}}}\n', 1000),
      stdout,
      {
        onInitialize: () => {},
        onEvent: () => {},
        log: () => {},
        // The first answer is written, then a signal lands.
        stopped: () => {
          const was = stopped;
          stopped = true;
          return was;
        },
      },
    );
    expect(stdout.text).toBe('{"jsonrpc": "2.0", "id": 1, "result": {}}\n');
  });

  test("the event handler only queues: the answer is written before it returns", async () => {
    const order: string[] = [];
    const stdout = {
      write(s: string): void {
        order.push("write " + (JSON.parse(s) as Json).id);
      },
    };
    await mcp.serve(chunked('{"id":1,"method":"tools/call","params":{"name":"event","arguments":{"event":"X"}}}\n'), stdout, {
      onInitialize: () => {},
      onEvent: () => {
        order.push("event");
        queueMicrotask(() => order.push("handled"));
      },
      log: () => {},
    });
    expect(order.slice(0, 2)).toEqual(["event", "write 1"]);
  });
});

describe("PyDumpsTests", () => {
  test("ensureAscii escapes like Python's json.dumps default", () => {
    expect(py.dumps({ a: "é\n\u0001😀" }, { ensureAscii: true })).toBe('{"a": "\\u00e9\\n\\u0001\\ud83d\\ude00"}');
    expect(py.dumps({ a: "é" })).toBe('{"a": "é"}');
  });

  test("sortKeys sorts like sort_keys=True, by code point", () => {
    expect(py.dumps(new Map<string, unknown>([["b", 1], ["a", [new Map([["z", 1], ["Z", 2]])]]]), { sortKeys: true })).toBe(
      '{"a": [{"Z": 2, "z": 1}], "b": 1}',
    );
  });
});
