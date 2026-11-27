#!/usr/bin/env bun
// Run the fake IRC server standalone: prints the port, then every received
// line (port of tests/run_fakeirc.py).
//
//     bun tests/run_fakeirc.ts [port] [--tls] [--isupport TOKEN]...
//
// Anything typed on stdin is pushed at every connected client verbatim, which
// is how a live check feeds a session inbound traffic:
//
//     echo ':getty!getty@vhost.example PRIVMSG proj-1 :hello' | ...
//
// Beyond the Python runner: --tls serves TLS with the test key pair in
// tests/fixtures/ (an ircs:// URL then needs ?insecure=1), and each
// --isupport adds an RPL_ISUPPORT token, e.g. --isupport LINELEN=1024.
import { createInterface } from "node:readline";
import { FakeIrcServer } from "./fakeirc.js";

const args = process.argv.slice(2);
let port = 0;
let tls = false;
const isupport: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--tls") tls = true;
  else if (arg === "--isupport" && i + 1 < args.length) isupport.push(args[++i]!);
  else if (/^\d+$/.test(arg)) port = Number(arg);
  else {
    console.error("usage: bun tests/run_fakeirc.ts [port] [--tls] [--isupport TOKEN]...");
    process.exit(2);
  }
}

const server = await FakeIrcServer.create({ port, tls, isupport, onLine: (line) => console.log(line) });
console.log(`fake ircd on 127.0.0.1:${server.port}`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line) {
    server.sendToAll(line);
    console.log("<< " + line);
  }
});
// stdin at EOF must not end the server: it runs until interrupted.
process.on("SIGINT", () => process.exit(0));
