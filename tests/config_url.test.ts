// Port of tests/test_config_url.py: describe = the Python TestCase, test = its method.
import { describe, expect, test } from "bun:test";
import { MissingVariable, Server, expandEnv, parseUrl, redactUrl, sameServer } from "../src/config.js";

function server(scheme: string, host: string, port: number, user: string, password: string | null, insecure: boolean) {
  return new Server(scheme, host, port, user, password, insecure);
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("nothing thrown");
}

describe("ParseUrlTests", () => {
  test("test_full_tls_url", () => {
    const t = parseUrl("ircs://getty:s3cret@irc.example.org:6697/#agents", "nobody");
    expect(t).toEqual({ server: server("ircs", "irc.example.org", 6697, "getty", "s3cret", false), channel: "#agents" });
    expect(t.server.tls).toBe(true);
  });

  test("test_defaults", () => {
    const t = parseUrl("irc://irc.example.org/agents", "nobody");
    expect(t.server).toEqual(server("irc", "irc.example.org", 6667, "nobody", null, false));
    expect(t.channel).toBe("#agents");
    expect(t.server.tls).toBe(false);
    expect(parseUrl("ircs://h/x", "u").server.port).toBe(6697);
  });

  test("test_password_only", () => {
    const t = parseUrl("ircs://:pw@h/#c", "nobody");
    expect([t.server.user, t.server.password]).toEqual(["nobody", "pw"]);
  });

  test("test_user_only", () => {
    const t = parseUrl("ircs://getty@h/#c", "nobody");
    expect([t.server.user, t.server.password]).toEqual(["getty", null]);
  });

  test("test_percent_decoding", () => {
    const t = parseUrl("ircs://us%40er:p%23w@h/%23chan", "nobody");
    expect([t.server.user, t.server.password, t.channel]).toEqual(["us@er", "p#w", "#chan"]);
  });

  test("test_channel_prefixes_kept", () => {
    for (const ch of ["&local", "+modeless", "!safe"]) expect(parseUrl("irc://h/" + ch, "u").channel).toBe(ch);
  });

  test("test_ipv6_literal_host", () => {
    const t = parseUrl("irc://[2001:db8::1]:6667/#chan", "nobody");
    expect([t.server.host, t.server.port]).toEqual(["2001:db8::1", 6667]);
    expect(t.server.label).toBe("[2001:db8::1]:6667");
  });

  test("test_ipv6_literal_takes_the_scheme_default_port", () => {
    const t = parseUrl("ircs://[::1]/#chan", "nobody");
    expect([t.server.host, t.server.port]).toEqual(["::1", 6697]);
  });

  test("test_ipv6_literal_with_userinfo", () => {
    const t = parseUrl("ircs://getty:pw@[fe80::1]:7000/#c", "nobody");
    expect([t.server.host, t.server.port, t.server.user]).toEqual(["fe80::1", 7000, "getty"]);
  });

  test("test_insecure_flag", () => {
    expect(parseUrl("ircs://h/#c?insecure=1", "u").server.insecure).toBe(true);
    expect(parseUrl("ircs://h/#c?insecure=true", "u").server.insecure).toBe(true);
    expect(parseUrl("ircs://h/#c?insecure=0", "u").server.insecure).toBe(false);
    expect(parseUrl("ircs://h/#c?other=1", "u").server.insecure).toBe(false);
  });

  test("test_host_lowercased", () => {
    expect(parseUrl("irc://IRC.Example.ORG/#c", "u").server.host).toBe("irc.example.org");
  });

  test("test_errors", () => {
    for (const bad of ["http://h/#c", "irc://h", "irc://h/", "irc://h:abc/#c", "ircs:///#c", "irc://a@b@h/#c"]) {
      expect(() => parseUrl(bad, "u")).toThrow();
    }
  });

  test("test_server_identity_ignores_channel", () => {
    const a = parseUrl("ircs://u:p@h:6697/#a", "x").server;
    const b = parseUrl("ircs://u:p@h/#b", "x").server;
    expect(sameServer(a, b)).toBe(true);
    expect(a.key).toBe(b.key);
  });

  test("test_server_identity_ignores_insecure", () => {
    const a = parseUrl("ircs://u:p@h/#a?insecure=1", "x").server;
    const b = parseUrl("ircs://u:p@h/#b", "x").server;
    expect(a.insecure).toBe(true);
    expect(b.insecure).toBe(false);
    expect(sameServer(a, b)).toBe(true);
    expect(a.key).toBe(b.key);
  });

  test("test_errors_do_not_leak_credentials", () => {
    for (const bad of ["ircs://realuser:realsecret@h:notaport/#c", "ircs://realuser:realsecret@h/"]) {
      const message = thrown(() => parseUrl(bad, "u")).message;
      expect(message).not.toContain("realsecret");
      expect(message).not.toContain("realuser");
      expect(message).toContain("***@h");
    }
  });
});

describe("ExpandEnvTests", () => {
  test("test_expands", () => {
    expect(expandEnv("ircs://u:${PW}@h/#c", { PW: "x y" })).toBe("ircs://u:x y@h/#c");
    expect(expandEnv("no vars", {})).toBe("no vars");
  });

  test("test_missing_raises_keyerror_with_name", () => {
    const e = thrown(() => expandEnv("${A}${B}", { A: "1" }));
    expect(e).toBeInstanceOf(MissingVariable);
    expect((e as MissingVariable).variable).toBe("B");
  });

  test("test_expanded_password_with_at_sign_never_reaches_error_text", () => {
    const url = expandEnv("ircs://u:${PW}@h:notaport/#c", { PW: "p@ss:word" });
    const message = thrown(() => parseUrl(url, "x")).message;
    expect(message).not.toContain("ss:word");
    expect(message).toContain("***@h");
  });
});

describe("RedactTests", () => {
  test("test_redact", () => {
    expect(redactUrl("ircs://u:p@h:6697/#c")).toBe("ircs://***@h:6697/#c");
    expect(redactUrl("irc://u@h/#c")).toBe("irc://***@h/#c");
    expect(redactUrl("irc://h/#c")).toBe("irc://h/#c");
    expect(redactUrl("junk")).toBe("junk");
    expect(redactUrl("ircs://u:p@ss:word@h/#c")).toBe("ircs://***@h/#c");
  });
});

// Not in the Python suite: urllib.parse.unquote and the Python regex details
// the URL reader inherits. Expectations taken from Python 3.13.
describe("UrlSemantics", () => {
  test("unquote leaves a broken escape alone and replaces bad UTF-8", () => {
    expect(parseUrl("irc://h/%zz%4", "u").channel).toBe("#%zz%4");
    expect(parseUrl("irc://h/%ff%c3%a4", "u").channel).toBe("#�ä");
  });

  test("the port takes any Unicode decimal digits, as int() does", () => {
    expect(parseUrl("irc://h:６６６７/#c", "u").server.port).toBe(6667);
  });

  test("the error text is a Python repr of the redacted URL", () => {
    expect(thrown(() => parseUrl("http://h/'x", "u")).message).toBe(
      `not an irc:// or ircs:// URL with a channel: "http://h/'x"`,
    );
  });
});
