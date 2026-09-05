# Test fixtures

`test-cert.pem` and `test-key.pem` are a throwaway self-signed pair for the
fake ircd in `tests/fakeirc.py` (`FakeIrcServer(tls=True)`). They are used
only by the test suite on localhost and protect nothing. Regenerate with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout tests/fixtures/test-key.pem \
        -out tests/fixtures/test-cert.pem -days 3650 -subj /CN=localhost
