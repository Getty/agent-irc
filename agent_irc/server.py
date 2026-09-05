"""Wire the MCP loop, the dispatcher thread, configuration, session and IRC connections (spec §3, §6)."""

import json
import os
import queue
import signal
import sys
import threading
import time

from agent_irc import __version__, mcp
from agent_irc.config import load_config
from agent_irc.events import Session
from agent_irc.irc import IrcConnection
from agent_irc.text import nick_base


def detect_harness(client_info):
    name = str((client_info or {}).get("name") or "").lower()
    if "claude" in name:
        return "claude"
    if "codex" in name:
        return "codex"
    return name or "agent"


def _usable_session_id(value):
    return bool(value) and not str(value).startswith("${")


class App:
    def __init__(self, home, env, stdin, stdout, log, connection_factory=IrcConnection, debug=None):
        self.home = home
        self.env = env
        self.stdin = stdin
        self.stdout = stdout
        self.log = log
        self.debug = debug
        self.connection_factory = connection_factory
        self.harness = "agent"
        self.level = None
        self.session = None
        self.connections = []
        self.stopped = False
        self.queue = queue.Queue()
        self.worker = threading.Thread(target=self._dispatch, daemon=True, name="agent-irc-dispatch")

    # -- MCP callbacks (main thread) ----------------------------------------

    def on_initialize(self, params):
        self.harness = detect_harness(params.get("clientInfo"))
        self.log("agent-irc %s: initialized by %s" % (__version__, self.harness))

    def on_event(self, arguments):
        self.queue.put(dict(arguments))

    def run(self):
        self.worker.start()
        try:
            mcp.serve(self.stdin, self.stdout, self.on_initialize, self.on_event, self.log, __version__)
        finally:
            self.shutdown()

    # -- dispatcher thread --------------------------------------------------

    def _dispatch(self):
        while True:
            ev = self.queue.get()
            if ev is None:
                return
            try:
                self._handle(ev)
            except Exception as e:
                self.log("agent-irc: event dropped: %r" % e)

    def _handle(self, ev):
        if self.debug:
            self.debug("agent-irc: event %s" % json.dumps(ev, sort_keys=True)[:2000])
        session_id = ev.get("session_id")
        if self.session is not None and _usable_session_id(session_id) and str(session_id) != self.session.session_id:
            # /clear or /resume hands the running server a new session_id
            # (and transcript_path) without restarting it. Without this, the
            # old Session would keep counting turns and tailing the old
            # transcript forever. The config level was already loaded for
            # this process and the connections are already open and joined,
            # so neither is redone -- only the per-session state resets.
            self.log("agent-irc: new session %s replaces %s" % (str(session_id)[:8], self.session.session_id[:8]))
            cwd = str(ev.get("cwd") or self.session.cwd)
            self.session = Session(self.harness, self.level, cwd, self.home, debug=self.debug)
        if self.session is None:
            if not _usable_session_id(session_id):
                return
            if ev.get("event") == "SessionEnd":
                # A harness may start a fresh server process to deliver
                # SessionEnd after the process holding the real session state
                # already exited (observed in Claude Code print mode:
                # SIGTERM kills the connection, then a new one connects for
                # this one event). This process never saw the session's
                # activity, so announcing a session here would be a phantom
                # start+end with a false "0 turns" summary. Stay quiet.
                self.log("agent-irc: SessionEnd with no prior state, staying quiet")
                return
            cwd = str(ev.get("cwd") or os.getcwd())
            config = load_config(self.harness, cwd, self.home, self.env, self.log)
            self.level = config.level
            self.session = Session(self.harness, self.level, cwd, self.home, debug=self.debug)
            self._connect(config, cwd, str(ev["session_id"]))
        for line in self.session.handle(ev):
            for connection in self.connections:
                connection.send_message(line)

    def _connect(self, config, cwd, session_id):
        by_server = {}
        for target in config.targets:
            by_server.setdefault(target.server, []).append(target.channel)
        if not by_server:
            self.log("agent-irc: no channels configured, staying quiet")
            return
        realname = "%s %s %s" % (self.harness, session_id, cwd)
        for server, channels in by_server.items():
            connection = self.connection_factory(server, channels, nick_base(cwd), realname, self.log)
            connection.start()
            self.connections.append(connection)
            self.log("agent-irc: connecting to %s for %s" % (server.label, " ".join(channels)))

    # -- teardown -----------------------------------------------------------

    def shutdown(self):
        if self.stopped:
            return
        self.stopped = True
        self.queue.put(None)
        self.worker.join(2.0)
        if self.session is None:
            return
        message = "session ended · " + self.session.summary()
        for connection in self.connections:
            connection.begin_close(message)
        deadline = time.monotonic() + 2.0
        for connection in self.connections:
            connection.join(max(0.0, deadline - time.monotonic()))


def install_signal_handlers(log, is_stopped=None):
    """Turn SIGTERM/SIGINT/SIGHUP into SystemExit in the main thread, so run()'s finally sends the QUIT.

    Only the first signal raises. begin_close() only asks the connection
    thread to send the QUIT; it does not send it itself, so shutdown()'s
    join()s are what actually give that thread time to run. A harness that
    escalates fast (Claude Code sends SIGINT, then ~100ms later SIGTERM,
    live-observed 2026-09-05, Task 20) can land its second signal while
    shutdown() is still blocked inside one of those join()s, unwinding it
    before the QUIT is ever written. A later signal is logged and otherwise
    ignored; shutdown()'s own 2s budgets already bound the wait.

    is_stopped, when given, is polled too: an EOF-triggered shutdown() (no
    signal involved at all) sets App.stopped immediately, before it has
    finished sending the QUIT. Without this check, the first signal to
    arrive afterwards would still see this handler's own `stopping` as
    False and raise SystemExit, unwinding that already-in-progress
    shutdown() from underneath it the same way a second signal could.
    """
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        if stopping or (is_stopped is not None and is_stopped()):
            log("agent-irc: signal %d, already shutting down" % signum)
            return
        stopping = True
        log("agent-irc: signal %d, shutting down" % signum)
        raise SystemExit(128 + signum)

    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        signum = getattr(signal, name, None)
        if signum is None:
            continue
        try:
            signal.signal(signum, stop)
        except (ValueError, OSError):
            pass


def main():
    def log(message):
        sys.stderr.write(message + "\n")
        sys.stderr.flush()

    debug = log if os.environ.get("AGENT_IRC_DEBUG") == "1" else None
    app = App(os.path.expanduser("~"), dict(os.environ), sys.stdin, sys.stdout, log, debug=debug)
    install_signal_handlers(log, lambda: app.stopped)
    app.run()
