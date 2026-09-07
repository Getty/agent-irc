import unittest

from agent_irc.config import Server, Target, expand_env, parse_url, redact_url


class ParseUrlTests(unittest.TestCase):
    def test_full_tls_url(self):
        t = parse_url("ircs://getty:s3cret@irc.example.org:6697/#agents", "nobody")
        self.assertEqual(t, Target(Server("ircs", "irc.example.org", 6697, "getty", "s3cret", False), "#agents"))
        self.assertTrue(t.server.tls)

    def test_defaults(self):
        t = parse_url("irc://irc.example.org/agents", "nobody")
        self.assertEqual(t.server, Server("irc", "irc.example.org", 6667, "nobody", None, False))
        self.assertEqual(t.channel, "#agents")
        self.assertFalse(t.server.tls)
        self.assertEqual(parse_url("ircs://h/x", "u").server.port, 6697)

    def test_password_only(self):
        t = parse_url("ircs://:pw@h/#c", "nobody")
        self.assertEqual((t.server.user, t.server.password), ("nobody", "pw"))

    def test_user_only(self):
        t = parse_url("ircs://getty@h/#c", "nobody")
        self.assertEqual((t.server.user, t.server.password), ("getty", None))

    def test_percent_decoding(self):
        t = parse_url("ircs://us%40er:p%23w@h/%23chan", "nobody")
        self.assertEqual((t.server.user, t.server.password, t.channel), ("us@er", "p#w", "#chan"))

    def test_channel_prefixes_kept(self):
        for ch in ("&local", "+modeless", "!safe"):
            self.assertEqual(parse_url("irc://h/" + ch, "u").channel, ch)

    def test_ipv6_literal_host(self):
        """An IPv6 address in a URL is bracketed, but socket.create_connection
        wants the bare address -- and every log line wants the brackets back."""
        t = parse_url("irc://[2001:db8::1]:6667/#chan", "nobody")
        self.assertEqual((t.server.host, t.server.port), ("2001:db8::1", 6667))
        self.assertEqual(t.server.label, "[2001:db8::1]:6667")

    def test_ipv6_literal_takes_the_scheme_default_port(self):
        t = parse_url("ircs://[::1]/#chan", "nobody")
        self.assertEqual((t.server.host, t.server.port), ("::1", 6697))

    def test_ipv6_literal_with_userinfo(self):
        t = parse_url("ircs://getty:pw@[fe80::1]:7000/#c", "nobody")
        self.assertEqual((t.server.host, t.server.port, t.server.user), ("fe80::1", 7000, "getty"))

    def test_insecure_flag(self):
        self.assertTrue(parse_url("ircs://h/#c?insecure=1", "u").server.insecure)
        self.assertTrue(parse_url("ircs://h/#c?insecure=true", "u").server.insecure)
        self.assertFalse(parse_url("ircs://h/#c?insecure=0", "u").server.insecure)
        self.assertFalse(parse_url("ircs://h/#c?other=1", "u").server.insecure)

    def test_host_lowercased(self):
        self.assertEqual(parse_url("irc://IRC.Example.ORG/#c", "u").server.host, "irc.example.org")

    def test_errors(self):
        for bad in ("http://h/#c", "irc://h", "irc://h/", "irc://h:abc/#c", "ircs:///#c", "irc://a@b@h/#c"):
            with self.assertRaises(ValueError, msg=bad):
                parse_url(bad, "u")

    def test_server_identity_ignores_channel(self):
        a = parse_url("ircs://u:p@h:6697/#a", "x").server
        b = parse_url("ircs://u:p@h/#b", "x").server
        self.assertEqual(a, b)
        self.assertEqual(hash(a), hash(b))

    def test_server_identity_ignores_insecure(self):
        a = parse_url("ircs://u:p@h/#a?insecure=1", "x").server
        b = parse_url("ircs://u:p@h/#b", "x").server
        self.assertTrue(a.insecure)
        self.assertFalse(b.insecure)
        self.assertEqual(a, b)
        self.assertEqual(hash(a), hash(b))

    def test_errors_do_not_leak_credentials(self):
        for bad in ("ircs://realuser:realsecret@h:notaport/#c", "ircs://realuser:realsecret@h/"):
            with self.assertRaises(ValueError) as ctx:
                parse_url(bad, "u")
            self.assertNotIn("realsecret", str(ctx.exception), bad)
            self.assertNotIn("realuser", str(ctx.exception), bad)
            self.assertIn("***@h", str(ctx.exception), bad)


class ExpandEnvTests(unittest.TestCase):
    def test_expands(self):
        self.assertEqual(expand_env("ircs://u:${PW}@h/#c", {"PW": "x y"}), "ircs://u:x y@h/#c")
        self.assertEqual(expand_env("no vars", {}), "no vars")

    def test_missing_raises_keyerror_with_name(self):
        with self.assertRaises(KeyError) as ctx:
            expand_env("${A}${B}", {"A": "1"})
        self.assertEqual(ctx.exception.args[0], "B")

    def test_expanded_password_with_at_sign_never_reaches_error_text(self):
        url = expand_env("ircs://u:${PW}@h:notaport/#c", {"PW": "p@ss:word"})
        with self.assertRaises(ValueError) as ctx:
            parse_url(url, "x")
        self.assertNotIn("ss:word", str(ctx.exception))
        self.assertIn("***@h", str(ctx.exception))


class RedactTests(unittest.TestCase):
    def test_redact(self):
        self.assertEqual(redact_url("ircs://u:p@h:6697/#c"), "ircs://***@h:6697/#c")
        self.assertEqual(redact_url("irc://u@h/#c"), "irc://***@h/#c")
        self.assertEqual(redact_url("irc://h/#c"), "irc://h/#c")
        self.assertEqual(redact_url("junk"), "junk")
        self.assertEqual(redact_url("ircs://u:p@ss:word@h/#c"), "ircs://***@h/#c")


if __name__ == "__main__":
    unittest.main()
