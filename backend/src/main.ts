#!/usr/bin/env bun
// omaexiled backend
//   run                   start the backend (systemd: omaexiled.service)
//   ctl <cmd> [args]      talk to the running backend over shell.sock
import path from "node:path";
import { startBackend } from "./app";
import { resolvePaths } from "./paths";
import { ctlRequest } from "./shell";

const USAGE = `usage: omaexiled run
       omaexiled ctl <command> [args]

ctl commands:
  status                                    JSON status
  price-check [--locked] [--text-file F]    copy the hovered item (or use F) and price-check it
  item-check [--text-file F]
  chat <index> | chat --text T [--no-send]  run a chat command (index among chat hotkeys)
  stash-search <text>
  toggle-overlay | hide
  open-settings | open-browser [url]
  reload-binds
  devtools <overlay|settings>
  quit`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const paths = resolvePaths();
  const sock = path.join(paths.runtimeDir, "shell.sock");

  if (cmd === "run") {
    // single instance: a live backend answers on shell.sock
    const alive = await ctlRequest(sock, "status", [], 1000).then(
      () => true,
      () => false,
    );
    if (alive) {
      console.error(`OmaExiled is already running (${sock})`);
      return 1;
    }
    const backend = await startBackend(paths);
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(sig, () => backend.shutdown(0));
    }
    return null; // keep running
  }

  if (cmd === "ctl") {
    if (!rest.length) {
      console.error(USAGE);
      return 2;
    }
    // files are read by the backend: make paths absolute
    const args = rest.slice(1).map((a, i, all) => (all[i - 1] === "--text-file" ? path.resolve(a) : a));
    try {
      const reply = await ctlRequest(sock, rest[0], args);
      if (!reply.ok) {
        console.error(`error: ${reply.error}`);
        return 1;
      }
      if (reply.result != null) console.log(JSON.stringify(reply.result, null, 2));
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }

  console.error(USAGE);
  return cmd === "-h" || cmd === "--help" ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code != null) process.exit(code);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
