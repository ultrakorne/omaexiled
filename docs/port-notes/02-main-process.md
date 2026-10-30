# 02 — Electron main process → Bun backend

Source: `/home/ultra/Developer/Exiled-Exchange-2` (branch `master`, main package
`exiled-exchange-2` v0.16.3, Electron ^40.9.1). Paths below are relative to that
repo unless absolute. Line numbers refer to `master`.

This note covers everything the Electron main process (`main/src/**`) does, the
exact wire contracts the renderer depends on, the behaviours the Bun backend has
to reproduce (or deliberately drop), and what the user's Linux experiments
(`omarchy`, `omarchy_2`, `omarchy_new`) plus the earlier Go/Quickshell prototype
(`/home/ultra/Developer/poe_price_checker`) learned on this exact machine.

---

## 0. Scope map (keep / drop per file)

| File | Lines | What it does | OmaExiled |
|---|---|---|---|
| `main/src/main.ts` | 139 | bootstrap, wiring, `update-host-config` fan-out | **port** (backend entry) |
| `main/src/server.ts` | 149 | HTTP server, static files, `/config`, WebSocket `/events`, event bus | **port exactly** |
| `main/src/proxy.ts` | 92 | `/proxy/<host>/<path>` HTTPS forwarder + cookie fix | **port exactly** (see Cloudflare risk) |
| `main/src/host-files/ConfigStore.ts` | 46 | config.json load/save + `config-changed` broadcast | **port** (atomic write) |
| `main/src/host-files/GameConfig.ts` | 135 | reads PoE2 ini → `show_advanced_item_descriptions` key | **port** (decides Ctrl+C vs Ctrl+Alt+C) |
| `main/src/host-files/utils.ts` | 19 | `guessFileLocation` | port (tiny) |
| `main/src/shortcuts/Shortcuts.ts` | 368 | hotkey validation/registration, all hotkey actions, copy-item | **port semantics** → Hyprland binds + `sendshortcut` |
| `main/src/shortcuts/HostClipboard.ts` | 173 | clipboard poll for item text, restore, throttle, `isPoeItem` | **port semantics** → `wl-paste`/`wl-copy` |
| `main/src/shortcuts/text-box.ts` | 72 | chat command typing, stash search typing | **port semantics** → `sendshortcut` sequences |
| `main/src/windowing/OverlayWindow.ts` | 236 | overlay BrowserWindow, focus model, `focus-change` events | **port semantics** (events only; window → Qt host) |
| `main/src/windowing/GameWindow.ts` | 57 | game focus/bounds via electron-overlay-window | **port** → Hyprland socket2 |
| `main/src/windowing/WidgetAreaTracker.ts` | 123 | hold-mode auto-close / hover-activate of the price panel | **port semantics** (reduced) |
| `main/src/windowing/OverlayVisibility.ts` | 71 | hide overlay while Alt is held alone | optional (needs key events) |
| `main/src/RemoteLogger.ts` | 16 | log buffer + `log-entry` broadcast | **port exactly** |
| `main/src/AppTray.ts` | 70 | tray menu | replaced by Omarchy bar plugin; keep `quit` action |
| `main/src/AppUpdater.ts` | 83 | electron-updater | **drop**; stub `updater` state |
| `main/src/host-files/GameLogWatcher.ts` | 160 | tails Client.txt → `game-log` | **drop** (only leveling/XP tracker uses it) |
| `main/src/host-files/FileWriter.ts` | 192 | library alpha CSV / client-log ndjson | **drop** |
| `main/src/host-files/file-uploads.ts` | 39 | `/uploads/` GET/POST (image strip, map check) | **drop** |
| `main/src/vision/*` | — | heist gem OCR (Windows only, `process.platform !== "win32"` → return) | **drop** |
| `ipc/types.ts`, `ipc/KeyToCode.ts` | — | shared contracts (already copied verbatim into `/home/ultra/Developer/OmaExiled/ipc/`) | keep |

Runtime deps being replaced: `uiohook-napi` (global key/mouse hook + key
injection, XTest — dead under XWayland), `electron-overlay-window` (X11 target
tracking, override-redirect overlay), Electron `globalShortcut`, `clipboard`,
`screen`, `net`, `session`, `Tray`, `autoUpdater`.

---

## 1. System dependencies on this machine (answer to "what do I have to install")

Checked on 2026-10-30 (`pacman -Q`, `command -v`, `hyprctl version`):

| Need | Status | Notes |
|---|---|---|
| Bun | **installed** `bun 1.4.3-1` (`/usr/bin/bun`) | backend runtime; can also run the renderer's Vite build |
| wl-clipboard (`wl-paste`, `wl-copy`) | **installed** `1:2.3.0-1` | clipboard read/watch/write |
| Hyprland / `hyprctl` | **installed** 0.56.2 (Lua config!) | `hyprctl` has `dispatch`, `eval <lua>`, `keyword`, `cursorpos`, `globalshortcuts`; sockets at `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock` and `.socket2.sock` |
| Qt 6 base / declarative / wayland | **installed** 6.12.0 | |
| Qt WebEngine | **installed** `qt6-webengine 6.11.2-2` (+ `/usr/lib/qt6/QtWebEngineProcess`) | one minor behind qt6-base 6.12.0 (that is the current Arch repo state). Smoke test: a QML file importing `QtWebEngine` + `org.kde.layershell` loads under `QT_QPA_PLATFORM=offscreen` (exit 0); DESIGN.md also reports a working layer-surface WebEngineView. Watch for breakage on the next partial upgrade |
| qt6-webchannel, qt6-positioning, qt6-svg, qt6-imageformats | **installed** 6.12.0 | |
| layer-shell-qt | **installed** 6.8.1 (headers `/usr/include/LayerShellQt`, CMake config `/usr/lib/cmake/LayerShellQt`, QML module `org.kde.layershell`) | ships **only a CMake package** (no qmake `.pri`, no `.pc`) |
| C++ toolchain | **installed** gcc 16.2.1, make, pkgconf | |
| **CMake** | **MISSING** | required to build the Qt host against LayerShellQt. Install: `sudo pacman -S --needed cmake ninja` (ninja optional but recommended) |
| xdg-utils (`xdg-open`) | **installed** | open external links (EE2 used `shell.openExternal`) |
| quickshell / omarchy-shell | **installed** `quickshell 0.3.2` | bar plugin |
| jq | installed | handy for diagnostics only |
| ydotool / ydotoold | installed, user service **active** | **not needed** (see §10). Can stay; never use it for chords that share Ctrl/Alt with the bind |
| wtype, xdotool, uiohook, Electron | — | **not needed** |
| xclip | missing | **optional**: only if you want an X11-side clipboard fallback like `omarchy_new` (Electron X11 poll). Not needed for the `sendshortcut` copy path (the prototype reads with `wl-paste` only). `sudo pacman -S xclip` if wanted |

Things on the system that are not packages but will bite:

- **Hyprland bind conflicts with EE2 defaults** (from `hyprctl -j binds`):
  - `CTRL+ALT+D` → "PoE2 price check" = the old prototype script
    `/home/ultra/Developer/poe_price_checker/bin/poe-pricecheck.sh`, declared in
    `~/.config/hypr/bindings.lua` line 10 (`o.bind("CTRL + ALT + D", …)`).
    This is EE2's default **locked price check** hotkey (`hotkeyLocked: "Ctrl + Alt + D"`).
    Remove that line (or pick another hotkey) before testing.
  - `F9` (press **and** release binds) → Omarchy "Start/Stop dictation
    (push-to-talk)". EE2's default chat command `/exit` is on `F9`. Hyprland
    fires every matching bind, so both would run. Either rebind `/exit` or
    unbind dictation while PoE2 is focused.
  - `F5`, `Ctrl+D`, `Shift+Space`, `Ctrl+Alt+C`, `Alt+D` are free
    (`SUPER+SHIFT+SPACE` exists but has SUPER).
- **PoE2 display mode**: the prototype found that PoE2 in Windowed-Fullscreen /
  Fullscreen is `fullscreen=2` in Hyprland, which wedges XWayland input on this
  NVIDIA setup (**`sendshortcut` Ctrl+C copies nothing, clicks fall through**).
  Working mode: in-game **Windowed** (`fullscreen=0`) plus workspace rule
  `workspace = 4, gapsout:1, gapsin:0, bordersize:0, rounding:false` (never
  size the game to exactly the monitor size — PoE2 flips to `fullscreen=2`).
  Currently observed: `steam_app_2694490`, title `Path of Exile 2`,
  `xwayland: true`, `fullscreen: 0`, workspace 4, monitor `DP-1` 2560×1440
  scale 1 at 0,0.

---

## 2. Bootstrap — `main/src/main.ts`

Order of operations (must be mirrored where kept):

1. `app.requestSingleInstanceLock()`; if false → `app.exit()` (L20-22). Port:
   single instance via systemd unit and/or a lock file in
   `$XDG_RUNTIME_DIR` (EE2's stale `~/.config/exiled-exchange-2/Singleton*`
   files were a recurring problem on this machine).
2. `app.disableHardwareAcceleration()` on non-darwin (L24-26),
   `app.enableSandbox()` (L27). Host concern only.
3. macOS accessibility wait (L31-63) — ignore.
4. On `ready` (L65): construct `AppTray`, `Logger`, `GameConfig`, `GameWindow`,
   `AppUpdater`, `HttpProxy(server, logger)`, `FileWriter`, `GameLogWatcher`
   (L66-74). Vue devtools in dev (L76-84). `uncaughtException` /
   `unhandledRejection` → `logger.write("error [uncaughtException] …")` /
   `"error [unhandledRejection] …"` (L85-90).
