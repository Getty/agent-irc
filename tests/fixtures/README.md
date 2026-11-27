# Test fixtures

`test-cert.pem` and `test-key.pem` are a throwaway self-signed pair for the
fake ircd in `tests/fakeirc.py` (`FakeIrcServer(tls=True)`). They are used
only by the test suite on localhost and protect nothing. Regenerate with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout tests/fixtures/test-key.pem \
        -out tests/fixtures/test-cert.pem -days 3650 -subj /CN=localhost

`getty-bun-requirement.schema.json` is a byte copy of
`assets/requirement.schema.json` from the `getty-bun-integration` skill
(agent-bun-runtime `v0.1.0`), which validates `gettyBun` in `package.json`.
skilletor installs that skill untracked, so a clone and CI see only this copy;
`tests/build.test.ts` compares the two wherever the skill is installed. After a
`ref` bump in `.claude/skilletor.json`, copy it again.
