/*
 * mcpoff - an MCP stdio server that is there and does nothing.
 *
 * For a plugin that is off on a platform but whose hooks are of type
 * mcp_tool: when the MCP server does not start, Claude Code reports "not
 * connected" for every hook event. This one connects, lists the tools named
 * on its command line with an open input schema, and answers every call with
 * an empty result. Nothing is read, written or sent anywhere.
 *
 *   mcpoff.exe [tool ...]          e.g. bin/agent-irc.exe event
 *
 * Without arguments it reads the tool names from "# mcpoff: tools <a> <b>" in
 * the file next to it that has its own name minus ".exe" (as winlaunch does),
 * so the .mcp.json entry needs no Windows-specific arguments.
 *
 * Messages are newline-delimited JSON-RPC 2.0. Requests get a result:
 * initialize (echoing the client's protocolVersion), tools/list, tools/call,
 * anything else an empty object. Notifications get nothing.
 *
 * Build: python build.py OUT.exe --src mcpoff.c
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <io.h>

#define LINE (1 << 20)

static char tools[2048];

/* Copy the raw JSON value at p (string, number, null) into out. */
static void raw_value(const char *p, char *out, size_t cap)
{
	size_t n = 0;
	while (*p == ' ') p++;
	if (*p == '"') {
		out[n++] = *p++;
		while (*p && n + 2 < cap) {
			if (*p == '\\' && p[1]) { out[n++] = *p++; out[n++] = *p++; continue; }
			out[n++] = *p;
			if (*p++ == '"') break;
		}
	} else {
		while (*p && *p != ',' && *p != '}' && *p != ' ' && n + 1 < cap) out[n++] = *p++;
	}
	out[n] = 0;
}

/*
 * Find a key at nesting depth 1 of the object in line and return a pointer to
 * its value, or NULL. Strings are skipped with their escapes, so a key inside
 * a value or a nested object never matches.
 */
static const char *top_key(const char *line, const char *key)
{
	size_t klen = strlen(key);
	int depth = 0;
	for (const char *p = line; *p; p++) {
		if (*p == '{' || *p == '[') { depth++; continue; }
		if (*p == '}' || *p == ']') { depth--; continue; }
		if (*p != '"') continue;
		const char *s = ++p;
		while (*p && *p != '"') { if (*p == '\\' && p[1]) p++; p++; }
		if (!*p) return NULL;
		if (depth == 1 && (size_t)(p - s) == klen && !strncmp(s, key, klen)) {
			const char *v = p + 1;
			while (*v == ' ') v++;
			if (*v == ':') return v + 1;
		}
	}
	return NULL;
}

/* Tool names from the "# mcpoff: tools" line of the file next to us. */
static void tools_from_script(void)
{
	char path[MAX_PATH * 2];
	DWORD n = GetModuleFileNameA(NULL, path, sizeof path);
	if (!n || n >= sizeof path || n < 5) return;
	path[n - 4] = 0;
	FILE *f = fopen(path, "rb");
	if (!f) return;
	static char buf[16384];
	size_t got = fread(buf, 1, sizeof buf - 1, f);
	fclose(f);
	buf[got] = 0;
	const char *p = strstr(buf, "# mcpoff: tools ");
	if (!p) return;
	p += 16;
	size_t m = 0;
	while (*p && *p != '\r' && *p != '\n' && m + 1 < sizeof tools) tools[m++] = *p++;
	tools[m] = 0;
}

static void reply(const char *id, const char *result)
{
	printf("{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":%s}\n", id, result);
	fflush(stdout);
}

int main(int argc, char **argv)
{
	_setmode(_fileno(stdin), _O_BINARY);
	_setmode(_fileno(stdout), _O_BINARY);

	for (int i = 1; i < argc; i++) {
		if (strlen(tools) + strlen(argv[i]) + 2 >= sizeof tools) break;
		if (tools[0]) strcat(tools, " ");
		strcat(tools, argv[i]);
	}
	if (!tools[0]) tools_from_script();

	static char line[LINE], id[256], method[128], version[64], out[8192];
	while (fgets(line, sizeof line, stdin)) {
		const char *idp = top_key(line, "id");
		if (!idp) continue; /* a notification */
		raw_value(idp, id, sizeof id);
		const char *mp = top_key(line, "method");
		method[0] = 0;
		if (mp) {
			raw_value(mp, method, sizeof method);
		}

		if (!strcmp(method, "\"initialize\"")) {
			const char *v = strstr(line, "\"protocolVersion\"");
			strcpy(version, "\"2025-06-18\"");
			if (v && (v = strchr(v + 17, ':'))) raw_value(v + 1, version, sizeof version);
			snprintf(out, sizeof out,
			         "{\"protocolVersion\":%s,\"capabilities\":{\"tools\":{}},"
			         "\"serverInfo\":{\"name\":\"mcpoff\",\"version\":\"1\"}}", version);
			reply(id, out);
		} else if (!strcmp(method, "\"tools/list\"")) {
			size_t n = (size_t)snprintf(out, sizeof out, "{\"tools\":[");
			const char *t = tools;
			int first = 1;
			while (*t) {
				while (*t == ' ') t++;
				const char *e = t;
				while (*e && *e != ' ') e++;
				if (e > t && n + 200 + (size_t)(e - t) < sizeof out) {
					n += (size_t)snprintf(out + n, sizeof out - n,
					    "%s{\"name\":\"%.*s\",\"description\":\"Off on this platform; does nothing.\","
					    "\"inputSchema\":{\"type\":\"object\",\"additionalProperties\":true}}",
					    first ? "" : ",", (int)(e - t), t);
					first = 0;
				}
				t = e;
			}
			snprintf(out + n, sizeof out - n, "]}");
			reply(id, out);
		} else if (!strcmp(method, "\"tools/call\"")) {
			/* Empty, as a real fire-and-forget tool answers: a hook's text
			 * output may land in the model's context. */
			reply(id, "{\"content\":[],\"isError\":false}");
		} else {
			reply(id, "{}");
		}
	}
	return 0;
}