5. `setTimeout(…, linux ? 1000 : 0)` (L92-137, "fixes(linux): window is black
   instead of transparent"):
   - `new OverlayWindow(eventPipe, logger, poeWindow)` (L94)
   - `new OverlayVisibility(eventPipe, overlay, gameConfig)` (L96)
   - `await Shortcuts.create(…)` (spawns OCR worker) (L97-103)
   - registers the **`CLIENT->MAIN::update-host-config`** handler (L104-126),
     which fans out in this exact order:
     1. `overlay.updateOpts(cfg.overlayKey, cfg.windowTitle, cfg.hideOverlayOnBlur)`
        (also triggers the one-time `attachByTitle`)
     2. `shortcuts.updateActions(cfg.shortcuts, cfg.stashScroll, cfg.logKeys, cfg.restoreClipboard, cfg.language)`
     3. `shortcuts.updateDelay(cfg.initialDelay)`
     4. `gameLogWatcher.restart(cfg.clientLog ?? "", cfg.readClientLog)`
     5. `gameConfig.readConfig(cfg.gameConfig ?? "")` (async, not awaited)
     6. `appUpdater.checkAtStartup()`
     7. `tray.overlayKey = cfg.overlayKey`
     8. `fileWriter.restart(cfg.libraryAlpha, cfg.libraryOutputPath)`
   - `uIOhook.start()` (L127)
   - `port = await startServer(appUpdater, logger)` (L129)
   - `logger.write(\`info ${os.type()} ${os.release} / v${app.getVersion()}\`)`
     (L131; bug: `os.release` is not called, so it prints the function source)
   - `overlay.loadAppPage(port)` → `http://localhost:${port}/index.html` (L132)
   - `tray.serverPort = port` (L133)

**Race to know about:** step 2 computes the reserved copy chord from
`gameConfig.showModsKey` *before* step 5 has read the ini, so on the first
`update-host-config` it uses the default `"Alt"`. `pressKeysToCopyItemText`
reads `showModsKey` at press time, so only the reserved-key check is stale. The
port should read the game ini first, then validate hotkeys.

CLI flags / env used anywhere in main:

| Flag/env | Where | Effect |
|---|---|---|
| `--listen=[host][:port]` | `server.ts` L133-139 | override bind host/port (default `127.0.0.1`, port `0` = random) |
| `--no-overlay` | `OverlayWindow.ts` L36 | no BrowserWindow; `loadAppPage` opens the URL in the system browser instead |
| `--no-updates` | `AppUpdater.ts` L204 | disable auto-download |
| `VITE_DEV_SERVER_URL` (build-time define) | many | dev: port fixed `8584`, no static serving, config never saved, overlay loads `http://localhost:5173` |
| `PORTABLE_EXECUTABLE_DIR` | `AppUpdater.ts` L200 | Windows portable |
| `process.env.STATIC` (build-time) | tray/overlay icon dir | |

Dev wiring (renderer `vite.config.mts`): Vite on 5173 proxies
`^/(config|uploads|proxy)` → `http://127.0.0.1:8584` and `/events` (ws) →
`http://127.0.0.1:8584`. Keep the same split for OmaExiled dev (backend on a
fixed port, Vite proxying to it).

---

## 3. HTTP server — `main/src/server.ts`

Plain Node `http.createServer()` (L14) with several independent `request`
listeners (each returns early if the URL is not theirs). Listen host
`127.0.0.1`, port `0` (random) in prod / `8584` in dev, overridable with
`--listen` (L131-148). Returns the bound port.

### 3.1 Routes

| Route | Method | Handler | Response |
|---|---|---|---|
| `/config` (exact match `req.url === "/config"`) | any | `server.ts` L119-129 | `content-type: application/json`, body `HostState` = `{ version: app.getVersion(), updater: appUpdater.info, contents: await configStore.load() }`; `contents` is the **raw config.json text or `null`** (not parsed) |
| `/proxy/<host>/<path…>` | any | `proxy.ts` (§5) | upstream response |
| `/uploads/<name>` | GET / POST | `file-uploads.ts` | drop |
| `/events` | WebSocket upgrade only | L81-88 | any other upgrade URL → `req.destroy()` |
| everything else | any | static (L20-47), **only when not dev** | file from the app dir |

Static serving details (L20-47):

- Skips URLs starting with `/config`, `/uploads`, `/proxy`.
- `"/"` → `"/index.html"`; otherwise the raw `req.url` (query string included).
- `content-type` set **only** for `.html` `text/html`, `.js` `text/javascript`,
  `.json` `application/json`, `.svg` `image/svg+xml` (decided by
  `path.extname(req.url)`, so `?query` defeats it). Nothing for css, png,
  webp, woff2, ndjson…
- `fs.createReadStream(path.join(__dirname, filePath)).pipe(res)`: no 404 (a
  missing file emits an unhandled stream error → logged by the
  `uncaughtException` handler, request hangs/aborts), no traversal guard, no
  caching headers.
- The renderer fetches its data with relative URLs:
  `data/<lang>/items.ndjson`, `data/<lang>/stats.ndjson`,
  `data/item-drop.json`, `data/patrons.json`, `data/<lang>/app_i18n.json`
  (renderer `src/assets/data/index.ts` L159-292, `src/web/i18n.ts`).
  Content-type does not matter for these (`fetch().text()/json()`).

Port recommendation: `Bun.serve` with `Bun.file()` (correct MIME), strip the
query string, normalize and confine to the renderer `dist/` dir, real 404s.

### 3.2 WebSocket `/events` protocol

Framing: one **text frame per event**, body = `JSON.stringify({ name, payload })`
(`ipc/types.ts` `interface Event<TName, TPayload>` L345-348). Events with a
`void` payload are sent as `{"name":"…"}` (the `payload` key disappears
because it is `undefined`). No request/response, no ids, no acks, no
heartbeat. The renderer uses `Sockette` (auto-reconnect) at
`ws://${window.location.host}/events` (renderer `src/web/background/IPC.ts`
L24-31) and dispatches every message onto a local `EventTarget` by `name`.

Server side (L90-117):

- On connection: `lastActiveClient = socket`; then immediately send
  `MAIN->CLIENT::log-entry { message: logger.history }` (the **whole** log
  history as one message) to that socket.
- On message: `JSON.parse(bytes.toString("utf-8"))` (unguarded — malformed
  JSON throws into `uncaughtException`). If `name === "CLIENT->MAIN::used-recently"`
  → `lastActiveClient = socket`. Then `evBus.emit(event.name, event.payload)`
  (Node `EventEmitter`; every listener registered via `onEventAnyClient`
  receives every client's events; the sender identity is **not** passed to
  listeners).
- On close: if exactly **one** client remains, `lastActiveClient = that client`
  and emit `CLIENT->MAIN::used-recently { isOverlay: true }` on the bus (assumes
  the survivor is the overlay). If 0 or ≥2 remain, `lastActiveClient` keeps
  pointing at the closed socket (sends are silently lost).

`sendEventTo(target, event)` (L58-70):

- `"broadcast"` → send to every connected client.
- `"last-active"` **and** `"any"` → send only to `lastActiveClient`. If no
  client ever connected, `lastActiveClient` is `undefined` → TypeError.

Which client is "last active": the newest connection, or the last one that
sent `used-recently`. The renderer sends `used-recently { isOverlay: Host.isElectron }`
on `window` `focus` and once on mount (renderer `src/web/overlay/OverlayWindow.vue`
L119-124, L170-178). `isElectron` = `navigator.userAgent.includes("Electron")`
(IPC.ts L88-90).

**Port consequences (important):**

1. Only `MAIN->CLIENT::item-text` (and the dropped `ocr-text`) use
   `last-active`. With an overlay page **and** a settings page both connected,
   opening/focusing the settings window makes it "last active" and the next
   price check would go to the settings page. The original Linux report also
   hit this with a diagnostic WS tap ("item events delivered to the diagnostic
   client"). Recommendation: keep the wire format, but route `item-text` to the
   overlay page(s) by role (e.g. page connects with `/events?role=overlay`, or
   sends a hello), falling back to last-active only for browser clients.
2. The renderer **drops every `MAIN->OVERLAY::*` event when `isElectron` is
   false** (IPC.ts L51-53) and runs in "browser mode" (`active` always true,
   `poePanelWidth` 0, no `track-area`). QtWebEngine's UA does not contain
   "Electron", so the renderer port must change `isElectron` (UA marker set by
   the host's `QWebEngineProfile::setHttpUserAgent`, or a URL flag).
3. Guard `JSON.parse`, guard "no client yet", and drop the stale
   `lastActiveClient` on close.
4. Security (not in EE2): anything local can connect to `127.0.0.1:<port>`,
   and any web page can open `ws://127.0.0.1:<port>/events` or POST to
   `/proxy/…` (WebSocket has no CORS; simple POSTs are not preflighted). With
   a fixed, discoverable port this matters more. Check `Origin`/`Host` on the
   upgrade and on `/proxy/*` (allow only `http://localhost:<port>`,
   `http://127.0.0.1:<port>`, and the dev Vite origin).

### 3.3 Complete IPC event catalog (`ipc/types.ts`)

Inbound (renderer → backend):

| Event | Payload | EE2 handler(s) | OmaExiled |
|---|---|---|---|
| `CLIENT->MAIN::update-host-config` | `HostConfig` (§7) | `main.ts` L104-126 | **keep** (drives binds, delay, restore, game ini path, overlay key) |
| `CLIENT->MAIN::save-config` | `{ contents: string; isTemporary: boolean }` | `ConfigStore` L15-21 | **keep** |
| `CLIENT->MAIN::used-recently` | `{ isOverlay: boolean }` | `server.ts` L101-103 (last-active), `OverlayWindow.ts` L32-34 (`wasUsedRecently = isOverlay`) | **keep** |
| `CLIENT->MAIN::user-action` | `{ action: "check-for-update" \| "update-and-restart" \| "quit" }` or `{ action: "stash-search"; text: string }` | `AppTray` L29-33 (quit → `app.quit()`), `AppUpdater` L19-25, `Shortcuts` L73-77 (stash-search) | keep `quit`, `stash-search`; ignore updater actions |
| `OVERLAY->MAIN::focus-game` | none | `OverlayWindow.assertGameActive` (L25-28) | **keep** (= close/blur the panel) |
| `OVERLAY->MAIN::render-state` | `{ shouldShow: boolean }` | `OverlayWindow` L38-41 (only used with `hideOverlayOnBlur`) | **keep** — natural "map/unmap the layer surface" signal |
| `OVERLAY->MAIN::track-area` | `{ holdKey: string; closeThreshold: number; from: {x,y}; area: {x,y,width,height}; dpr: number }` | `WidgetAreaTracker` L15-63 | keep (semantics in §8.4) |
| `CLIENT->MAIN::write-data` | log-item / session / client-log-event | `FileWriter` | drop (ignore silently) |
| `CLIENT->MAIN::re-parse-log` | none | `GameLogWatcher` | drop |

Outbound (backend → renderer):

| Event | Payload | Target | Sent by | OmaExiled |
|---|---|---|---|---|
| `MAIN->CLIENT::log-entry` | `{ message: string }` | broadcast; full history to each new connection | `RemoteLogger`, `server.ts` L113-116 | **keep** |
| `MAIN->CLIENT::config-changed` | `{ contents: string }` | broadcast (incl. the sender) after every save | `ConfigStore` L17-20 | **keep** |
| `MAIN->CLIENT::item-text` | `{ target: string; clipboard: string; item?: unknown; position: {x,y}; focusOverlay: boolean }` | **last-active** | `Shortcuts` L224-232 | **keep** (route to overlay page) |
| `MAIN->CLIENT::widget-action` | `{ target: string }` | broadcast | `trigger-event` hotkeys (delve grid, stopwatch) | keep generic, unused by kept features |
| `MAIN->CLIENT::updater-state` | `UpdateInfo` | broadcast | `AppUpdater` | stub (never sent, or `{state:"initial"}`) |
| `MAIN->CLIENT::game-log` | `{ lines: string[] }` | broadcast | `GameLogWatcher` | drop |
| `MAIN->CLIENT::ocr-text` | `{ target; pressTime; ocrTime; paragraphs }` | last-active | heist OCR | drop |
| `MAIN->OVERLAY::focus-change` | `{ game: boolean; overlay: boolean; usingHotkey: boolean }` | broadcast | `OverlayWindow` L196-203 | **keep** |
| `MAIN->OVERLAY::visibility` | `{ isVisible: boolean }` | broadcast | `OverlayVisibility` | keep if Alt-hold hiding is ported |
| `MAIN->OVERLAY::overlay-attached` | none | broadcast | `OverlayWindow` L184-187 (game window found) | **keep** (renderer shows "attached" notification if `showAttachNotification`) |
| `MAIN->OVERLAY::hide-exclusive-widget` | none | broadcast | `WidgetAreaTracker` L76-79 | **keep** (closes the price panel) |

How the renderer uses them (for semantics):

- `item-text` with `target === "price-check"`: `PriceCheckWindow.vue` L261-298 —
  if `isElectron && !focusOverlay` it sends `track-area`; then `wm.show(...)`,
  `checkPosition = e.position`, `advancedCheck = e.focusOverlay`, parses
  `e.clipboard` (or uses `e.item` if present). `advancedCheck` selects which
  initial-search setting applies (`smartInitialSearch` for hold mode,
  `lockedInitialSearch` for locked mode; `CheckedItem.vue` L182-183) — so
  `focusOverlay` must stay faithful even though the port never moves keyboard
  focus.
- `target === "item-check"`: `WidgetItemCheck.vue` L82-89 (shows if parse ok).
- `target ∈ {open-wiki, open-craft-of-exile, open-poedb, search-similar, search-same-priced}`:
  `item-check/hotkeyable-actions.ts` L85-112. `open-*` → `window.open(url)`
  (host must route new-window requests to `xdg-open`, EE2 does
  `setWindowOpenHandler → shell.openExternal, deny` in `OverlayWindow.ts`
  L71-74). `search-similar` / `search-same-priced` → renderer computes a search
  string and sends `CLIENT->MAIN::user-action { action: "stash-search", text }`
  back (round trip: hotkey → copy → renderer parse → backend types it).
  `text` = `JSON.stringify(item.info.name)` (quoted name), or note(+name) if
  combined length < 51 (PoE search box limit 50).
- `focus-change`: `OverlayWindow.vue` L133-150 — `active = overlay`,
  `gameFocused = game`; when `active` becomes false every widget with flag
  `hide-on-blur` is hidden (the price check has it), when true every
  `hide-on-focus` widget is hidden. `usingHotkey` is currently unused by the
  renderer.
- `hide-exclusive-widget`: `PriceCheckWindow.vue` L342-344 → `wm.hide()`.
- `render-state` is emitted by `OverlayWindow.vue` L275-294:
  `shouldShow = !isElectron || active || showEditingNotification || logKeys || anyWidgetVisible`.
- `config-changed`: replaces the whole renderer config and, in the overlay, hides
  the settings widget if it is topmost (`OverlayWindow.vue` L126-131).

---

## 4. Logger — `main/src/RemoteLogger.ts`

`write(message)` (L9-15): `message = \`[${new Date().toLocaleTimeString()}] ${message}\n\``;
appended to `history` (unbounded string); broadcast as
`MAIN->CLIENT::log-entry { message }`. New WS connections receive the full
`history` once. The renderer concatenates entries into `Host.logs` and shows
them in Settings → debug.

Message convention used everywhere: `"<level> [<Component>] <text>"`, levels
`info | warn | error | debug`. Exact strings worth keeping (users and the
original reports grep for them):

- `error [Shortcuts] Hotkey "<s>" reserved by the game will not be registered.`
- `error [Shortcuts] It is not possible to use the same hotkey "<s>" for multiple actions.`
- `error [Shortcuts] Failed to register a shortcut "<s>". It is already registered by another application.`
- `debug [Shortcuts] Keydown <combo>` / `debug [Shortcuts] Keyup <key>` / `debug [Shortcuts] Action type: <type>` (only when `logKeys`)
- `warn [ClipboardPoller] No item text found.`
- `error [GameConfig] Failed to find game configuration file in the default location.` / `Failed to read game configuration file.` / `Failed to read key: <cfg>.` / `Failed to read modifier key: <cfg>.`
- `error [proxy] <message> (<host>)`
- `error [Overlay] PoE2 is running with administrator rights` (Windows)
- `info [ClipboardWatch] item copied (<source>) -> price-check` (omarchy branch)

Port: cap history (e.g. last 2000 lines), also write to stderr/journal.

---

## 5. Proxy — `main/src/proxy.ts`

### 5.1 Allowed hosts (L5-19), exact list

| host | official |
|---|---|
| `www.pathofexile.com` | true |
| `ru.pathofexile.com` | true |
| `pathofexile.tw` | true |
| `poe.kakaogames.com` | true |
| `jp.pathofexile.com` | true |
| `de.pathofexile.com` | true |
| `es.pathofexile.com` | true |
| `br.pathofexile.com` | true |
| `fr.pathofexile.com` | true |
| `poe.ninja` | false |
| `www.poeprices.info` | false |
| `api.exiledexchange2.dev` | false (EE2 author's data mirror of poe.ninja) |

`official` is only used as an "is it in the list" check (`undefined` → reject);
nothing else differs between official and non-official hosts.

### 5.2 Request handling (L24-76)

1. Match `req.url.startsWith("/proxy/")`; `host = req.url.split("/", 3)[2]`
   (the path segment right after `/proxy/`).
2. Unknown host → `req.destroy()` (connection reset; the renderer's `fetch`
   rejects with a network error — no HTTP status).
3. Delete request headers: every key starting with `sec-`, and `host`,
   `origin`, `content-length` (L33-43). Everything else from the renderer is
   forwarded as-is — including `referer` (`http://localhost:<port>/index.html`),
   `cookie` (localhost cookies; none in practice), `accept`, `accept-language`,
   `accept-encoding`, `content-type` (incl. multipart boundary for poeprices
   feedback), `user-agent` (but see 4).
4. Upstream request via Electron `net.request` (Chromium network stack):
   - `url: "https://" + req.url.slice("/proxy/".length)` (always HTTPS; query
     string preserved verbatim)
   - `method: req.method`
   - `headers: { ...req.headers, "user-agent": app.userAgentFallback }`
     — Electron's default UA, i.e. a Chrome UA with the app token, roughly
     `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) exiled-exchange-2/0.16.3 Chrome/<ver> Electron/40.x Safari/537.36`
   - `useSessionCookies: true` — attaches cookies from Electron's **default
     session cookie jar** and stores `Set-Cookie` from responses into it
     (persisted in `~/.config/exiled-exchange-2/Cookies`). That jar is shared
     with the `<webview>` "builtin browser" (price-check setting
     `builtinBrowser`, `PriceCheckWindow.vue` L103-108), so **POESESSID comes
     from the user logging into pathofexile.com inside the builtin browser**;
     there is no POESESSID config field anywhere. Cloudflare cookies
     (`__cf_bm`, `cf_clearance`) also live there.
   - `referrerPolicy: "no-referrer-when-downgrade"`
   - redirects: `net.request` default `redirect: "follow"`.
   - Request body: `req.pipe(proxyReq)` (streamed; `content-length` was
     stripped so it goes chunked).
5. Response (L55-69): `resHeaders = { ...proxyRes.headers }`, delete
   `content-encoding` (Chromium already decoded the body), then
   `res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, resHeaders)`
   and pipe the body. **Status codes (429, 400, 404, 5xx) and all other
   headers pass through unchanged**, including `x-rate-limit-rules`,
   `x-rate-limit-<rule>`, `x-rate-limit-<rule>-state`, `retry-after`,
   `set-cookie`, `content-type`. Exception during writeHead → log
   `error [proxy] <msg> (<host>)` and `res.destroy()`.
6. Upstream error event (L70-73) → log `error [proxy] <msg> (<host>)` and
   `res.destroy(err)` (renderer fetch rejects).
7. Cookie fix (L77-90): `session.defaultSession.webRequest.onHeadersReceived`
   removes the `Partitioned` attribute from every `set-cookie` (Cloudflare sets
   partitioned cookies; `net.request` can't supply a partition key, so they'd
   never be sent back).

No caching, no retries, no queuing, no rate limiting in main — **all rate
limiting is client-side** in the renderer (`price-check/trade/common.ts`
`adjustRateLimits` reads `x-rate-limit-rules` and
`x-rate-limit-${rule}` / `x-rate-limit-${rule}-state`, `RATE_LIMIT_RULES`
SEARCH/EXCHANGE/FETCH start at 1 req / 5 s; `apiLatencySeconds` (default 2)
is added to each window). Same-origin through the proxy is what makes these
headers readable from JS; adding latency in the proxy eats into
`apiLatencySeconds`.

### 5.3 Renderer call sites (what must work)

`Host.proxy(url, init)` = `fetch("/proxy/" + url, init)` (IPC.ts L84-86).

| Caller | URL | Method / headers |
|---|---|---|
| `background/Leagues.ts` L52 | `${poeWebApi()}/api/trade2/data/leagues` | GET; checks `response.ok`, else throws with all headers |
| `background/TradeData.ts` L52, L102 | `www.pathofexile.com/api/trade2/data/stats`, `…/data/items` | GET (AbortController signal) |
| `background/Prices.ts` L173, L192, L199 | `api.exiledexchange2.dev/proxy/data/item-drop.json`, `…/proxy/data/namespaceMap.json`, `…/proxy/<league>/overviewData.json` | GET |
| `price-check/trade/pathofexile-trade.ts` L1271 | `${getTradeEndpoint()}/api/trade2/search/${leagueId}` | POST, `Accept: application/json`, `Content-Type: application/json`, JSON body |
| `price-check/trade/pathofexile-trade.ts` L1315 | `${getTradeEndpoint()}/api/trade2/fetch/${ids.join(",")}?query=${queryId}` | GET |
| `price-check/trade/pathofexile-bulk.ts` L78 | `${getTradeEndpoint()}/api/trade2/exchange/${leagueId}` | POST, same headers |
| `price-check/price-prediction/poeprices.ts` L42 | `www.poeprices.info/api?i=…&l=…&s=awakened-poe-trade` | GET |
| `price-check/price-prediction/poeprices.ts` L118 | `www.poeprices.info/send_feedback` | POST `FormData` (multipart) |

`poeWebApi()` (`web/Config.ts` L90-117): `www.pathofexile.com` unless
`preferredTradeSite === "default"` and language maps to a localized host
(`ru`, `cmn-Hant`+`pc-garena` → `pathofexile.tw`, `ko` → `poe.kakaogames.com`,
`ja` → `jp.`, `de` → `de.`, `es` → `es.`, `pt` → `br.`, `fr` → `fr.`).

Error bodies: GGG returns `{ "error": { "code", "message" } }` JSON; the trade
code throws `new Error(_data.error.message)` — so pass bodies through
untouched.

### 5.4 Bun implementation notes

- Path parse identical: `host = url.pathname.split("/")[2]`; upstream =
  `"https://" + rawUrl.slice("/proxy/".length)` (use the raw request target so
  the query string is byte-identical).
- Drop request headers: `sec-*`, `host`, `origin`, `content-length` (EE2), and
  additionally `connection`, `accept-encoding` (let Bun negotiate what it can
  decode), `referer` (leaks localhost; EE2 forwards it — harmless to drop),
  `cookie` (replace with the jar's cookies).
- `user-agent`: set a **Chrome-like UA** (EE2 effectively sends one). Bun's
  default `Bun/1.x` UA is very likely to be challenged by Cloudflare.
- **Cloudflare / TLS fingerprint risk:** EE2 talks to pathofexile.com through
  Chromium's network stack (Chrome TLS/HTTP2 fingerprint + Chromium cookie
  jar). Bun's `fetch` has a different fingerprint. If Cloudflare starts serving
  403 `cf-mitigated: challenge` to the backend, fallbacks are: (a) let the
  renderer page fetch trade endpoints directly from QtWebEngine (same
  Chromium stack) with web security disabled for that profile
  (`QTWEBENGINE_CHROMIUM_FLAGS=--disable-web-security` or a request
  interceptor adding CORS headers), or (b) route proxy requests through the
  Qt host. Test early with a real search+fetch+exchange.
- Cookie jar: small persistent per-domain jar (JSON in the config dir) that
  stores `Set-Cookie` from official hosts with the `Partitioned` attribute
  stripped, and sends matching cookies back. Optional `POESESSID` setting
  (official hosts only) replaces the builtin-browser login if wanted.
- Response: copy status + statusText; drop `content-encoding`,
  `content-length` (Bun's fetch decompresses), `transfer-encoding`,
  `connection`, `set-cookie` (consumed by the jar); keep all `x-rate-limit-*`,
  `retry-after`, `content-type`. Stream the body.
- Redirects: follow (EE2 default).
- Errors: EE2 resets the connection (`fetch` rejects). Either close the socket
  or answer `502` with `{"error":{"code":0,"message":"[proxy] <msg>"}}`; both
  surface as an error in the renderer. Log `error [proxy] <msg> (<host>)`.
- Unknown host: EE2 resets; `403` is fine for the port (renderer only sees
  allowed hosts anyway).

---

## 6. Config persistence

### 6.1 `ConfigStore` — `main/src/host-files/ConfigStore.ts`

- Path: `app.getPath("userData")/apt-data/config.json` (L8-12). On this
  machine: `~/.config/exiled-exchange-2/apt-data/config.json` (exists,
  `configVersion: 34`, 4.6 KB).
- `load()` (L24-30): read UTF-8 text; any error → `null`. Main never parses it.
- On `CLIENT->MAIN::save-config { contents, isTemporary }` (L15-21): call
  `save()` (not awaited) **and immediately broadcast**
  `MAIN->CLIENT::config-changed { contents }` to every client, the sender
  included.
- `save(contents, tmp)` (L32-45):
  - dev (`VITE_DEV_SERVER_URL`) → never writes.
  - `tmp && !isTmpFile` → `cfgPath += ".tmp"` **for the rest of the process
    lifetime** (all later saves *and* `/config` loads use `config.json.tmp`).
    The renderer sends `isTemporary: true` only when `config.json` failed to
    `JSON.parse` (it then runs on defaults without overwriting the user's
    file — `web/Config.ts` L59-89).
  - `mkdir -p` the dir, `writeFile` (non-atomic). Any failure →
    **`app.exit(1)`**.
- Renderer side (`web/Config.ts`): `saveConfig()` (L30-50) skips saving while
  an exclusive widget is shown, deep-compares with the last saved copy, then
  sends `JSON.stringify(AppConfig())`. `initConfig()` (L59-89) gets `/config`,
  falls back to `defaultConfig()` on `null`, runs `upgradeConfig()`.

### 6.2 Versioning

Config versioning is **entirely renderer-side**: `configVersion` field,
current `35` (`defaultConfig` L159-233, `upgradeConfig` L235-689, last step
L676-685 sets `priceCheck.savedAugments = {}` and `hideOverlayOnBlur = false`).
The backend treats the config as an opaque string. Note for the renderer trim:
several migration steps `find()` widgets that OmaExiled drops (e.g. `library`
at v33) and dereference the result — they must be made null-safe or importing
an EE2 v≤34 config will throw.

### 6.3 Port

- New path: `${XDG_CONFIG_HOME:-~/.config}/omaexiled/config.json`. On first run,
  if it does not exist and `~/.config/exiled-exchange-2/apt-data/config.json`
  does, offer/perform an import (copy the text; the renderer migrates it).
- Write atomically (write `config.json.writing` + `rename`), keep the
  `isTemporary` → `.tmp` redirect semantics exactly, and do not exit on a
  failed write (log `error [ConfigStore] …` instead).
- Keep `/config` → `HostState { version, updater, contents }`. `version` = the
  OmaExiled version string (renderer shows it in About); `updater` =
  `{ state: "initial" }` (renderer type `UpdateInfo`, `ipc/types.ts` L52-68).

---

## 7. `HostConfig` → backend consumers

`HostConfig` (`ipc/types.ts` L1-16) is built by the renderer in
`getConfigForHost()` (`web/Config.ts` L692-843) and sent on mount and on every
relevant settings change (`pushHostConfig`, L52-57).

| Field | EE2 consumer | OmaExiled |
|---|---|---|
| `shortcuts: ShortcutAction[]` | `Shortcuts.updateActions` | → Hyprland binds |
| `restoreClipboard: boolean` (default `false`) | `HostClipboard.shouldRestore` | keep |
| `clientLog: string \| null` | `GameLogWatcher` | ignore |
| `gameConfig: string \| null` (path to `poe2_production_Config.ini`, `null`/"" = auto) | `GameConfig.readConfig` | keep |
| `stashScroll: boolean` (default `true`) | Ctrl+wheel → arrows | optional |
| `overlayKey: string` (default `"Shift + Space"`) | overlay toggle handled *inside* the overlay page, tray text | keep |
| `logKeys: boolean` | debug logging | keep (log ctl actions) |
| `windowTitle: string` (default `"Path of Exile 2"`) | exact X11 title match for the game window | keep (match Hyprland client `title`; also accept class `steam_app_2694490`) |
| `language: string` | OCR language | ignore |
| `readClientLog: boolean` | `GameLogWatcher` | ignore |
| `libraryAlpha`, `libraryOutputPath` | `FileWriter` | ignore |
| `initialDelay: number` (price-check widget, default `48`) | `HostClipboard` first poll delay (ms) | keep |
| `hideOverlayOnBlur: boolean` (default `false`) | `OverlayWindow.syncWindowVisibility` | the layer surface is unmapped when nothing is visible anyway |

`shortcuts` as generated by `getConfigForHost()` (only entries with a hotkey):

| Source setting | `shortcut` | `action` | `keepModKeys` |
|---|---|---|---|
| price-check `hotkey` (default `"D"`) with `hotkeyHold` (default `"Ctrl"`) | `` `${hotkeyHold} + ${hotkey}` `` → `"Ctrl + D"` (plain string concat, not normalized) | `{ type: "copy-item", target: "price-check", focusOverlay: false }` | `true` |
| price-check `hotkeyLocked` (default `"Ctrl + Alt + D"`) | as is | `{ type: "copy-item", target: "price-check", focusOverlay: true }` | — |
| `overlayKey` | `"Shift + Space"` | `{ type: "toggle-overlay" }` | — |
| item-check `wikiKey`, `craftOfExileKey`, `poedbKey`, `stashSearchKey`, `samePricedKey` (defaults `null`) | as set | `copy-item` targets `open-wiki`, `open-craft-of-exile`, `open-poedb`, `search-similar`, `search-same-priced` (no `focusOverlay`) | — |
| item-check `hotkey` (default `null`; DESIGN.md wants `Alt + D`) | as set | `{ type: "copy-item", target: "item-check", focusOverlay: true }` | — |
| library `logItemKey` | | `copy-item` `log-item` | `true` (drop) |
| delve-grid `toggleKey` | | `trigger-event` `delve-grid` | `true` (drop) |
| each `config.commands[]` with `hotkey` | `command.hotkey` | `{ type: "paste-in-chat", text, send }` | — |
| each stash-search widget with `enableHotkeys`, each entry with `hotkey` | `entry.hotkey` | `{ type: "stash-search", text: entry.text }` | — |
| stopwatch toggle/reset | | `trigger-event` `stopwatch-start-stop:<wmId>` / `stopwatch-reset:<wmId>` | `true` (drop) |
| item-search `ocrGemsKey` | | `ocr-text` `heist-gems` | `true` (drop) |

Default `commands` (`web/Config.ts` L168-199): `/hideout` F5 send,
`/exit` F9 send, `@last ty` (no hotkey) send, `/invite @last`,
`/tradewith @last`, `/hideout @last` (no hotkeys, send). The user's current
EE2 config has the same values; all item-check and stash-search hotkeys are
`null`; `restoreClipboard: false`, `stashScroll: false`.

---

## 8. Shortcuts, clipboard and typing

### 8.1 Hotkey string format (`ipc/KeyToCode.ts`)

- Format: keys joined by `" + "` (space-plus-space). Modifiers are exactly
  `Ctrl`, `Shift`, `Alt` (`isModKey`, L254-260). There is no Super/Meta.
- Canonical modifier prefix produced by `hotkeyToString` (L227-245):
  `Ctrl + Shift + Alt`, `Shift + Alt`, `Ctrl + Shift`, `Ctrl + Alt`, `Alt`,
  `Ctrl`, `Shift`; then the non-mod key(s). A modifier-only hotkey yields just
  the modifier string.
- `mergeTwoHotkeys(a, b)` (L247-252) = union of keys, re-canonicalized:
  `mergeTwoHotkeys("Ctrl + C", "Alt")` → `"Ctrl + Alt + C"`.
- Key names = keys of `KeyToCode` (L1-109): `Backspace Tab Enter Shift Ctrl Alt
  CapsLock Escape Space PageUp PageDown End Home ArrowLeft ArrowUp ArrowRight
  ArrowDown Insert Delete 0-9 A-Z Numpad0-9 NumpadMultiply NumpadAdd
  NumpadSubtract NumpadDecimal NumpadDivide F1-F24 Semicolon Equal Comma Minus
  Period Slash Backquote BracketLeft Backslash BracketRight Quote`. Values are
  **Windows virtual-key codes** (used to decode the PoE ini).
- `KeyToElectron` (L115-225) maps to Electron accelerators; port needs the
  equivalent map to Hyprland/xkb keysyms instead:

| EE2 | xkb keysym for Hyprland | EE2 | xkb keysym |
|---|---|---|---|
| `Ctrl`/`Shift`/`Alt` (as modifier) | `CTRL`/`SHIFT`/`ALT` | `Enter` | `Return` |
| `Backspace` | `BackSpace` | `Escape` | `Escape` |
| `Tab` | `Tab` | `Space` | `space` |
| `CapsLock` | `Caps_Lock` | `PageUp` / `PageDown` | `Prior` / `Next` |
| `End` / `Home` / `Insert` / `Delete` | same | `ArrowLeft/Up/Right/Down` | `Left/Up/Right/Down` |
| `0`-`9` | `0`-`9` | `A`-`Z` | `a`-`z` (Hyprland accepts either case) |
| `Numpad0`-`9` | `KP_0`-`KP_9` (NumLock on; use `code:` to be safe) | `NumpadMultiply/Add/Subtract/Decimal/Divide` | `KP_Multiply/KP_Add/KP_Subtract/KP_Decimal/KP_Divide` |
| `F1`-`F24` | `F1`-`F24` | `Semicolon` `Equal` `Comma` `Minus` `Period` `Slash` | `semicolon` `equal` `comma` `minus` `period` `slash` |
| `Backquote` | `grave` | `BracketLeft` `Backslash` `BracketRight` `Quote` | `bracketleft` `backslash` `bracketright` `apostrophe` |

  Shifted symbols/digits change keysym (Shift+1 = `exclam`), so binds with
  Shift + digit/punctuation should use `code:<xkb keycode>` (evdev + 8).
  Keyboard here: layout `us`, option `caps:escape` (CapsLock produces Escape).

### 8.2 Validation rules — `Shortcuts.updateActions` (L110-176)

Input `actions` = `cfg.shortcuts` (mutated in place).

1. `copyItemShortcut = mergeTwoHotkeys("Ctrl + C", gameConfig.showModsKey)`
   (default `"Ctrl + Alt + C"`). If it differs from `"Ctrl + C"`, push
   `{ shortcut: copyItemShortcut, action: { type: "test-only" } }` (L122-131).
2. Reserved set `allShortcuts` (L133-146): `"Ctrl + C"`, `"Ctrl + V"`,
   `"Ctrl + A"`, `"Ctrl + F"`, `"Ctrl + Enter"`, `"Home"`, `"Delete"`,
   `"Enter"`, `"ArrowUp"`, `"ArrowRight"`, `"ArrowLeft"`, `copyItemShortcut`.
   These are exactly the keys the app itself injects; binding them would make
   the app trigger itself (and steal them from the game).
3. For each action whose shortcut is reserved and type ≠ `test-only` → log
   `error [Shortcuts] Hotkey "<s>" reserved by the game will not be registered.`
4. Remove every action whose shortcut is reserved — **including the
   `test-only` one**, so the test-only registration in `register()` is dead
   code in master.
5. Duplicates: first occurrence adds its shortcut to the set; any later
   occurrence logs `error [Shortcuts] It is not possible to use the same hotkey "<s>" for multiple actions.`
   and marks the shortcut. Final list removes **all** actions on a duplicated
   shortcut **except** `toggle-overlay` ones (so a clash disables both other
   actions, while the overlay key always survives).
6. Comparisons are plain string equality, so a non-canonical string (e.g.
   price-check `hotkeyHold "Alt"` + `hotkey "Shift + D"` → `"Alt + Shift + D"`)
   escapes both checks.

Port: same rules, same log strings. Additionally detect clashes with the
user's existing Hyprland binds (`hyprctl -j binds`, compare modmask + key)
and log a warning (this replaces the "already registered by another
application" failure). Current clashes: `CTRL+ALT+D`, `F9` (§1).

### 8.3 Registration lifetime — only while the game is focused

`GameWindow` emits `active-change(isActive)`; `Shortcuts` (L61-71) on
`process.nextTick` re-checks `isActive === poeWindow.isActive` (debounce) and
then `register()` (all actions via `globalShortcut.register`) or
`unregister()` (`globalShortcut.unregisterAll()`).

`poeWindow.isActive` is set by: X11 focus/blur of the game
(`GameWindow.attach` L33-46), **and by the overlay itself**:
`assertOverlayActive()` sets it `false` (→ all hotkeys unregistered while the
overlay has focus), `assertGameActive()` sets it `true` (→ re-registered).
While the overlay is focused, only the overlay page's own key handling works
(§9.2: Escape, Ctrl+W, overlayKey).

Port: Hyprland socket2 `activewindow>>CLASS,TITLE` (and `activewindowv2>>ADDR`).
Game active ⇔ active window title == `windowTitle` (EE2 semantics: exact
title) or class == `steam_app_2694490`. Install binds on activation, remove on
deactivation. Hyprland 0.56 here uses Lua config (`hyprctl -j binds` shows
dispatcher `__lua`); dynamic binds should be added/removed via
`hyprctl eval '<lua>'` (or `hyprctl keyword bind …` if still honoured — verify),
or by toggling a submap. Layer surfaces are not windows, so mapping the
overlay should not change `activewindow`; verify that giving the layer surface
keyboard focus (`on_demand`) does not emit an `activewindow>>,` that would
tear the binds down mid-interaction.

### 8.4 What happens when a hotkey fires — `register()` callback (L178-286)

Step 0 — synthetic key release (L189-201). The user is still physically
holding the hotkey when the callback runs; EE2 sends key-up events so the
keys it is about to inject are not combined with held keys:

- `keepModKeys` → release **only the non-modifier key** (e.g. `D` of
  `Ctrl + D`); modifiers stay down (hold mode).
- otherwise → release **all keys of the shortcut in reverse order**
  (`Ctrl + Alt + D` → `D` up, `Alt` up, `Ctrl` up).

With Hyprland binds the triggering key press is consumed by the compositor,
and `sendshortcut` sends its own explicit modifier state, so this step should
become unnecessary — **verify** that a physically held Ctrl (hold mode) does
not leak into keys sent by `sendshortcut` (e.g. `Return` arriving as
`Ctrl+Return`, which in PoE replies to the last whisper).

Then per `action.type`:

| type | EE2 behaviour |
|---|---|
| `toggle-overlay` | `areaTracker.removeListeners(); overlay.toggleActiveState()` (§9.1) |
| `paste-in-chat` | `typeInChat(text, send, clipboard)` (§8.7) |
| `trigger-event` | broadcast `MAIN->CLIENT::widget-action { target }` |
| `stash-search` | `stashSearch(text, clipboard, overlay)` (§8.8) |
| `copy-item` | §8.5 |
| `ocr-text` (`heist-gems`) | Windows only; drop |
| `test-only` | register then immediately unregister (dead, see §8.2) |

`logKeys` → `debug [Shortcuts] Action type: <type>` before running.

### 8.5 `copy-item` — exact flow (L215-244)

```
pressPosition = screen.getCursorScreenPoint()           // cursor at press time
clipboard.readItemText()                                 // arms the poll FIRST (sync part runs now)
  .then(text => {
     areaTracker.removeListeners()
     sendEventTo("last-active", MAIN->CLIENT::item-text {
        target: action.target, clipboard: text,
        position: pressPosition, focusOverlay: Boolean(action.focusOverlay) })
     if (action.focusOverlay && overlay.wasUsedRecently) overlay.assertOverlayActive()
  })
  .catch(() => {})                                       // timeout: silent except the log line
pressKeysToCopyItemText(keepModKeys ? modsOfShortcut : undefined, gameConfig.showModsKey)
```

`pressKeysToCopyItemText(pressedModKeys = [], showModsKey)` (L293-324):

- `keys = mergeTwoHotkeys("Ctrl + C", showModsKey).split(" + ")` minus `"C"`
  → default `["Ctrl", "Alt"]`. If the game's advanced-description key is
  unset/`Alt` → copy chord is **Ctrl+Alt+C** (advanced item text with mod
  tiers/ranges, which the parser expects). If the ini maps it to e.g. `Shift`
  → **Ctrl+Shift+C**. Plain **Ctrl+C** only if `showModsKey` were `Ctrl`.
- Non-mac: drop keys already physically held (`pressedModKeys`, only passed
  for `keepModKeys` actions): hold mode `Ctrl + D` → `keys = ["Alt"]`.
- key-down each of `keys`, tap `C`, then after **10 ms** key-up `keys` in
  reverse ("Game was dropping the release inputs").

Resulting injected sequences:

| Hotkey | Physically held | Injected |
|---|---|---|
| `Ctrl + D` (hold, keepModKeys) | Ctrl | D↑, Alt↓, C tap, (10 ms) Alt↑ → game sees Ctrl+Alt+C |
| `Ctrl + Alt + D` (locked) | Ctrl, Alt | D↑ Alt↑ Ctrl↑, Ctrl↓ Alt↓, C tap, (10 ms) Alt↑ Ctrl↑ |
| `Alt + D` (item check) | Alt | D↑ Alt↑, Ctrl↓ Alt↓, C tap, (10 ms) Alt↑ Ctrl↑ |

Port: `hyprctl dispatch sendshortcut "CTRL ALT, C, class:^(steam_app_2694490)$"`
(modifiers from `mergeTwoHotkeys("Ctrl + C", showModsKey)` minus `C`; Hyprland
mod names `CTRL SHIFT ALT`). Proven on this machine by the prototype
(`poe_price_checker/bin/poe-pricecheck.sh`:
`hyprctl dispatch sendshortcut "CTRL, C, class:^${cls}$"` with `cls` =
`hyprctl activewindow -j | .class`; "Live in-game copy → price → requery
confirmed working in Windowed mode", Hyprland 0.55.2). Ctrl+**Alt**+C via
sendshortcut is not yet proven — test it first. Use the socket
(`$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock`, request
`dispatch sendshortcut CTRL ALT, C, class:…`; `[[BATCH]]cmd1;cmd2` for
sequences) instead of spawning `hyprctl` per key.

Position: `hyprctl -j cursorpos` → `{ "x", "y" }` in global layout (logical)
coordinates. EE2's renderer compares `position.x` with `window.screenX` and
`window.innerWidth` of a game-sized page to pick the side ("stash" left /
"inventory" right) and anchor the panel next to the game's side panel
(`poePanelWidth = innerHeight * 986/1600`). With the DESIGN.md surface
(anchored to the game monitor), send `position` in page coordinates
(`cursor - monitor origin`, logical px) — or make `window.screenX/screenY`
consistent with global coordinates. If the game window is smaller than the
monitor, the surface should be margined to the game's `at`/`size` from
`hyprctl -j clients`, since the renderer assumes page == game client area.

`focusOverlay` + `wasUsedRecently` → `assertOverlayActive()`: in EE2 this moves
keyboard focus and mouse capture to the overlay for locked checks / item
check. In OmaExiled the game keeps the keyboard; still emit the same
`focus-change` the renderer expects if you want locked panels to behave as
"active" (overlay background, `hide-on-blur` semantics), or keep the overlay
"inactive" and let the price panel persist until `focus-game` /
`hide-exclusive-widget`. Decide once and document it in the host note; the
omarchy branches used `focusOverlay: true` without activation to keep a
read-only panel open.

### 8.6 `HostClipboard` — reading item text (`HostClipboard.ts`)

Constants (L4-11): `POLL_DELAY = 48` ms, `POLL_LIMIT = 500` ms,
`RESTORE_AFTER = 120` ms. `initialDelay` defaults to `POLL_DELAY` and is
overwritten by `HostConfig.initialDelay` (`updateDelay`, L105-107).

`readItemText()` (L31-83):

1. `this.elapsed = 0` (reset on every call, even when a poll is in flight —
   concurrent presses extend the window). If a poll is already running,
   **return the same promise** (both callers then send `item-text`, i.e. a
   double press yields two identical events, and the copy chord is injected
   twice).
2. `textBefore = clipboard.readText()`.
   - If `textBefore` is a PoE item → `textBefore = ""` and clear the
     clipboard: non-Linux `writeText("")`; Linux
     `writeText(\`__EE2_FORCE_EMPTY_${Date.now()}\`)` (KDE "Prevent empty
     clipboard" workaround, awakened-poe-trade#1790).
   - Else on Linux **also** `writeText(\`__EE2_FORCE_EMPTY_${Date.now()}\`)`
     (Proton 10+ workaround, awakened-poe-trade#1846: make sure the next game
     copy is a visible change).
3. Poll: first after `initialDelay`, then every 48 ms. Each poll reads the
   clipboard; if `isPoeItem(text)` → (if `restoreClipboard`)
   `writeText(textBefore)` → resolve(text). Else `elapsed += 48`; while
   `elapsed < 500` poll again; otherwise (if `restoreClipboard`)
   `writeText(textBefore)`, log `warn [ClipboardPoller] No item text found.`,
   reject `"Reading clipboard timed out"`. ⇒ ≈ `initialDelay + 11 × 48 ms`
   ≈ 0.58 s total with defaults.
4. Side effect on Linux with `restoreClipboard: false` (the default) and a
   timeout: the clipboard is left containing the sentinel
   `__EE2_FORCE_EMPTY_<ts>`. On success it contains the item text.

`isPoeItem(text)` (L110-115): `text.startsWith(firstLine) || text.startsWith(uncutSkillGemLine)`
for any language in `LANGUAGE_DETECTOR` (L117-173):

| lang | firstLine | uncutSkillGemLine |
|---|---|---|
| en | `Item Class: ` | `Rarity: ` |
| ru | `Класс предмета: ` | `Редкость: ` |
| fr | `Classe d'objet: ` | `Rareté: ` |
| de | `Gegenstandsklasse: ` | `Seltenheit: ` |
| pt | `Classe do Item: ` | `Raridade: ` |
| es | `Clase de objeto: ` | `Rareza: ` |
| th | `ชนิดไอเทม: ` | `Rarity: ` |
| ko | `아이템 종류: ` | `아이템 희귀도: ` |
| cmn-Hant | `物品種類: ` | `稀有度: ` |
| cmn-Hans | `物品类别: ` | `Rarity: ` |
| ja | `アイテムクラス: ` | `レアリティ: ` |

(Trailing spaces are significant. `omarchy_new` exports this function
unchanged.)

Port with wl-clipboard:

- Read: `wl-paste -n -t text/plain` (exit code ≠ 0 / "No selection" → `""`).
  Write: `wl-copy` with the text on stdin (`wl-copy` forks and serves the
  selection; it uses the data-control protocol, no focus needed). Clear:
  `wl-copy --clear`.
- Recommended detection: keep one long-lived
  `wl-paste --watch sh -c 'cat; printf "\0"'` (NUL-delimited stream, pattern
  from `omarchy_new`, §10.2) and treat **every selection event** as a new
  copy; after `sendshortcut`, wait for the first event whose text
  `isPoeItem` within `initialDelay + 500 ms`. Keep the EE2 sentinel write
  (`__EE2_FORCE_EMPTY_<ts>` via `wl-copy`) before the copy for parity with
  Linux EE2 — it guarantees a change even if the watch misses an event and
  makes a fallback content-poll (every 48 ms, `wl-paste -n`) work.
- Restore (if `restoreClipboard`): restore `textBefore` via `wl-copy` (or
  `--clear` when empty). Under XWayland the 120 ms window may be too short —
  make it configurable.
- Clipboard text goes XWayland (Wine X11 CLIPBOARD) → Hyprland XWM → Wayland
  selection. The `omarchy_new` investigation found the X11→Wayland sync is
  "focus-gated" and can go quiet when focus is split; the copy path here
  always has the game focused, so it should be reliable (prototype confirms).

### 8.7 Chat commands — `typeInChat(text, send, clipboard)` (`text-box.ts` L16-55)

Everything runs inside `clipboard.restoreShortly(cb)` (§8.9). `modifiers`
= `[Ctrl]` (Meta on macOS). `PLACEHOLDER_LAST = "@last"`. `AUTO_CLEAR` =
first characters `#` (global) `%` (party) `@` (whisper) `$` (trade) `&`
(guild) `/` (command). All taps are synchronous, no delays.

| Branch | Condition | Clipboard | Keys |
|---|---|---|---|
| A | `text.startsWith("@last")` | `text.slice("@last ".length)` (e.g. `"@last ty"` → `"ty"`) | `Ctrl+Enter` (PoE: open chat pre-filled with `@<last whisperer> `) |
| B | `text.endsWith("@last")` | `text.slice(0, -5)` (e.g. `"/invite @last"` → `"/invite "`, trailing space kept) | `Ctrl+Enter`, `Home`, `Home` (twice: "focus input when using controller"), `Delete` (removes the `@` → input is `Name `) |
| C | otherwise | `text` | `Enter` (open chat); if `text[0]` ∉ AUTO_CLEAR → `Ctrl+A` (select the pre-filled channel text so paste replaces it) |

then always `Ctrl+V`, and if `send`:
`Enter` (send), `Enter` (reopen chat), `ArrowUp`, `ArrowUp`, `Escape`
("restore the last chat" — leaves the chat channel/history the way the user had
it). Results with defaults:

- `/hideout` (F5): clip `/hideout`; Enter, Ctrl+V, Enter, Enter, Up, Up, Esc.
- `/exit` (F9): same shape.
- `@last ty`: clip `ty`; Ctrl+Enter, Ctrl+V, Enter, Enter, Up, Up, Esc → `@Name ty`.
- `/invite @last`: clip `/invite `; Ctrl+Enter, Home, Home, Delete, Ctrl+V, Enter, Enter, Up, Up, Esc → `/invite Name `.
- `/tradewith @last`, `/hideout @last`: same as invite.

`@last` relies entirely on the game's own Ctrl+Enter "reply to last whisper"
pre-fill; **no client log is needed**. The game's chat key comes from the ini
(`[ACTION_KEYS] chat=13` → Enter on this machine) but EE2 hard-codes Enter.

Port as `sendshortcut` dispatches to the game window (keysyms `Return`,
`Home`, `Delete`, `Up`, `Escape`, `CTRL,Return`, `CTRL,a`, `CTRL,v`), batched,
after the `wl-copy` has completed. Wine pastes from the X11 CLIPBOARD, which
Hyprland's XWM fills from the Wayland selection — give it a few ms (and verify)
before `CTRL,V`. EE2 sends everything with zero delay; if PoE drops keys under
sendshortcut, add 10-25 ms gaps (the ydotool experiment used 25 ms).

### 8.8 Stash search — `stashSearch(text, clipboard, overlay)` (`text-box.ts` L57-72)

Inside `restoreShortly`: `overlay.assertGameActive()` (give focus back to the
game if the overlay had it — e.g. invoked from the stash-search widget or
item-check panel); clipboard ← `text`; `Ctrl+F` (PoE focuses the stash/vendor
search box with its text selected); `Ctrl+V`; `Enter`.

Triggered by: `stash-search` hotkeys (entry text), the stash-search widget
buttons, and item-check `search-similar` / `search-same-priced` via
`CLIENT->MAIN::user-action { action: "stash-search", text }` (`Shortcuts.ts`
L73-77).

Port: `wl-copy text` → sendshortcut `CTRL,f`, `CTRL,v`, `,Return` to the game.
If the panel ever has keyboard focus, drop it first (layer keyboard
interactivity `none`, `hyprctl dispatch focuswindow class:…`).

### 8.9 `restoreShortly(cb)` — throttle + restore (L87-103)

- If a previous call has not finished its 120 ms window (`isRestored ===
  false`) → **drop this call entirely** (callback not run). Comment: "This
  throttling helps against disconnects from 'Too many actions'" (PoE kicks for
  action spam).
- Else: `saved = readText()`, run `cb` synchronously, after 120 ms restore
  `saved` if `restoreClipboard`, then allow the next call.

Port: keep the throttle (≥ 120 ms, ideally until the whole dispatch batch has
been sent) and the conditional restore.

### 8.10 Other uiohook-driven behaviour in `Shortcuts`

- `logKeys` keydown/keyup logging (L79-91) — needs a global key hook; drop or
  log only bound actions.
- Stash scroll (L93-103, `isStashArea` L326-337): on **Ctrl + mouse wheel**
  while the game is active and `stashScroll` is on: if the cursor is **not**
  over the stash area (stash area = `x ≤ bounds.x + uiSidebarWidth` where
  `uiSidebarWidth = round(bounds.height * 370/600)`, and
  `bounds.y + h*154/1600 < y < bounds.y + h*1192/1600`), tap `ArrowRight`
  (wheel rotation > 0) or `ArrowLeft` (< 0) — PoE switches stash tabs with
  arrows; over the stash itself the game handles Ctrl+wheel natively. Not in
  OmaExiled scope; would need a Hyprland `CTRL, mouse_down/mouse_up` bind.

---

## 9. Windowing

### 9.1 `OverlayWindow` state machine (`OverlayWindow.ts`)

State: `isInteractable` (overlay has focus + mouse), `wasUsedRecently`
(last `used-recently.isOverlay`, default `true`), `isOverlayKeyUsed`,
`shouldShowOverlay` (from `render-state`), `hideOverlayOnBlur`.

- `assertOverlayActive()` (L94-103): if not interactable → `isInteractable =
  true`, show the window, `OverlayController.activateOverlay()` (mouse on,
  focus overlay), `poeWindow.isActive = false` ⇒ `active-change(false)` ⇒
  hotkeys unregistered and `focus-change { game: false, overlay: true,
  usingHotkey }`.
- `assertGameActive()` (L105-113): if interactable → `isInteractable = false`,
  `OverlayController.focusTarget()` (mouse off, focus game),
  `poeWindow.isActive = true` ⇒ hotkeys registered and
  `focus-change { game: true, overlay: false, usingHotkey }`.
- `toggleActiveState()` (L115-122): `isOverlayKeyUsed = true`, then toggle.
- `handlePoeWindowActiveChange(isActive)` (L192-206): if the game became
  active while interactable → `isInteractable = false`; broadcast
  `MAIN->OVERLAY::focus-change { game: isActive, overlay: isInteractable,
  usingHotkey: isOverlayKeyUsed }`; reset `isOverlayKeyUsed`;
  `syncWindowVisibility()`.
- User alt-tabs from the game to another app: `{ game: false, overlay: false }`.
  If the overlay was interactable and the user clicks another app, no event
  is sent until the game regains focus (`isInteractable` stays stale).
- `OVERLAY->MAIN::focus-game` → `assertGameActive` (L25-28). Renderer sends
  it from `closePriceCheck()` (`PriceCheckWindow.vue` L391-405), background
  clicks (`OverlayWindow.vue` L348-364 when `overlayBackgroundClose` /
  `overlayAlwaysClose`).
- `handleOverlayAttached(hasAccess)` (L170-190): `hasAccess === false`
  (Windows admin) → error dialog; else broadcast
  `MAIN->OVERLAY::overlay-attached`. Then `syncWindowVisibility()`.
- `syncWindowVisibility()` / `showOverlay()` (L208-227): only with
  `hideOverlayOnBlur`: show (inactive, always-on-top "screen-saver") if
  `isInteractable || (shouldShowOverlay && game active)`, else hide.
- BrowserWindow (L43-53): `OVERLAY_WINDOW_OPTS` (frameless, transparent,
  `show: false`, `skipTaskbar` false on Linux, `resizable` false on Linux),
  800×600 initially, `webviewTag: true`, `spellcheck: false`. Menu (L55-61)
  with `editMenu`, `reload` (Ctrl+R), `toggleDevTools` (Ctrl+Shift+I).
  `setWindowOpenHandler → shell.openExternal(url), deny` (L71-74).
- `loadAppPage(port)` (L77-92): `http://localhost:${port}/index.html` (dev:
  Vite URL + detached devtools); `--no-overlay` → open in system browser.

Port (backend owns the state, host owns the surface):

| EE2 | OmaExiled |
|---|---|
| game focus/blur from X11 | socket2 `activewindow` (§8.3) |
| `overlay-attached` | send when the PoE2 client appears (`openwindow>>ADDR,WS,CLASS,TITLE` or an initial `hyprctl -j clients` scan) and the host page is connected |
| `assertOverlayActive` | emit `focus-change {game:false, overlay:true, usingHotkey}`; tell host to show the overlay UI (and switch keyboard interactivity to `on_demand` only if text input is needed) |
| `assertGameActive` / `focus-game` | emit `focus-change {game:true, overlay:false, usingHotkey:false}`; host: keyboard interactivity `none`, unmap if `render-state.shouldShow` is false; optionally `hyprctl dispatch focuswindow class:^(steam_app_2694490)$` |
| `render-state` | map/unmap the layer surface |
| `window.open` | host `newWindowRequested` → `xdg-open` |

### 9.2 Keys handled inside the overlay page (`handleExtraCommands`, L134-168)

On `before-input-event` of the overlay page and of any `<webview>` inside it,
for `keyDown`: normalize `code` (strip `Key`/`Digit` prefix), prefix
modifiers as `Shift + Alt`, `Ctrl + Shift`, `Ctrl + Alt`, `Alt`, `Ctrl`,
`Shift` (no 3-modifier case). Then:

- `Escape` or `Ctrl + W` → preventDefault, `assertGameActive` (close / give
  focus back).
- `=== overlayKey` (e.g. `Shift + Space`) → preventDefault, `toggleActiveState`.

(`omarchy_2` additionally ignored `input.isAutoRepeat` — holding Shift+Space
too long re-toggled the overlay ~400 ms later.)

Port: when the layer surface (or settings window) has keyboard focus, the
host (QML `Keys`/shortcut) or renderer must implement the same three keys and
send `OVERLAY->MAIN::focus-game` / a toggle request. When the game has the
keyboard (the normal case), Escape goes to the game — to also close the
price panel, a **non-consuming** Hyprland bind (`bindn`, Escape) active only
while a panel is shown can tell the backend to close it without stealing
Escape from PoE.

### 9.3 `GameWindow` (`GameWindow.ts`)

`bounds` = `OverlayController.targetBounds` (game client rect; physical px on
Windows), `isActive` (setter emits `active-change` on change),
`uiSidebarWidth = round(bounds.height * 370/600)` (only for stash scroll),
`attach(window, title)` once: hooks library `focus`/`blur` events and
`attachByTitle(window, title, { hasTitleBarOnMac: true })`. The native X11
code (`electron-overlay-window/src/lib/x11.c` L168-173) matches
`_NET_WM_NAME` with `strcmp` — **exact title**. The library also hides the
overlay on game blur, re-shows on focus, sets `setIgnoreMouseEvents(true)` on
attach/focus, follows moves/resizes (throttled 34 ms).

Port: track the PoE2 client via socket2 (`openwindow`, `closewindow`,
`activewindow`, `activewindowv2`, `movewindowv2`, `fullscreen`,
`windowtitlev2`) plus `hyprctl -j clients` for `at`/`size`/`monitor`/
`fullscreen`. Report `fullscreen` state: `fullscreen=2` is the input-wedge
mode on this machine (§1) — worth a one-time warning in the log/bar.

### 9.4 `OverlayVisibility` — Alt-hold hides the overlay (`OverlayVisibility.ts`)

uiohook global hook:

- keydown with `altKey && !shiftKey && !ctrlKey && keycode === Alt` (Alt
  pressed alone) → `makeInvisible()`: if visible and no timer, start a timer
  of **85 ms if the overlay is interactable, 275 ms otherwise**; on fire set
  invisible and broadcast `MAIN->OVERLAY::visibility { isVisible: false }`.
- any other keydown, any keyup without Alt, any mousemove without Alt →
  `makeVisible()`: cancel a pending timer (no event), or if invisible
  broadcast `{ isVisible: true }`.

Renderer: `hideUI = !isVisible` hides all widgets except those flagged
`ignore-ui-visibility` while active. Purpose: holding Alt in PoE shows
advanced item info / labels, and the overlay gets out of the way. Optional in
OmaExiled; would need non-consuming Hyprland binds on `Alt_L` press and
release (`bindn`/`bindrn`).

### 9.5 `WidgetAreaTracker` — hold-mode panel (`WidgetAreaTracker.ts`)

Armed by `OVERLAY->MAIN::track-area`, which the renderer sends **only for
hold-mode price checks** (`!focusOverlay`, `isElectron`;
`PriceCheckWindow.vue` L265-286) with:

- `holdKey` = price-check `hotkeyHold` (`"Ctrl"` default)
- `closeThreshold` = `2.5 * fontSize` CSS px (40 px at 16 px)
- `from` = `e.position` (cursor at hotkey press)
- `area` = the panel rect in screen CSS px: width `28.75 * fontSize`, full
  window height, x on the side away from the cursor
  (`window.screenX + poePanelWidth` or
  `window.screenX + innerWidth - poePanelWidth - width`), y `window.screenY`
- `dpr` = `devicePixelRatio`

Main converts to physical px (Linux: `(v - display.bounds.x + display.nativeOrigin.x) * scaleFactor`,
size × scaleFactor, threshold × dpr), removes old listeners and attaches
uiohook `mousemove` / `mousedown`:

- **mousemove**: `modifier = ctrlKey ? "Ctrl" : altKey ? "Alt" : undefined`.
  1. If overlay **not** interactable **and** `modifier !== holdKey` (user
     released the hold key): if the cursor is farther than `closeThreshold`
     from `from` → broadcast `MAIN->OVERLAY::hide-exclusive-widget` and stop
     tracking. (Release Ctrl and move away → the panel closes. Release and
     stay → it stays.)
  2. Else if the cursor is inside `area` → `assertOverlayActive()` (still
     holding Ctrl, or already active, and moved onto the panel → panel takes
     mouse+focus).
  3. Else if interactable (mouse left the panel after it was activated) →
     stop tracking, `assertGameActive()` (→ `focus-change {overlay:false}` →
     renderer hides `hide-on-blur` widgets ⇒ the panel closes).
- **mousedown** inside `area` → stop tracking, `assertOverlayActive()`.
- `removeListeners()` is called on: new `track-area`, `toggle-overlay`, every
  successful `copy-item` (before sending the new `item-text`).

Port: with a natively pointer-interactive layer surface, rule 2 and mousedown
are not needed for input. The closing rules are what matter:

- "hold key released and cursor moved > threshold from `from` while not over
  the panel" → `hide-exclusive-widget`. Needs cursor position
  (`hyprctl -j cursorpos` polled at ~30-60 Hz while armed, or pointer
  enter/leave from the host surface) and the hold-key state (Hyprland has no
  modifier-state query; options: a non-consuming release bind on
  `Control_L`/`Control_R` while armed, or approximate with "cursor never
  entered the panel and moved away").
- "pointer entered the panel, then left it" → treat like `assertGameActive`
  (send `focus-change {game:true, overlay:false}` so the renderer closes
  `hide-on-blur` widgets). The host can report pointer enter/leave on the
  input region.

`omarchy_2` tried polling `screen.getCursorScreenPoint()` every 40 ms with a
3-tick dwell to auto-activate and a 12 s arm timeout; combined with pinning
it trapped input across workspaces — do not auto-grab focus in the port.

---

## 10. The user's Linux experiments

Branches (`git log master..<branch>`): `omarchy` (base: "first step to
omarchy", "almosst working", "making some tweaks", "fix updater"),
`omarchy_2` (= omarchy + "another attempt": HyprlandWatcher, pinning, hover
activation), `omarchy_new` (= omarchy + "trying to make it work",
"copy paste working"). Files of interest on `omarchy_new`:
`main/src/shortcuts/Shortcuts.ts` (+153), `main/src/shortcuts/LinuxInput.ts`
(new, 85), `main/src/shortcuts/HostClipboard.ts` (`export isPoeItem`),
`renderer/src/web/overlay/OverlayWindow.vue`, `run-ee2-wayland.sh`,
`LINUX.md`, `LINUX_OVERLAY_REPORT.md`, `LINUX_OVERLAY_HANDOFF.md`.

### 10.1 Setup that made EE2 run at all

- Electron forced onto XWayland: `ELECTRON_OZONE_PLATFORM_HINT=x11` +
  `--ozone-platform=x11 --no-updates` (`run-ee2-wayland.sh`); the auto-updater
  otherwise replaced the patched AppImage with a stock one.
- Hyprland rules for class `exiled-exchange-2`: `no_blur`, `no_shadow`,
  `no_dim`, `border_size 0`, `rounding 0`, `float`, `no_initial_focus`.
- Kill only by process name (`pkill -9 exiled-exchange`); `pkill -f
  "ozone-platform=x11"` killed the user's own shell. Stale
  `~/.config/exiled-exchange-2/Singleton*` blocked relaunches.

### 10.2 Clipboard watcher (`omarchy_new` `Shortcuts.startClipboardWatch`, Linux only)

The user copies with the **game's own Ctrl+C / Ctrl+Alt+C**; EE2 prices
whatever item lands on the clipboard. Two sources, deduplicated:

1. **Primary — Wayland selection watch**: one long-lived child
   `spawn("wl-paste", ["--watch", "sh", "-c", 'cat; printf "\\000"'], { stdio: ["ignore","pipe","ignore"] })`.
   `wl-paste --watch CMD` runs CMD once per selection change with the content
   on stdin; the trailing NUL makes stdout a self-delimiting stream.
   - Split stdout on `0x00`; the **first payload is the pre-existing
     clipboard and is skipped** (`seeded` flag).
   - Payloads > 512 KiB (images etc.) are discarded (`overflow`, buffer reset).
   - On child exit: reset buffer/flags, log
     `warn [ClipboardWatch] wl-paste watch exited, restarting in <n>ms`,
     restart with exponential backoff 1 s → ×2 → max 30 s. Spawn error →
     `error [ClipboardWatch] wl-paste unavailable: <msg>`.
   - Key finding: **Wine re-takes the X11 CLIPBOARD on every in-game copy and
     the XWayland bridge forwards each take, so copying the same item twice
     produces two events even with identical text.** Hence no need to wipe
     the clipboard between checks, and the item text stays pasteable.
2. **Fallback — Electron X11 clipboard poll** every 150 ms
   (`clipboard.readText()`, content-diff against the last value), for states
   where "Hyprland's focus-gated X11 → Wayland selection sync goes quiet".
   Content-diff only, so it cannot see identical re-copies.

`consume(text, source)`: ignore unless `isPoeItem(text)`; if `text ===
lastConsumed` and less than **1500 ms (x11) / 250 ms (wayland)** passed →
drop (echo of the same copy on the other source / duplicate bridge event);
then log `info [ClipboardWatch] item copied (<source>) -> price-check`,
`areaTracker.removeListeners()`, and send `item-text { target: "price-check",
clipboard: text, position: screen.getCursorScreenPoint(), focusOverlay: true }`
to last-active. Never writes the clipboard, never activates the overlay
(`focusOverlay: true` = persistent read-only panel; Shift+Space to interact).

Earlier iterations (`omarchy`, `omarchy_2`): polling `wl-paste -n` every
200 ms; clearing the clipboard (`clipboard.clear()` + `wl-copy --clear`)
after each consume so re-copies became visible; a 5 s startup grace period;
gating on `hyprctl activewindow` being the game/overlay (so item text copied
in a browser — e.g. from the trade site — does not pop a panel). The final
version dropped the clearing in favour of `--watch`.

### 10.3 `LinuxInput.ts` — ydotool (written, then abandoned)

`ydotoolChord(keys)` → `ydotool key --key-delay 25 <code>:1 … <code>:0`
(press in order, release in reverse) using Linux input-event codes (`Ctrl 29,
Shift 42, Alt 56, C 46, V 47, Enter 28, Escape 1, Home 102, ArrowUp 103,
ArrowLeft 105, ArrowRight 106, ArrowDown 108, Delete 111, …`); binary
looked up at `/usr/bin|/usr/local/bin|/bin/ydotool`; requires `ydotoold` and a
matching `YDOTOOL_SOCKET`. `pressKeysToCopyItemText` on Linux sends the whole
chord `mergeTwoHotkeys("Ctrl + C", showModsKey)` regardless of held keys.
Result: pointer events reached the compositor but **key events never reached
the Proton game** (ydotool#290 on Hyprland); the prototype later found ydotool
"works but desyncs modifiers when the bind shares Ctrl/Alt". Unused.

### 10.4 Other learnings from `LINUX_OVERLAY_REPORT.md` / `HANDOFF.md` (omarchy_new)

- uiohook (XTest) cannot init under XWayland (`XkbGetKeyboard failed to
  locate a valid keyboard`) and crashes on quit (`FATAL ERROR:
  tsfn_to_js_proxy napi_call_function`). `xdotool --window` (XSendEvent) is
  ignored by Wine; `wtype` only targets Wayland surfaces.
- Mouse capture on the transparent XWayland overlay was restored **only** when
  activation came from an Electron `globalShortcut` press (Shift+Space);
  activation from timers/clipboard/uiohook gave keyboard focus but clicks fell
  through (electron#23042, electron#38396). ⇒ the "two gestures" catch-22
  (game must get Ctrl+C, Electron must get the activation key).
- In Windowed Fullscreen the override-redirect overlay stayed **below**
  fullscreen PoE until a workspace switch forced a re-composition. Pinning
  (`hyprctl dispatch pin`), remapping, hover activation and moving the
  game-sized overlay to all workspaces were tried and **reverted as unsafe**
  (an invisible game-sized surface captured input across workspaces; PoE had
  to be killed).
- A `/events` diagnostic WebSocket becomes last-active and steals
  `item-text` (§3.2).
- The handoff's preferred fix — an independent, normally-managed panel that
  only captures input inside its own bounds and never relies on
  override-redirect stacking — is what the OmaExiled layer-shell design does.
- `omarchy_2` `HyprlandWatcher.ts`: connects to
  `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock`,
  splits on `\n`, parses `activewindow>><class>,<title>`, reconnects after
  5 s; `isGameContextClass(cls) = cls.startsWith("steam_app") || cls ===
  "exiled-exchange-2"`. Reusable pattern for the backend (minus the pinning).

### 10.5 Earlier prototype `/home/ultra/Developer/poe_price_checker` (Go + Quickshell)

Not an EE2 branch, but it validated the OmaExiled approach on this machine:

- `hyprctl dispatch sendshortcut "CTRL, C, class:^steam_app_2694490$"` copies
  the hovered item from raw XWayland PoE2 ("compositor-native: can't leave
  modifiers stuck"), then polls `wl-paste -n -t text/plain` every 20 ms (max
  30×) until it differs from the snapshot taken before the copy (a fixed
  sleep read the previous item).
- A resident Quickshell **overlay-layer** window rendered results above the
  game and took clicks — in **Windowed** mode only (`fullscreen=0`, §1).
- Hyprland bind used: `CTRL ALT, D` → script (now in `~/.config/hypr/bindings.lua`
  L10 and conflicting with EE2's default, §1).

---

## 11. Dropped subsystems — what to stub

- **AppUpdater**: `/config.updater = { state: "initial" }`; ignore
  `check-for-update` / `update-and-restart`; never send `updater-state`.
  (Renderer About page and `IPC.ts` L21-23 tolerate this.)
- **AppTray** (`AppTray.ts`): tooltip `Exiled Exchange 2 v<version>`; menu
  "Settings/League" (dialog: `Open Path of Exile 2 and press "<overlayKey>".
  Click on the button with cog icon there.`), "Open in Browser"
  (`http://localhost:<port>`), separator, "Open config folder"
  (`<userData>/apt-data`), "Quit". Plus `user-action quit` → quit. The bar
  plugin should offer: open settings (normal window), open in browser, open
  config folder, quit, and show status (game attached / league / last error).
  The plugin needs a discoverable port → write it to
  `$XDG_RUNTIME_DIR/omaexiled/port` or use a fixed port.
- **GameLogWatcher**: candidate paths (Linux) `~/.wine/drive_c/Program Files
  (x86)/Grinding Gear Games/Path of Exile 2/logs/Client.txt` and
  `~/.local/share/Steam/steamapps/common/Path of Exile 2/logs/Client.txt`
  (exists here); `watchFile` 450 ms; reads from the end in 64 KiB chunks;
  broadcasts trimmed non-empty lines. Only the leveling/XP tracker consumes
  `game-log` (`client-log/client-log.ts`); price check and `@last` do not.
  Drop; ignore `re-parse-log` and `write-data`.
- **FileWriter**, **file-uploads**, **vision/OCR**: drop.

### GameConfig (keep) — `GameConfig.ts`

- Candidate paths on Linux (L18-28):
  `<XDG Documents>/My Games/Path of Exile 2/poe2_production_Config.ini` and
  `~/.local/share/Steam/steamapps/compatdata/2694490/pfx/drive_c/users/steamuser/Documents/My Games/Path of Exile 2/poe2_production_Config.ini`
  (the latter exists here). `guessFileLocation` returns the single readable
  candidate, `null` if more than one is readable ("don't allow multiple
  matches"), `undefined` if none.
- `readConfig(path)` (L59-97) only re-reads when the configured path string
  changes (so ini edits during a session are not picked up). `trimStart()`
  (BOM), `ini.parse`, `ACTION_KEYS.show_advanced_item_descriptions`.
- `parseConfigHotkey` (L99-134): value `"<vk>"` or `"<vk> <mod>"`; `<vk>` via
  `CodeToKey` (Windows VK → EE2 key name), `<mod>` `1` Shift, `2` Ctrl, `3` Alt;
  result via `hotkeyToString`. Unknown → log, `null`. `showModsKey` getter
  defaults to `"Alt"`.
- This machine: `show_advanced_item_descriptions=18` (Alt) in both
  `[ACTION_KEYS]` (L294) and `[WASD_ACTION_KEYS]` (L393); `chat=13` (Enter).
  **The user plays in WASD mode** (`user_input_mode=wasd`,
  `last_selected_KBM_input_mode=wasd`), whose bindings live in
  `[WASD_ACTION_KEYS]`; EE2 only reads `[ACTION_KEYS]`. Port: read the section
  matching `user_input_mode`, fall back to `[ACTION_KEYS]`, and re-read on
  file change.

---

## 12. EE2 quirks — replicate or fix deliberately

1. `test-only` copy-chord probe is dead code (filtered as reserved).
2. Duplicate hotkeys disable every action on that key except `toggle-overlay`.
3. Price-check shortcut is string-concatenated (`hotkeyHold + " + " + hotkey`), may be non-canonical.
4. `showModsKey` is stale on the first `update-host-config` (async ini read after validation).
5. Concurrent `copy-item` presses share one poll and emit duplicate `item-text`; `elapsed` reset extends the window.
6. Linux sentinel `__EE2_FORCE_EMPTY_<ts>` remains on the clipboard after a timed-out copy when `restoreClipboard` is off.
7. `restoreShortly` silently drops a second chat/stash action inside 120 ms.
8. `/config` and saves switch to `config.json.tmp` permanently after one `isTemporary` save; a failed write exits the app.
9. `lastActiveClient` can be `undefined` (crash) or a closed socket (lost events).
10. Static server: no 404, no traversal guard, content-type only for 4 extensions, broken by query strings.
11. `os.release` logged without calling it.
12. GameConfig ignores `[WASD_ACTION_KEYS]` and re-reads only on path change.
13. Logger history grows without bound and is sent whole to each new client.
14. `JSON.parse` of WS messages is unguarded.
15. Proxy forwards the localhost `Referer` and the client's `Accept-Encoding`.

---

## 13. Minimal backend contract checklist

- `GET /` and static renderer files; `GET /config` → `HostState`.
- `/proxy/<allowed host>/<path>?<query>` → HTTPS, method/body/headers as §5,
  status + rate-limit headers passed through, cookie jar, Chrome-like UA.
- `ws /events`: `{name, payload}` JSON text frames; history `log-entry` on
  connect; inbound events of §3.3; `config-changed` broadcast on every save;
  `item-text` to the overlay page.
- Config at `~/.config/omaexiled/config.json`, opaque string, atomic writes,
  `.tmp` semantics, optional import from `~/.config/exiled-exchange-2/apt-data/config.json`.
- Hotkeys from `HostConfig.shortcuts`, validated per §8.2, bound in Hyprland
  only while the PoE2 window is active, unbound otherwise.
- `copy-item`: cursor pos → (sentinel) → `sendshortcut` copy chord from the
  ini → wait for item text (`initialDelay`, 500 ms budget) → `item-text`.
- `paste-in-chat` / `stash-search`: throttled clipboard write + exact key
  sequences of §8.7 / §8.8 via `sendshortcut`, optional restore.
- Game window tracking via socket2 → `focus-change`, `overlay-attached`.
- `focus-game`, `render-state`, `track-area` → host commands (stdio JSON).
- `user-action quit` → shut down backend + host.
