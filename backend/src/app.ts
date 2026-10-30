// Backend wiring: the Bun replacement of EE2's Electron main process
// (main/src/main.ts). See DESIGN.md "Processes" and "Contracts".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostConfig } from "../../ipc/types";
import { Actions } from "./actions";
import { Binds } from "./binds";
import { ClipboardWatch, HostClipboard } from "./clipboard";
import { ConfigStore, leagueFromConfig } from "./config-store";
import { CookieJar, type HostCookie } from "./cookie-jar";
import { GameConfig } from "./game-config";
import { HostProcess } from "./host";
import { Hyprland } from "./hyprland";
import { Logger } from "./logger";
import { OverlayState } from "./overlay-state";
import { VERSION, checkSocketPath, type Paths } from "./paths";
import { DEFAULT_USER_AGENT, handleProxy } from "./proxy";
import { Server } from "./server";
import { ShellSocket, type ShellState } from "./shell";

// Port-only settings the renderer may add to HostConfig (two more ways to
// trigger a price check, DESIGN.md "Hotkeys"). Absent = off.
export interface HostConfigExt extends HostConfig {
  // pass-through bind on the game's own copy chord
  gameCopyBind?: boolean;
  // price-check every item copied while PoE2 is focused (wl-paste --watch)
  clipboardWatch?: boolean;
}

// EE2's getConfigForHost() for a default config, used until a page pushes
// the real one and nothing is cached yet. Item check on Alt + D (DESIGN.md).
export const DEFAULT_HOST_CONFIG: HostConfig = {
  shortcuts: [
    {
      shortcut: "Ctrl + D",
      action: { type: "copy-item", target: "price-check", focusOverlay: false },
      keepModKeys: true,
    },
    { shortcut: "Ctrl + Alt + D", action: { type: "copy-item", target: "price-check", focusOverlay: true } },
    { shortcut: "Shift + Space", action: { type: "toggle-overlay" } },
    { shortcut: "Alt + D", action: { type: "copy-item", target: "item-check", focusOverlay: true } },
    { shortcut: "F5", action: { type: "paste-in-chat", text: "/hideout", send: true } },
    { shortcut: "F9", action: { type: "paste-in-chat", text: "/exit", send: true } },
  ],
  restoreClipboard: false,
  clientLog: null,
  gameConfig: null,
  stashScroll: true,
  overlayKey: "Shift + Space",
  logKeys: false,
  windowTitle: "Path of Exile 2",
  language: "en",
  readClientLog: false,
  libraryAlpha: false,
  libraryOutputPath: null,
  initialDelay: 48,
  hideOverlayOnBlur: false,
};

export interface Backend {
  logger: Logger;
  server: Server;
  shutdown(code?: number): Promise<void>;
  command(cmd: string, args: string[]): Promise<unknown>;
}

function readSecrets(configDir: string): { poesessid?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, "secrets.json"), "utf8"));
  } catch {
    return {};
  }
}

