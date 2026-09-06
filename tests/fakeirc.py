"""A minimal fake IRC server for tests: scripted registration, records every line."""

import os
import socket
import ssl
import threading
import time

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
TLS_CERT = os.path.join(FIXTURES, "test-cert.pem")
TLS_KEY = os.path.join(FIXTURES, "test-key.pem")


class FakeIrcServer:
    def __init__(self, taken_nicks=(), password=None, max_nick=None, welcome_delay=0.0, tls=False,
                 isupport=(), isupport_delay=0.0):
        self.taken = set(taken_nicks)
        self.password = password
        self.max_nick = max_nick
        self.welcome_delay = welcome_delay
        self.isupport_delay = isupport_delay
        self.tls = tls
        self.isupport = ["NICKLEN=30"] + list(isupport)
        self.received = []
        self.connections = []
        self.lock = threading.Lock()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with self.lock:
                self.connections.append(conn)
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _send(self, conn, line):
        try:
            conn.sendall((line + "\r\n").encode("utf-8"))
        except OSError:
            pass

    def _serve(self, conn):
        if self.tls:
            # The handshake happens here, in the per-connection thread, so a
            # client that fails or refuses it (e.g. certificate verification
            # off the client's default trust store) only aborts this one
            # connection instead of the accept loop.
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(TLS_CERT, TLS_KEY)
            try:
                raw = conn
                conn = context.wrap_socket(conn, server_side=True)
                # wrap_socket detaches the raw socket; drop_all() must
                # see the wrapped one or it cannot close this connection.
                with self.lock:
                    self.connections = [conn if c is raw else c for c in self.connections]
            except (ssl.SSLError, OSError):
                try:
                    conn.close()
                except OSError:
                    pass
                return
        nick = user = passed = None
        welcomed = False
        try:
            for raw in conn.makefile("rb"):
                line = raw.rstrip(b"\r\n").decode("utf-8", "replace")
                with self.lock:
                    self.received.append(line)
                parts = line.split(" ")
                cmd = parts[0].upper()
                if cmd == "PASS":
                    passed = line.split(" ", 1)[1].lstrip(":")
                elif cmd == "NICK":
                    candidate = parts[1].lstrip(":")
                    if candidate in self.taken:
                        self._send(conn, ":srv 433 * %s :Nickname is already in use" % candidate)
                        continue
                    if self.max_nick and len(candidate) > self.max_nick:
                        self._send(conn, ":srv 432 * %s :Erroneous nickname" % candidate)
                        continue
                    nick = candidate
                elif cmd == "USER":
                    user = parts[1]
                elif cmd == "PING":
                    self._send(conn, ":srv PONG srv :" + line.split(":", 1)[-1])
                elif cmd == "JOIN":
                    self._send(conn, ":%s!u@h JOIN %s" % (nick, parts[1]))
                elif cmd == "QUIT":
                    self._send(conn, "ERROR :Closing Link")
                    break
                if nick and user and not welcomed:
                    welcomed = True
                    if self.password is not None and passed != self.password:
                        self._send(conn, "ERROR :Closing Link: bad password")
                        break
                    if self.welcome_delay:
                        time.sleep(self.welcome_delay)
                    self._send(conn, ":srv 001 %s :Welcome" % nick)
                    if self.isupport_delay:
                        # A real burst puts 001 and 005 back to back; this gap
                        # lets a test reproduce the case where they arrive in
                        # separate reads, so LINELEN is not yet known at 001.
                        time.sleep(self.isupport_delay)
                    self._send(conn, ":srv 005 %s %s :are supported by this server"
                               % (nick, " ".join(self.isupport)))
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def lines(self):
        with self.lock:
            return list(self.received)

    def wait_for(self, predicate, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate(self.lines()):
                return True
            time.sleep(0.02)
        return False

    def drop_all(self):
        with self.lock:
            conns, self.connections = self.connections, []
        for conn in conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()

    def close(self):
        self.drop_all()
        # shutdown() (not just close()) so a concurrent thread blocked in
        # accept() on this socket wakes up immediately instead of possibly
        # completing on a connection that races in after close().
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()
