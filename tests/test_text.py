import unittest

from agent_irc import text


class TextTests(unittest.TestCase):
    def test_first_line(self):
        self.assertEqual(text.first_line("  hello\nworld"), "hello")
        self.assertEqual(text.first_line(""), "")
        self.assertEqual(text.first_line(None), "")

    def test_truncate(self):
        self.assertEqual(text.truncate("a  b\n c", 10), "a b c")
        self.assertEqual(text.truncate("abcdefghij", 10), "abcdefghij")
        self.assertEqual(text.truncate("abcdefghijk", 10), "abcdefghi…")
        self.assertEqual(text.truncate("abcdefg hij", 9), "abcdefg…")

    def test_cut_bytes_keeps_characters_whole(self):
        s = "aäöü"  # 1 + 2 + 2 + 2 bytes
        self.assertEqual(text.cut_bytes(s, 4), "aä")
        self.assertEqual(text.cut_bytes(s, 7), "aäöü")
        self.assertEqual(text.cut_bytes(s, 0), "")

    def test_split_message_words_and_paragraphs(self):
        self.assertEqual(text.split_message("one two three", 9), ["one two", "three"])
        self.assertEqual(text.split_message("a\n\nb", 400), ["a", "b"])
        self.assertEqual(text.split_message("", 400), [])

    def test_split_message_long_word(self):
        self.assertEqual(text.split_message("x" * 10, 4), ["xxxx", "xxxx", "xx"])

    def test_split_message_multibyte(self):
        lines = text.split_message("ä" * 5, 4)
        self.assertEqual(lines, ["ää", "ää", "ä"])

    def test_short_path(self):
        self.assertEqual(text.short_path("/home/g/dev/p/a.py", "/home/g/dev/p", "/home/g"), "a.py")
        self.assertEqual(text.short_path("/home/g/x/a.py", "/home/g/dev/p", "/home/g"), "~/x/a.py")
        self.assertEqual(text.short_path("/home/g", "/home/g/dev/p", "/home/g"), "~")
        self.assertEqual(text.short_path("/etc/hosts", "/home/g/dev/p", "/home/g"), "/etc/hosts")
        self.assertEqual(text.short_path("rel.py", "/home/g/dev/p", "/home/g"), "rel.py")

    def test_fmt_duration(self):
        self.assertEqual(text.fmt_duration(0.04), "0.0s")
        self.assertEqual(text.fmt_duration(1.24), "1.2s")
        self.assertEqual(text.fmt_duration(42.6), "43s")
        self.assertEqual(text.fmt_duration(192), "3m12s")
        self.assertEqual(text.fmt_duration(4320), "1h12m")
        self.assertEqual(text.fmt_duration(9.96), "10s")
        self.assertEqual(text.fmt_duration(59.6), "1m00s")
        self.assertEqual(text.fmt_duration(3599.4), "59m59s")
        self.assertEqual(text.fmt_duration(3599.6), "1h00m")

    def test_fmt_tokens(self):
        self.assertEqual(text.fmt_tokens(0), "0")
        self.assertEqual(text.fmt_tokens(950), "950")
        self.assertEqual(text.fmt_tokens(1500), "2k")
        self.assertEqual(text.fmt_tokens(31000), "31k")
        self.assertEqual(text.fmt_tokens(210400), "210k")
        self.assertEqual(text.fmt_tokens(1200000), "1.2M")
        self.assertEqual(text.fmt_tokens(2000000), "2M")
        self.assertEqual(text.fmt_tokens(999499), "999k")
        self.assertEqual(text.fmt_tokens(999500), "1M")
        self.assertEqual(text.fmt_tokens(999999), "1M")

    def test_nick_base(self):
        self.assertEqual(text.nick_base("/home/g/dev/agent-irc"), "agent-irc")
        self.assertEqual(text.nick_base("/home/g/dev/My Project!"), "my-project")
        self.assertEqual(text.nick_base("/home/g/dev/2048"), "p-2048")
        self.assertEqual(text.nick_base("/"), "agent")
        self.assertEqual(text.nick_base("/home/g/dev/___"), "agent")


class SplitBlockTests(unittest.TestCase):
    def test_keeps_indentation_and_expands_tabs(self):
        block = "def f():\n    if x:\n\t\treturn 1\n\n"
        self.assertEqual(text.split_block(block), ["def f():", "    if x:", "        return 1"])

    def test_does_not_fit_lines_to_any_server(self):
        self.assertEqual(text.split_block("x" * 900), ["x" * 900])

    def test_empty(self):
        self.assertEqual(text.split_block(""), [])
        self.assertEqual(text.split_block(None), [])


class WrapPayloadTests(unittest.TestCase):
    def test_short_line_stays_whole(self):
        self.assertEqual(text.wrap_payload("  hello world", 400), ["  hello world"])
        self.assertEqual(text.wrap_payload("   ", 400), [])

    def test_continuations_keep_the_indent(self):
        self.assertEqual(text.wrap_payload("  aaa bbb ccc", 7), ["  aaa", "  bbb", "  ccc"])

    def test_word_longer_than_the_budget_is_cut_on_a_character_boundary(self):
        self.assertEqual(text.wrap_payload("ä" * 6, 4), ["ä" * 2] * 3)

    def test_nothing_is_lost(self):
        line = "  " + " ".join("word%d" % i for i in range(200))
        chunks = text.wrap_payload(line, 60)
        self.assertEqual(" ".join(c.strip() for c in chunks), line.strip())
        for chunk in chunks:
            self.assertLessEqual(len(chunk.encode("utf-8")), 60)


if __name__ == "__main__":
    unittest.main()