export async function startBackend(paths: Paths, opts: { hyprland?: boolean } = {}): Promise<Backend> {
  const logger = new Logger();
  checkSocketPath(path.join(paths.runtimeDir, "shell.sock"));
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });

  process.addListener("uncaughtException", (err) => {
    logger.write(`error [uncaughtException] ${err.message}, ${err.stack}`);
  });
  process.addListener("unhandledRejection", (reason) => {
    logger.write(`error [unhandledRejection] ${(reason as Error)?.stack ?? reason}`);
  });

  const config = new ConfigStore(paths.configDir, logger, paths.ee2Config);
  config.importEe2Once();
  let league = leagueFromConfig(await config.load());

  const jar = new CookieJar(path.join(paths.configDir, "cookies.json"), logger);
  jar.poesessid = process.env.OMAEXILED_POESESSID || readSecrets(paths.configDir).poesessid || null;

  let hostConfig: HostConfigExt = config.loadHostConfig() ?? DEFAULT_HOST_CONFIG;
  const gameConfig = new GameConfig(logger);
  const hypr = new Hyprland(logger, opts.hyprland === false ? null : undefined);
  const clipboard = new HostClipboard(logger);
  const binds = new Binds(hypr, logger, paths.runtimeDir);

  let shell: ShellSocket;
  let host: HostProcess;
  const userAgent = () => host?.userAgent || DEFAULT_USER_AGENT;

  const server = new Server({
    port: paths.port,
    rendererDir: paths.rendererDir,
    logger,
    config,
    version: VERSION,
    proxy: (req) => handleProxy(req, { jar, logger, userAgent }),
    onOverlayWanted: () => host.ensureRunning(),
  });
  await server.start();

  host = new HostProcess({
    socketPath: path.join(paths.runtimeDir, "host.sock"),
    bin: paths.hostBin,
    url: server.url,
    logger,
    onMessage: (msg) => {
      if (msg.type === "overlay.state") {
        overlay.onHostState(Boolean(msg.mapped), Boolean(msg.keyboardFocus));
      } else if (msg.type === "cookies" && Array.isArray(msg.cookies)) {
        jar.replaceFromHost(msg.cookies as HostCookie[]);
      }
    },
    onConnected: () => {
      overlay.onHostConnected();
      shell?.broadcastState();
    },
    onDisconnected: () => {
      overlay.onHostConnected();
      shell?.broadcastState();
    },
  });

  const overlay: OverlayState = new OverlayState({
    hypr,
    logger,
    broadcast: (e) => server.sendEventTo("broadcast", e),
    sendItemText: (p) => server.sendItemText(p),
    host: {
      get connected() {
        return host.connected;
      },
      send: (m) => host.send(m),
    },
    setPanel: (v) => binds.setPanel(v),
    onChange: () => {
      shell?.broadcastState();
      updateWatch();
    },
    onGamePresence: (present) => host.setGamePresent(present),
  });

  const actions = new Actions({
    hypr,
    logger,
    clipboard,
    gameConfig,
    overlay,
    logKeys: () => hostConfig.logKeys,
    refreshGameConfig: () => {
      if (gameConfig.readConfig(hostConfig.gameConfig ?? "")) {
        applyHostConfig(hostConfig).catch((e) => logger.write(`error [Shortcuts] ${(e as Error).message}`));
      }
    },
    broadcast: (e) => server.sendEventTo("broadcast", e),
  });

  const watch = new ClipboardWatch(
    logger,
    (text) => {
      overlay.cursorInSurface().then((pos) => actions.priceCheckCopiedText(text, pos));
    },
    () => clipboard.isOwnChange,
  );
  function updateWatch() {
    watch.setActive(Boolean(hostConfig.clipboardWatch) && overlay.gameFocused);
  }

  // EE2 main.ts `update-host-config` fan-out. The game ini is read before
  // the hotkeys are validated (EE2 used a stale copy chord on first run).
  async function applyHostConfig(cfg: HostConfigExt, force = false) {
    hostConfig = cfg;
    overlay.setWindowTitle(cfg.windowTitle);
    clipboard.updateOptions(cfg.restoreClipboard);
    clipboard.updateDelay(cfg.initialDelay);
    gameConfig.readConfig(cfg.gameConfig ?? "");
    const lua = binds.update(cfg.shortcuts, {
      showModsKey: gameConfig.showModsKey,
      windowTitle: cfg.windowTitle || DEFAULT_HOST_CONFIG.windowTitle,
      gameCopyBind: cfg.gameCopyBind,
    });
    await binds.install(lua, force);
    updateWatch();
    shell?.broadcastState();
  }

  server.onEventAnyClient("CLIENT->MAIN::update-host-config", (cfg) => {
    if (!cfg || !Array.isArray(cfg.shortcuts)) return;
    const before = JSON.stringify(hostConfig);
    if (JSON.stringify(cfg) !== before) config.saveHostConfig(cfg);
    applyHostConfig(cfg).catch((e) => logger.write(`error [Shortcuts] ${(e as Error).message}`));
  });
  server.onEventAnyClient("CLIENT->MAIN::save-config", (cfg) => {
    if (typeof cfg?.contents !== "string") return;
    config.save(cfg.contents, Boolean(cfg.isTemporary));
    server.sendEventTo("broadcast", {
      name: "MAIN->CLIENT::config-changed",
      payload: { contents: cfg.contents },
    });
    league = leagueFromConfig(cfg.contents);
    shell?.broadcastState();
  });
  // EE2 tracked the last active page for item-text; with page roles
  // item-text always goes to the overlay page, so nothing to do here.
  server.onEventAnyClient("CLIENT->MAIN::used-recently", () => {});
  server.onEventAnyClient("CLIENT->MAIN::user-action", (e) => {
    if (e.action === "quit") {
      shutdown(0);
    } else if (e.action === "stash-search") {
      actions.stashSearch(e.text).catch((err) => logger.write(`error [Shortcuts] ${(err as Error).message}`));
    } else if (e.action === "check-for-update") {
      server.sendEventTo("broadcast", {
        name: "MAIN->CLIENT::updater-state",
        payload: { state: "update-not-available", checkedAt: Date.now() },
      });
    }
  });
  server.onEventAnyClient("OVERLAY->MAIN::focus-game", () => overlay.assertGameActive());
  server.onEventAnyClient("OVERLAY->MAIN::render-state", (e) => overlay.onRenderState(Boolean(e?.shouldShow)));
  server.onEventAnyClient("OVERLAY->MAIN::track-area", (e) => overlay.onTrackArea(e));
  server.onEventAnyClient("OVERLAY->MAIN::input-region", (e) => overlay.onInputRegion(e));
  server.onEventAnyClient("CLIENT->MAIN::open-settings", () => openSettings());
  server.onEventAnyClient("CLIENT->MAIN::open-browser", (e) => {
    if (typeof e?.url === "string") openBrowser(e.url);
  });
  server.onClientConnected((role, send) => {
    if (role === "overlay") send(overlay.focusChangeEvent());
  });

  function openSettings() {
    host.request({ type: "settings.open" });
  }
  function openBrowser(url: string) {
    if (!/^https?:\/\//.test(url)) throw new Error(`not an http(s) URL: ${url}`);
    host.request({ type: "browser.open", url });
  }

  function runAction(id: string) {
    const bind = binds.find(id);
    if (!bind) {
      logger.write(`warn [Shortcuts] Unknown action "${id}"`);
      return;
    }
    actions.runBind(bind).catch((e) => logger.write(`error [Shortcuts] ${(e as Error).message}`));
  }

  hypr.onEvent((event, data) => {
    if (event === "custom") {
      if (data.startsWith("omaexiled:")) runAction(data.slice("omaexiled:".length));
      return;
    }
    if (event === "configreloaded") {
      // the reload dropped the Lua state with our binds and rules
      applyHostConfig(hostConfig, true).then(() => binds.setPanel(overlay.shown != null));
    }
    overlay.handleEvent(event, data);
  });
  hypr.onConnect(() => {
    applyHostConfig(hostConfig, true).then(() => overlay.refresh());
  });

  function shellState(): ShellState {
    return {
      running: true,
      gameDetected: overlay.game != null,
      gameFocused: overlay.gameFocused,
      league,
      leagueId: league,
      overlayKey: hostConfig.overlayKey,
      url: server.url,
      configDir: paths.configDir,
      hostRunning: host.running,
    };
  }

  async function itemFromFile(target: string, focusOverlay: boolean, file: string) {
    const text = fs.readFileSync(file, "utf8");
    const position = await overlay.cursorInSurface();
    overlay.tracker.stop();
    overlay.sendItemText({ target, clipboard: text, position, focusOverlay });
    if (focusOverlay) overlay.assertOverlayActive();
    return { target, position, focusOverlay };
  }

  function flag(args: string[], name: string) {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    return args[i + 1] ?? "";
  }

  async function command(cmd: string, args: string[]): Promise<unknown> {
    switch (cmd) {
      case "status":
        return {
          version: VERSION,
          pid: process.pid,
          url: server.url,
          state: shellState(),
          overlay: overlay.status(),
          host: host.status(),
          clients: server.roles(),
          hyprland: hypr.available,
          binds: binds.binds.map((b) => ({ id: b.id, shortcut: b.shortcut, combo: b.hypr.combo, mode: b.mode })),
          showModsKey: gameConfig.showModsKey,
          gameConfigFile: gameConfig.actualPath,
          clipboardWatch: watch.running,
          cookies: jar.size,
          paths,
        };
      case "price-check":
      case "item-check": {
        const target = cmd;
        const locked = cmd === "item-check" || args.includes("--locked");
        const file = flag(args, "--text-file");
        if (file !== undefined) return itemFromFile(target, locked, file);
        const text = await actions.copyItem({ type: "copy-item", target, focusOverlay: locked });
        return { target, found: text != null };
      }
      case "chat": {
        const text = flag(args, "--text");
        if (text !== undefined) {
          await actions.typeInChat(text, !args.includes("--no-send"));
          return { text };
        }
        const index = Number(args[0]);
        const chats = binds.binds.filter((b) => b.action.type === "paste-in-chat");
        const bind = chats[index];
        if (!bind || bind.action.type !== "paste-in-chat") {
          throw new Error(`no chat command ${args[0] ?? ""} (have ${chats.length})`);
        }
        await actions.typeInChat(bind.action.text, bind.action.send);
        return { text: bind.action.text, send: bind.action.send };
      }
      case "stash-search":
        if (!args.length) throw new Error("usage: stash-search <text>");
        await actions.stashSearch(args.join(" "));
        return null;
      case "toggle-overlay":
        overlay.toggleOverlay();
        return null;
      case "hide":
        overlay.closePanel();
        return null;
      case "open-settings":
        openSettings();
        return null;
      case "open-browser":
        openBrowser(args[0] || "https://www.pathofexile.com/trade2");
        return null;
      case "reload-binds":
        await applyHostConfig(hostConfig, true);
        await binds.setPanel(overlay.shown != null);
        return binds.binds.map((b) => ({ id: b.id, shortcut: b.shortcut, combo: b.hypr.combo, mode: b.mode }));
      case "devtools": {
        const target = args[0] === "settings" ? "settings" : "overlay";
        host.request({ type: "devtools", target });
        return null;
      }
      case "quit":
        setTimeout(() => shutdown(0), 50);
        return null;
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  }

  shell = new ShellSocket({
    dir: paths.runtimeDir,
    version: VERSION,
    logger,
    state: shellState,
    command: (cmd, args) => command(cmd, args),
  });
  host.listen();
  shell.listen();

  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    logger.write("info [Main] Shutting down");
    overlay.tracker.stop();
    watch.setActive(false);
    await binds.disable();
    await host.stop();
    server.stop();
    shell.close();
    host.close();
    jar.saveNow();
    hypr.stop();
    process.exit(code);
  }

  logger.write(`info ${os.type()} ${os.release()} / v${VERSION}`);
  logger.write(`info [Main] Listening on ${server.url}`);
  if (hypr.available) {
    hypr.startEvents();
  } else {
    logger.write("error [Hyprland] HYPRLAND_INSTANCE_SIGNATURE is not set; hotkeys are unavailable");
    await applyHostConfig(hostConfig);
  }

  return { logger, server, shutdown, command };
}

