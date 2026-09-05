#!/usr/bin/env python3
"""Run the fake IRC server standalone: prints the port, then every received line.

    python3 tests/run_fakeirc.py [port]
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.fakeirc import FakeIrcServer  # noqa: E402

if __name__ == "__main__":
    server = FakeIrcServer()
    if len(sys.argv) > 1:
        # rebind on a fixed port so a config file can name it in advance
        server.sock.close()
        import socket
        server.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.sock.bind(("127.0.0.1", int(sys.argv[1])))
        server.sock.listen(8)
        server.port = int(sys.argv[1])
        import threading
        threading.Thread(target=server._accept_loop, daemon=True).start()
    print("fake ircd on 127.0.0.1:%d" % server.port, flush=True)
    seen = 0
    try:
        while True:
            lines = server.lines()
            for line in lines[seen:]:
                print(line, flush=True)
            seen = len(lines)
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
