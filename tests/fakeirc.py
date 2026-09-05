"""A minimal fake IRC server for tests: scripted registration, records every line."""

import socket
import threading
import time


class FakeIrcServer:
    def __init__(self, taken_nicks=(), password=None, max_nick=None, welcome_delay=0.0):
        self.taken = set(taken_nicks)
        self.password = password
        self.max_nick = max_nick
        self.welcome_delay = welcome_delay
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
                    self._send(conn, ":srv 005 %s NICKLEN=30 :are supported by this server" % nick)
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
