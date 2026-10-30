# 01: Renderer bootstrap, host IPC, config, i18n, background services

Source: `/home/ultra/Developer/Exiled-Exchange-2` (branch `master`, commit `cca30662`).
Paths below are relative to that repo root unless stated otherwise. `R/` = `renderer/`, `M/` = `main/src/`.

Scope of this note: `R/src/main.ts`, `R/src/web/App.vue`, `R/src/web/background/{IPC,Leagues,Prices,TradeData}.ts`,
`ipc/types.ts`, `ipc/KeyToCode.ts`, `R/src/web/Config.ts`, `R/src/web/i18n.ts`, `R/index.html`,
`R/vite.config.mts`, tailwind/postcss config, `R/src/assets/font.css`. It also covers the parts of the Electron main
process (`M/server.ts`, `M/proxy.ts`, `M/host-files/ConfigStore.ts`, ...) that define the contract the renderer
expects, because the Bun backend must reproduce that contract.

Contents:
1. TL;DR for implementers
2. Boot sequence, and what the host must provide
3. Host transport (`IPC.ts`) and the `isElectron` switch
4. IPC event catalogue (every event, payload, direction, routing, KEEP/DROP)
5. HTTP endpoints the backend must serve
6. Every HTTP request the renderer makes
7. Background services (Leagues, Prices/poe.ninja, TradeData)
8. Config: persistence, lifecycle, full schema, widgets, migrations, HostConfig
9. i18n and per-language data loading
10. Build setup (rebuild the renderer standalone)
11. `KeyToCode.ts` and mapping shortcuts to Hyprland
12. Required renderer patches / port checklist
13. System prerequisites on this machine (what to install)
14. Open questions

---

## 1. TL;DR for implementers

- The renderer is a single Vite + Vue 3.2 SPA. It needs only a same-origin HTTP server that provides:
  `GET /` and static files, `GET /config` (returns `HostState` JSON), `GET|POST /proxy/<host>/<path>` (an allow-listed HTTPS
  reverse proxy), and a WebSocket at exactly `/events` (JSON `{name, payload}` messages). `/uploads/*` is only used by the dropped
  image-strip widget.
- The boot order is strict and blocking: `/config` → i18n JSON → ~2.7 MB/lang data files → **2 proxied requests to
  www.pathofexile.com (trade stats + items)** → WebSocket open → mount. If any of these hangs, the UI never mounts. Give the
  backend proxy a timeout.
- `Host.isElectron` (`navigator.userAgent.includes("Electron")`, `R/src/web/background/IPC.ts:88-90`) toggles overlay
  mode vs. browser mode in about 10 places. Under QtWebEngine it is `false` by default. All `MAIN->OVERLAY::*` events are then
  **silently dropped** by `onEvent` (`IPC.ts:51-53`). Decide explicitly (see §3.3). The recommendation is to replace the UA sniff with an explicit host
  flag rather than faking an Electron UA.
- Config is one JSON string owned by the renderer. The backend stores it verbatim, and broadcasts `MAIN->CLIENT::config-changed` to every
  client after each `CLIENT->MAIN::save-config`. The renderer derives a `HostConfig` (hotkeys etc.) and pushes it with
  `CLIENT->MAIN::update-host-config`. The backend never interprets `config.json` itself in EE2 (OmaExiled may choose to).
- `saveConfig()` is a no-op while any `wmZorder:"exclusive"` widget is shown (price-check, item-check, **settings**). Persistence
  then relies on a later trigger: the exclusive widget hides, or the `window` `blur` event fires. With a no-keyboard-focus layer-shell panel and a separate
  settings window, **this must be patched** or settings never persist (see §8.3).
- `upgradeConfig()` and `getConfigForHost()` dereference dropped widgets (`library`, `delve-grid`, `image-strip`,
  `experience-tracker`, `menu`...) with `!`. If those widget entries are removed from the config, **both crash**. Either keep stub
  entries or rewrite both functions (see §8.5/§8.6).
- `.index.bin` data files are git-ignored and must be generated (`npm run make-index-files`) before `vite build`.
- Absolute asset paths (`/images/...`, `/data/...`) are hard-coded, so the app must be served at origin root (`base: "/"`).

---

## 2. Boot sequence, and what the host must provide

### 2.1 `R/src/main.ts` (whole file, 28 lines)

```
7  (async function () {
8    await initConfig();                               // Config.ts:59  -> GET /config (+ registers config-changed listener)
9    const i18nPlugin = await I18n.init(AppConfig().language);   // i18n.ts:6 -> GET /data/en/app_i18n.json (+ /data/<lang>/app_i18n.json)
10   await Data.init(AppConfig().language);           // assets/data/index.ts:286 -> data files + proxied trade data
11   await Host.init();                               // IPC.ts:17 -> WebSocket ws://<host>/events, resolves on first open
13-19 watch(() => AppConfig().language, async () => { await Data.loadForLang(lang); await I18n.loadLang(lang); });
21-23 createApp(App).use(i18nPlugin).mount("#app");
24-27 if (import.meta.env.DEV) { app.config.performance = true; console.error("DEV MODE"); }
```

Notes and edge cases:
- **Order matters.** `initConfig()` runs before `Host.init()`, so `Host.socket` is still `undefined`. If the stored config is
  not valid JSON, `initConfig()` calls `saveConfig({isTemporary:true})` (`Config.ts:74-77`) → `Host.sendEvent` →
  `this.socket.send` on `undefined` → **TypeError, boot aborts**. This is an EE2 bug. Fix it by having the backend validate JSON before serving
  (return `contents:null` and move the bad file aside), or by moving `Host.init()` first.
- Every `fetch` in the boot path uses `.json()`/`.text()`/`.arrayBuffer()` **without checking `response.ok`**. A 404 for a
  language file throws, and the app never mounts. The `language` value must be one of the 9 supported codes (§9).
- `Data.init` → `loadForLang` → `loadTradeData()` → `useTradeData().load(true)` performs **two proxied requests to
  `www.pathofexile.com`** before the UI exists (§7.3). Errors are caught (the UI still mounts), but a hanging request blocks mount.
- `Host.init()` resolves on the first WebSocket `open`. If the backend never accepts the WS, the app never mounts (Sockette retries
  forever every 1 s).
- Language change at runtime re-runs `Data.loadForLang` (all data files plus the trade data re-fetch) and then `I18n.loadLang`.
- `updateConfig()` sets `document.documentElement.style.fontSize = <fontSize>px` (`Config.ts:27`), so **all rem-based sizes
  scale with config `fontSize`** (default 16). The price panel is `width: 28.75rem` (`PriceCheckWindow.vue:18`) = 460 px at 16 px.
  The Qt host must size the layer surface from this, or the renderer must report its desired size.

### 2.2 `R/src/web/App.vue`

- Template: `<div id="app" class="text-sm font-poe-sc"><OverlayWindow /></div>`. The entire app is `OverlayWindow`
  (`R/src/web/overlay/OverlayWindow.vue`), which renders every widget in `AppConfig().widgets` through the widget registry.
- Global `<style lang="postcss">`: imports `@fortawesome/fontawesome-free/css/all.min.css`, `animate.css/animate.css`,
  `../assets/font.css`, then `@tailwind base/components/utilities`. It defines `.table-stripped`, `#app` (100vh flex column,
  overflow hidden, nested `:focus{outline:0}` which needs `tailwindcss/nesting`), `.layout-column`, webkit scrollbar styles,
  number-input spinner removal, `.btn`/`.btn-icon` via `@apply`, and a `ring` keyframe and `.faa-ring`.
- Note: `index.html` also has `<div id="app">` and App.vue renders another `#app` inside it (inherited quirk, harmless).

### 2.3 Side effects when `OverlayWindow` is set up (`OverlayWindow.vue:89-178`)

Order inside `setup()`:
1. `usePoeninja()` (`:90`) creates the price service: a 4-min interval and watchers (§7.2).
2. `useLeagues().load()` (`:91`) → proxied GET of trade leagues (§7.1).
3. `useClientLog()` (`:92`) is only needed for `MAIN->CLIENT::game-log` (DROP).
4. `active = shallowRef(!Host.isElectron)` (`:94`). In browser mode the overlay is always "active".
5. `window` `blur` → `nextTick(saveConfig)` (`:114-118`). `window` `focus` → send `CLIENT->MAIN::used-recently {isOverlay: Host.isElectron}` (`:119-124`).
6. Listeners: `MAIN->CLIENT::config-changed` hides the settings widget if it is topmost (`:126-131`). `MAIN->OVERLAY::focus-change` (`:133-150`).
   `MAIN->OVERLAY::visibility` (`:151-153`). `MAIN->CLIENT::game-log` (`:157-160`).
7. `onMounted` → `nextTick` → send `CLIENT->MAIN::used-recently` and `pushHostConfig()` (`:170-178`). **This is the only automatic
   HostConfig push at startup.**
8. `watch(isOverlayVisible, {immediate:true})` → send `OVERLAY->MAIN::render-state {shouldShow}` on every change, including immediately (`:284-295`).
9. Invariant: `topmostWidget` (`:297-302`) must find at least one widget with a numeric `wmZorder`. In EE2 that is always the
   `menu` widget (`wmZorder:1`). If no such widget exists, `bringToTop`/`show` and the config-changed handler throw (`.wmId`/`.wmType`
   of `undefined`). **Keep a `menu` entry in the config (it can stay unrendered), or patch this.**

### 2.4 Host state the renderer requires

| Item | Source | Required? | Notes |
|---|---|---|---|
| `HostState.contents` | `GET /config` | yes | Raw config JSON string or `null` (→ `defaultConfig()`). |
| `HostState.version` | `GET /config` | yes | Shown in Settings → About (`about.vue:6`, `app.version`). Stored in `Host.version` (`IPC.ts:14,69`). Default before load `"0.0.00000"`. |
| `HostState.updater` | `GET /config` | yes (type) | `UpdateInfo` (`ipc/types.ts:52-68`). Used by About and `price-check/BackgroundInfo.vue:33-54`. For OmaExiled (no updater) return `{"state":"update-not-available","checkedAt":<ms>}` (About shows "latest" plus a check-now button) or `{"state":"initial"}` (About shows "maybe outdated / never checked"). |
| WS `/events` open | backend | yes | Mount waits for it. |
| Log history | WS `MAIN->CLIENT::log-entry` on connect | optional | `Host.logs` is shown in Settings → Debug and in the overlay when `logKeys && !active`. |
| Window geometry | `window.innerWidth/innerHeight/screenX/screenY` | yes (overlay mode) | Used to compute panel side, the position circle and track-area (see §3.3). Under Wayland, `screenX/screenY` are 0, so a panel-sized surface breaks these computations. |

---

## 3. Host transport: `R/src/web/background/IPC.ts`

### 3.1 API (`class HostTransport`, exported as `MainProcess` and `Host`, `:93-94`)

| Member | Lines | Behavior |
|---|---|---|
| `logs: ShallowRef<string>` | 13, 18-20 | Appends `payload.message` of every `MAIN->CLIENT::log-entry`. |
| `version: ShallowRef<string>` | 14, 69 | Set from `HostState.version`. |
| `updateInfo: ShallowRef<UpdateInfo>` | 15, 21-23, 70 | Initial `{state:"initial"}`. Updated from `/config` and `MAIN->CLIENT::updater-state`. |
| `init()` | 17-32 | Registers the log/updater listeners, then `new Sockette(\`ws://${window.location.host}/events\`, {onmessage: e => selfDispatch(JSON.parse(e.data)), onopen: resolve})`. |
| `selfDispatch(event)` | 34-40 | Dispatches `CustomEvent(event.name, {detail: event.payload})` on an internal `EventTarget`. Also used locally to fake `item-text` (`WidgetMenu.vue:161`, `ReloadTradeData.vue:80`, `WidgetItemSearch.vue:390`). |
| `sendEvent(event)` | 42-44 | `this.socket.send(JSON.stringify(event))`. No queueing. |
| `onEvent(name, cb)` | 46-63 | Returns an `AbortController`. **If `!isElectron && name.startsWith("MAIN->OVERLAY")` it returns without subscribing** (`:51-53`). |
| `getConfig()` | 65-72 | `fetch("/config")` → `HostState`. Sets `version` and `updateInfo`. Returns `contents`. |
| `importFile(file)` | 74-82 | `POST /uploads/<file.name>` with `Content-Type: application/octet-stream` and the raw body → `{name}`. Only used by image-strip (DROP). |
| `proxy(url, init)` | 84-86 | `window.fetch(\`/proxy/${url}\`, init)`. `url` is **host + path without scheme**, e.g. `www.pathofexile.com/api/trade2/data/leagues`. |
| `isElectron` | 88-90 | `navigator.userAgent.includes("Electron")`. |

### 3.2 Wire format and Sockette semantics

- Every message in both directions is `JSON.stringify({name, payload})`. When the payload is `undefined` (for example `OVERLAY->MAIN::focus-game`, `MAIN->OVERLAY::overlay-attached`, `MAIN->OVERLAY::hide-exclusive-widget`, `CLIENT->MAIN::re-parse-log`), the `payload` key is **absent**. The backend must accept `{"name":"..."}`.
- The backend dispatches on `event.name` (`M/server.ts:96-105`).
- Sockette 2.0.6 (`R/node_modules/sockette/dist/sockette.mjs`): reconnects after `opts.timeout || 1000` ms with `maxAttempts` = ∞,
  **except when the close code is 1000, 1001 or 1005**, in which case it stays closed. A backend that shuts down "gracefully" with 1000/1001
  leaves the renderers permanently disconnected. Use another code (e.g. 4000/1012) or let the process die (1006).
- `send()` while CONNECTING throws `InvalidStateError`. While CLOSED it silently drops. **Events sent during a reconnect are lost.**
- After a reconnect the renderer does **not** re-fetch `/config` and does **not** re-push HostConfig. If the backend restarts, it
  must re-derive its hotkey state itself (for example by computing HostConfig from its own `config.json`, see §8.6), or ask the renderer to re-push (requires a patch).
- `M/server.ts:81-88`: the upgrade path must equal `/events` exactly. Anything else gets `req.destroy()`.

### 3.3 The `isElectron` switch: every effect

| Location | `isElectron === true` (overlay mode) | `false` (browser mode, i.e. QtWebEngine by default) |
|---|---|---|
| `IPC.ts:51-53` | `MAIN->OVERLAY::*` listeners active | **All `MAIN->OVERLAY::*` events ignored** (`overlay-attached`, `focus-change`, `visibility`, `hide-exclusive-widget`) |
| `OverlayWindow.vue:94` | `active` starts `false` (overlay inactive until focus-change) | `active` starts `true` and never changes |
| `OverlayWindow.vue:122,174` | `used-recently {isOverlay:true}` | `{isOverlay:false}` |
| `OverlayWindow.vue:275-282` | `isOverlayVisible` computed from active/visible widgets | always `true` (one `render-state {shouldShow:true}`) |
| `OverlayWindow.vue:328-333` | `poePanelWidth = innerHeight * 986/1600` (game stash/inventory width) | `0` |
| `OverlayWindow.vue:348-365` | background click → `focus-game` if `overlayBackgroundClose` | background click → hide topmost exclusive widget (`overlayAlwaysClose` → `focus-game` in both modes) |
| `PriceCheckWindow.vue:265-290` | on `item-text` with `!focusOverlay` → send `OVERLAY->MAIN::track-area` | no track-area |
| `PriceCheckWindow.vue:391-405` | close button → `focus-game` (unless built-in browser shown) | close button → `wm.hide()` (or `focus-game` if `overlayAlwaysClose`) |
| `price-check/trade/TradeLinks.vue:52` | built-in `<webview>` browser allowed | disabled → `window.open` |
| `price-check/trade/TradeBulk.vue:278` | `builtinBrowser` honoured | `window.open` |
| `overlay/WidgetDelveGrid.vue:68` | handles `widget-action` | ignored (widget DROP anyway) |

Implications for OmaExiled (a layer-shell panel sized to the panel, game keeps keyboard focus, panel natively mouse-interactive):
- Neither mode fits as-is. Browser mode gives "close button hides the panel" and no `--game-panel` spacer, which is what a panel-sized
  surface wants. But it loses `hide-exclusive-widget` (auto-close when the cursor moves away), and `focus-change`-driven `hide-on-blur`.
- Recommendation: replace `get isElectron()` with an explicit capability flag, for example `?host=oma` in the page URL or a global that the
  Qt host injects via `QWebEngineScript`. Then audit each row above:
  - Keep `MAIN->OVERLAY::hide-exclusive-widget` (backend-initiated close).
  - Keep `focus-change` (game focus lost → hide panels), but with the `wasActive` guard from the user's `omarchy_new` branch
    (`git diff master...omarchy_new -- renderer/src/web/overlay/OverlayWindow.vue`). That guard only hides `hide-on-blur` widgets on a real
    active→inactive transition.
  - Force `poePanelWidth = 0`.
  - Replace the `window.screenX`/`innerWidth` side logic with a side or position hint from the backend (see §4, `item-text.position`).
- Faking an Electron UA via `QWebEngineProfile::setHttpUserAgent` is possible, but it re-enables the fullscreen-overlay geometry assumptions
  (`poePanelWidth`, `track-area` screen rects), which are wrong for a panel-sized surface.

---

## 4. IPC event catalogue

Source of truth for types: `ipc/types.ts:76-98` (union), `:105-245` (definitions).
Routing (EE2 backend, `M/server.ts:58-70`): `"broadcast"` = every connected WS client. `"last-active"` (and `"any"`, same code path) =
the client that most recently connected or sent `CLIENT->MAIN::used-recently` (`M/server.ts:97,101-103`). On a socket close, if exactly 1 client
remains, it becomes last-active and the server emits a synthetic `used-recently {isOverlay:true}` internally (`M/server.ts:106-112`).

Legend: **KEEP** = needed by the trimmed app. **ADAPT** = keep the name/payload but change the semantics in OmaExiled. **DROP** = only used by dropped features.

### 4.1 Backend → renderer

| Event | Payload | EE2 sender (routing) | Renderer consumers | Status |
|---|---|---|---|---|
| `MAIN->CLIENT::config-changed` | `{contents: string}` (full config JSON) | `M/host-files/ConfigStore.ts:15-21` (broadcast, **including the sender**, after every save-config) | `Config.ts:60-63` (sets `_lastSavedConfig`, `updateConfig(JSON.parse(contents))`), `OverlayWindow.vue:126-131` (hides settings if topmost) | **KEEP**. This is how the settings window and the panel stay in sync. |
| `MAIN->CLIENT::item-text` | `{target: string; clipboard: string; item?: unknown; position: {x:number,y:number}; focusOverlay: boolean}` | `M/shortcuts/Shortcuts.ts:218-237` (**last-active**). `position` = `screen.getCursorScreenPoint()` at key press (global DIP). `item` is never sent by the backend (only by local `selfDispatch`). | `PriceCheckWindow.vue:261-305` (`target==="price-check"`), `item-check/WidgetItemCheck.vue:82-90` (`"item-check"`), `item-check/hotkeyable-actions.ts:86-112` (`open-wiki`, `open-craft-of-exile`, `open-poedb`, `search-similar`, `search-same-priced`), `library/SingleItemSession.vue:110` (`log-item`, DROP) | **KEEP/ADAPT**. Must be routed to the **panel** client, not the settings window (see §4.4). `position` is used for the side choice (`PriceCheckWindow.vue:370-379`, `WidgetItemCheck.vue:96-111`) and the circle (`CheckPositionCircle.vue:37-42`). These subtract `window.screenX/Y`, so send panel-relative coordinates or add a side hint. |
| `MAIN->CLIENT::widget-action` | `{target: string}` | `Shortcuts.ts:209-212` (broadcast, for `trigger-event` shortcuts) | `WidgetDelveGrid.vue:67` (`"delve-grid"`), `stopwatch/WidgetTimer.vue:80` (`stopwatch-start-stop:<wmId>`, `stopwatch-reset:<wmId>`) | DROP |
| `MAIN->CLIENT::ocr-text` | `{target:string; pressTime:number; ocrTime:number; paragraphs:string[]}` | `Shortcuts.ts:261-270` (last-active, win32 only) | `item-search/WidgetItemSearch.vue:297` | DROP |
| `MAIN->CLIENT::game-log` | `{lines: string[]}` | `M/host-files/GameLogWatcher.ts:147-150` (broadcast) | `OverlayWindow.vue:157-168` → `client-log.ts` (which itself sends `write-data`) | DROP. Also remove `useClientLog()` from OverlayWindow. |
| `MAIN->CLIENT::log-entry` | `{message: string}` | `M/RemoteLogger.ts:8-15` (broadcast, each line `"[<toLocaleTimeString>] <msg>\n"`). On every new WS connection the whole history goes to that client (`M/server.ts:113-116`). | `IPC.ts:18-20` → `Host.logs` → Settings → Debug (`settings/debug.vue:28`), overlay log box (`OverlayWindow.vue:21-32,401-404`) | KEEP (cheap, useful for hotkey/proxy errors) |
| `MAIN->CLIENT::updater-state` | `UpdateInfo` | `M/AppUpdater.ts:18-24` (broadcast) | `IPC.ts:21-23` | ADAPT. Optional. Send `{state:"update-not-available",checkedAt}` in reply to `check-for-update` if About keeps its button. |
| `MAIN->OVERLAY::overlay-attached` | none | `M/windowing/OverlayWindow.ts:170-190` (broadcast when the game window is found) | `overlay/LoadingAnimation.vue:27-34` ("app is ready" toast for 2.5 s if `showAttachNotification`) | DROP or ADAPT (could fire when the PoE2 window appears in Hyprland). Ignored in browser mode anyway. |
| `MAIN->OVERLAY::focus-change` | `{game: boolean; overlay: boolean; usingHotkey: boolean}` | `M/windowing/OverlayWindow.ts:192-206` (broadcast on game window active change) | `OverlayWindow.vue:133-150`: `active = overlay`. If `!overlay`, hide all `hide-on-blur` widgets (price-check, item-check). Else hide `hide-on-focus` widgets. `usingHotkey` unused in the renderer. | ADAPT. Use Hyprland `activewindow` events. Add the `wasActive` guard (see §3.3). |
| `MAIN->OVERLAY::visibility` | `{isVisible: boolean}` | `M/windowing/OverlayVisibility.ts:41-70` (broadcast. Holding Alt alone for 275 ms (85 ms when interactive) hides the UI, any other key or mouse move shows it) | `OverlayWindow.vue:151-153` (`hideUI`) | DROP (needs global input hooks. Alt is also part of Ctrl+Alt+C) |
| `MAIN->OVERLAY::hide-exclusive-widget` | none | `M/windowing/WidgetAreaTracker.ts:71-88` (broadcast when the cursor moves > `closeThreshold` from the press point while the overlay is not interactive and the hold key is not held) | `PriceCheckWindow.vue:342-344` (`wm.hide(price-check)`) | **ADAPT/KEEP**. This is the natural "backend closes the panel" message. Ignored in browser mode unless patched. |

### 4.2 Renderer → backend

| Event | Payload | Renderer senders | EE2 handler | Status |
|---|---|---|---|---|
| `CLIENT->MAIN::save-config` | `{contents: string; isTemporary: boolean}` | `Config.ts:42-48` (`saveConfig`) | `ConfigStore.ts:15-21`: write the file, then broadcast `config-changed {contents}` | **KEEP** |
| `CLIENT->MAIN::update-host-config` | `HostConfig` (§8.6) | `Config.ts:52-57` (`pushHostConfig`), called from `OverlayWindow.vue:176` (mount), `SettingsWindow.vue:302` (Save), `stash-search/WidgetStashSearch.vue` (toggle `enableHotkeys`) | `M/main.ts:104-126` → overlay opts, shortcuts, clipboard delay, log watcher, game config, updater, tray, file writer | **KEEP** (backend → Hyprland binds) |
| `CLIENT->MAIN::used-recently` | `{isOverlay: boolean}` | `OverlayWindow.vue:119-124` (window focus), `:170-178` (mount) | `M/server.ts:101-103` (sets last-active), `M/windowing/OverlayWindow.ts:32-34` (`wasUsedRecently = isOverlay`, gates `assertOverlayActive` for `focusOverlay` copy-item) | ADAPT. Use it, or a connect-time role, to classify clients. |
| `CLIENT->MAIN::user-action` | `{action: "check-for-update" \| "update-and-restart" \| "quit"}` or `{action: "stash-search"; text: string}` | `settings/about.vue:68-83` (check/update), `settings/SettingsWindow.vue:160-165` (quit), `stash-search/WidgetStashSearch.vue:131-136`, `item-check/hotkeyable-actions.ts:129-151` (stash-search) | `M/AppUpdater.ts:29-35`, `M/AppTray.ts:29-33` (quit), `M/shortcuts/Shortcuts.ts:73-77` (stash-search → `text-box.ts stashSearch`) | **KEEP**: `quit`, `stash-search`. ADAPT/DROP: `check-for-update`, `update-and-restart` |
| `CLIENT->MAIN::write-data` | `{action:"log-item";text}` \| `{action:"session";start;name?;header?}` \| `{action:"client-log-event";data:ClientLogEvent;close}` | `library/*`, `client-log/client-log.ts:40` | `M/host-files/FileWriter.ts:35` | DROP |
| `CLIENT->MAIN::re-parse-log` | none | `leveling/settings-leveling.vue:73` | `M/host-files/GameLogWatcher.ts:54` | DROP |
| `OVERLAY->MAIN::focus-game` | none | `OverlayWindow.vue:350-363` (background click), `PriceCheckWindow.vue:391-405` (close button) | `M/windowing/OverlayWindow.ts:25-28` → `assertGameActive()` (focus game, overlay click-through) | ADAPT. In OmaExiled the game already has focus, so treat it as "close/hide panel surface" (or ignore it and rely on `render-state`). |
| `OVERLAY->MAIN::render-state` | `{shouldShow: boolean}` | `OverlayWindow.vue:284-295` (immediate + on change) | `M/windowing/OverlayWindow.ts:38-41` (show/hide overlay window when `hideOverlayOnBlur`) | **ADAPT/KEEP**. This is the best existing signal for "map/unmap the layer surface". In browser mode it is always `true`, so it needs the isElectron patch. |
| `OVERLAY->MAIN::track-area` | `{holdKey: string; closeThreshold: number; from:{x,y}; area:{x,y,width,height}; dpr: number}` | `PriceCheckWindow.vue:265-290` (only when `isElectron && !focusOverlay`). `holdKey = priceCheck.hotkeyHold`, `closeThreshold = 2.5*fontSize` CSS px, `from = item-text.position`, `area` = price panel rect in screen CSS px | `M/windowing/WidgetAreaTracker.ts:15-63` (uiohook mouse tracking → `hide-exclusive-widget` or overlay activate) | ADAPT/optional. Only needed if OmaExiled implements "auto-close the hold-mode panel when the mouse moves away" (requires cursor polling via `hyprctl cursorpos`). |

### 4.3 Minimal OmaExiled event set (recommendation)

Must have: `save-config`, `config-changed`, `update-host-config`, `item-text`, `user-action` (`quit`, `stash-search`), `log-entry`.
Should have (overlay semantics): `render-state`, `hide-exclusive-widget`, `focus-change` (with guard), `focus-game` (→ close).
Can drop: `widget-action`, `ocr-text`, `game-log`, `write-data`, `re-parse-log`, `visibility`, `overlay-attached` (or repurpose), `track-area`, updater actions.
New events are likely needed (not in EE2, suggestions only): open the settings window at a given page (the price-check title click currently
opens in-overlay settings with the flag `settings::widget=<wmId>`, `PriceCheckWindow.vue:407-411`), and a renderer → host "desired panel size" message.

### 4.4 Multi-client routing (new architecture)

OmaExiled will have at least two renderer instances connected to `/events`: the panel (layer-shell) and the settings window. Each one boots the full
app (data files, trade data, leagues, poe.ninja, timers).
- `item-text` uses last-active routing in EE2. Whichever client connected or focused last gets it, so the **settings window would steal price checks**.
  Classify clients (for example `/events?role=panel|settings` (requires patching `IPC.ts:25` and relaxing the strict `req.url === "/events"` check), or a hello event) and send
  `item-text` to the panel client(s).
- `config-changed` must go to all clients (including the sender). Both instances also send `update-host-config` on mount. That is idempotent.
- Consider loading the settings instance with a flag that skips `usePoeninja()`/`useLeagues().load()`. Note: the price-check settings page uses
  `useLeagues()` for the league dropdown and `usePoeninja().availableCoreCurrencies` (`settings-price-check.vue:262-263`), so the settings window still needs leagues.

---

## 5. HTTP endpoints the backend must serve

Reference implementation: `M/server.ts`, `M/proxy.ts`, `M/host-files/file-uploads.ts`, `M/host-files/ConfigStore.ts`.

| Endpoint | Method | Contract | EE2 reference |
|---|---|---|---|
| `/` and any other path | GET | Static file from the built renderer dir. `/` → `/index.html`. Content types: `.html` text/html, `.js` **text/javascript** (required: `client_strings.js` is loaded with dynamic `import()`, which enforces a JS MIME type), `.json` application/json, `.svg` image/svg+xml. Others unset. Also needs `.css`, `.ttf`, `.woff2`, `.png`, `.jpg`, `.gif`, `.webp`, `.ico`, `.bin`, `.ndjson`, `.jsonc`. No query-string handling in EE2. Bun `Bun.file()` sets MIME types automatically. Guard against `..` path traversal (EE2 does not). | `M/server.ts:20-47` |
| `/config` | GET | `application/json` body `HostState = {contents: string\|null, version: string, updater: UpdateInfo}`. `contents` is the raw file text (not parsed). | `M/server.ts:119-129`, `ConfigStore.load()` `:24-30` |
| `/events` | GET (upgrade) | WebSocket, JSON text frames (§3.2, §4) | `M/server.ts:81-117` |
| `/proxy/<host>/<path...>` | any (GET, POST used) | Reverse proxy to `https://<host>/<path...>` (the exact raw path + query after `/proxy/`, percent-encoding preserved). See §5.1. | `M/proxy.ts` |
| `/uploads/<name>` | GET / POST | GET streams `<userData>/apt-data/files/<name>`. POST stores the body (max 16 MB) as `md5(body)+extname(url)` and returns `{"name": "<file>"}`. | `M/host-files/file-uploads.ts:8-38`. **DROP** (image-strip only) |

Listening: EE2 binds `127.0.0.1` on a random port (port `0`), or `8584` in dev, overridable with `--listen=[host][:port]` (`M/server.ts:131-148`). It then loads
`http://localhost:<port>/index.html` in the overlay (`M/windowing/OverlayWindow.ts:77-92`). The Vite dev server proxies to 8584 (§10.3), so keep 8584 as the dev port.

### 5.1 Proxy details (`M/proxy.ts`)

- Allowed hosts (`:5-19`), `official` flag (unused beyond the allow-list):
  `www.pathofexile.com`, `ru.pathofexile.com`, `pathofexile.tw`, `poe.kakaogames.com`, `jp.pathofexile.com`, `de.pathofexile.com`,
  `es.pathofexile.com`, `br.pathofexile.com`, `fr.pathofexile.com` (official), `poe.ninja`, `www.poeprices.info`, `api.exiledexchange2.dev`.
  Any other host → `req.destroy()` (renderer `fetch` rejects with TypeError).
- Host parsing: `req.url.split("/", 3)[2]` (`:26`). Upstream URL: `"https://" + req.url.slice("/proxy/".length)` (`:46`).
- Request headers: forward all incoming headers **except** names starting with `sec-`, `host`, `origin`, `content-length` (`:33-43`). Force
  `user-agent: app.userAgentFallback` (Electron's Chrome-like UA containing `exiled-exchange-2/<ver>` and `Electron/<ver>`) (`:50`).
  `useSessionCookies: true` (the Electron session cookie jar, shared with the built-in `<webview>` browser, used to pass Cloudflare challenges),
  `referrerPolicy: "no-referrer-when-downgrade"`. The body is piped.
- Response: copy the status, status message and headers, **delete `content-encoding`** (Electron `net` already decompressed) (`:57-63`), pipe the body.
  Errors → log `error [proxy] <msg> (<host>)` and destroy the socket.
- `set-cookie` rewrite: strips the `Partitioned` attribute from Cloudflare cookies so they persist (`:77-90`).
- Rate limiting is done **in the renderer** from upstream headers `x-rate-limit-rules` and `x-rate-limit-<rule>`/`x-rate-limit-<rule>-state`
  (`R/src/web/price-check/trade/common.ts:63-70`). The proxy must pass these through unchanged. Same-origin, so no CORS exposure issue.
- Bun port notes: Bun `fetch` auto-decompresses but keeps `content-encoding` **and** `content-length` (compressed). Delete both from the
  response. Also drop hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`), `referer`, `cookie` from the localhost origin, and
  `accept-encoding` (let Bun negotiate). Keep a cookie jar per upstream host if Cloudflare cookies (`cf_clearance`, `__cf_bm`) are needed.
  There is no shared browser session, so the EE2 "open captcha in built-in browser" fallback (`BackgroundInfo.vue:58-60`) does not exist in OmaExiled.
  Set an honest UA (for example `OmaExiled/<ver> (contact: ...)`). Add request timeouts (the boot path awaits proxied requests).

---

## 6. Every HTTP request the renderer makes

### 6.1 In the files of this area

| # | URL (as fetched by the renderer) | Upstream | Method | When | Error handling | File:line |
|---|---|---|---|---|---|---|
| 1 | `/config` | backend | GET | boot step 1 | none (throws → no mount) | `IPC.ts:66` |
| 2 | `/data/en/app_i18n.json` | static | GET | boot (always) | none | `i18n.ts:16` |
| 3 | `/data/<lang>/app_i18n.json` | static | GET | boot + language change, if `lang !== "en"` | none | `i18n.ts:28` |
| 4 | `/data/en/client_strings.js` | static, dynamic `import()` | GET | boot (`CLIENT_STRINGS_REF`) | none | `assets/client-string-loader.ts:8`, `data/index.ts:287` |
| 5 | `/data/item-drop.json` | static | GET | boot | none | `data/index.ts:288-290` (result `ITEM_DROP` is **unused** elsewhere) |
| 6 | `/data/patrons.json` | static | GET | boot | none | `data/index.ts:291-293` (Settings podium only) |
| 7 | `/data/<lang>/client_strings.js` | static, `import()` | GET | boot + lang change | none | `data/index.ts:319` |
| 8 | `/data/<lang>/items.ndjson` | static | GET | boot + lang change | none | `data/index.ts:158-160` |
| 9 | `/data/<lang>/items-name.index.bin` | static | GET | same | none | `:164-169` |
| 10 | `/data/<lang>/items-ref.index.bin` | static | GET | same | none | `:170-176` |
| 11 | `/data/<lang>/stats.ndjson` | static | GET | same | none | `:221-223` |
| 12 | `/data/<lang>/stats-ref.index.bin` | static | GET | same | none | `:227-232` |
| 13 | `/data/<lang>/stats-matcher.index.bin` | static | GET | same | none | `:233-239` |
| 14 | `/proxy/www.pathofexile.com/api/trade2/data/items` | GGG (always www, English "ref" data) | GET | boot (force), lang change, every 30 min if conditions hold, manual "reload" button (`ReloadTradeData.vue`) | try/catch → `error` ref | `TradeData.ts:102-108` |
| 15 | `/proxy/www.pathofexile.com/api/trade2/data/stats` | GGG | GET | same, in parallel with #14 | same | `TradeData.ts:52-58` |
| 16 | `/proxy/<poeWebApi()>/api/trade2/data/leagues` | GGG regional host (§8.7) | GET | `OverlayWindow` setup, retry button (`BackgroundInfo.vue:14`), settings | `!ok` → throws with the response headers JSON as the message → `error` | `Leagues.ts:52-56` |
| 17 | `/proxy/api.exiledexchange2.dev/proxy/data/item-drop.json` | EE2 author's poe.ninja mirror | GET | each price load | any throw aborts the whole price load | `Prices.ts:172-176` (value stored in `ITEM_DROP`, **unused**, but a failure blocks prices) |
| 18 | `/proxy/api.exiledexchange2.dev/proxy/data/namespaceMap.json` | same | GET | each price load | same | `Prices.ts:191-198` |
| 19 | `/proxy/api.exiledexchange2.dev/proxy/<leagueId>/overviewData.json` | same | GET | each price load | same | `Prices.ts:199-205`. `<leagueId>` = `"standard"` for `Standard`, `"hardcore"` for `Hardcore`, otherwise the **raw trade league id** (spaces → `%20` by fetch; the proxy must forward the encoded path) |
| 20 | `/uploads/<name>` | backend | POST | image-strip only | | `IPC.ts:75-79` (DROP) |
| 21 | `ws://<location.host>/events` | backend | WS | boot | Sockette reconnect | `IPC.ts:25` |

Static asset URLs referenced from code and CSS (served from `public/` or hashed in `assets/`): `/icon.ico` (`index.html:8`),
`/images/exa.png`, `/images/chaos.png`, `/images/div.png` (`Prices.ts:93,100,109`), `/images/divine.png` (`PriceCheckWindow.vue:42`),
`/images/jeweler.png` (`LoadingAnimation.vue:58`), etc. **Absolute paths**, so the app must live at origin root.

### 6.2 Elsewhere in the kept renderer (for completeness, details in other notes)

- `/proxy/<poeWebApi()>/api/trade2/search/<leagueId>` POST JSON (`price-check/trade/pathofexile-trade.ts:1271-1281`)
- `/proxy/<poeWebApi()>/api/trade2/fetch/<id,id,...>?query=<queryId>` GET (`pathofexile-trade.ts:1315-1317`)
- `/proxy/<poeWebApi()>/api/trade2/exchange/<leagueId>` POST JSON (`price-check/trade/pathofexile-bulk.ts:78-88`)
- `/proxy/www.poeprices.info/api?<query>` GET, `/proxy/www.poeprices.info/send_feedback` POST (`price-check/price-prediction/poeprices.ts:42,118`)
- Direct (not proxied) image loads from `https://web.poecdn.com/...` (item icons in `items.ndjson` and trade results). QtWebEngine needs normal internet access.
- `window.open(...)` external links: `https://www.poe2wiki.net/wiki/<refName>`, `https://poe2db.tw/<lang>/<path>`,
  `https://craftofexile.com/?game=poe2&eimport=<raw item>` (`item-check/hotkeyable-actions.ts:115-127`), trade site links
  `https://<poeWebApi()>/trade2/search/poe2/<league>?q=<json>` (`CheckedItem.vue`, `TradeLinks.vue:59`), poe.ninja item pages
  `https://poe.ninja/poe2/economy/<ninjaLeague>/<url>/<detailsId>` (`Prices.ts:287`, opened by `trends/PriceTrend.vue:245`), plus `<a target="_blank">`.
  Electron opened these in the system browser (`setWindowOpenHandler` → `shell.openExternal`, `M/windowing/OverlayWindow.ts:71-74`). **The Qt host must do the same**:
  override `QWebEnginePage::createWindow`/`acceptNavigationRequest` (for `NavigationTypeLinkClicked` with new-window targets) → `xdg-open`, or send it to the backend.

---

## 7. Background services

All are `createGlobalState` singletons (`@vueuse/core`), instantiated lazily on first use.

### 7.1 Leagues: `R/src/web/background/Leagues.ts`

- State: `isLoading`, `error: string|null`, `tradeLeagues: {id,isPopular,text}[]`.
- `selectedId` (`:26-33`): getter returns `AppConfig().leagueId` **only when the leagues list is loaded** (else `undefined`). The setter writes `AppConfig().leagueId`.
- `selected` (`:35-44`): `{id: leagueId, realm: AppConfig().realm, isPopular: !isPrivateLeague(id) && listed?.isPopular}`.
- `load()` (`:46-79`): GET `${poeWebApi()}/api/trade2/data/leagues` via the proxy (comment: should become `/api/leagues?realm=poe2` later).
  Response `{result: [{id, text}]}`. Every league gets `isPopular: true`. If the stored `leagueId` is not in the list and is not private:
  pick `result[2]` (comment `TMP_CHALLENGE`) when there are more than 2 leagues, else `result[0]` (Standard). Errors → `error = message`.
- `isPrivateLeague(id)` (`:91-96`): contains `"Ruthless"` or matches `/\(PL\d+\)$/`.
- Consumers: `PriceCheckWindow` (title = league id, `isLeagueSelected` gates `CheckedItem`, so **no league = no price check results**),
  `CheckedItem`, `BackgroundInfo` (loading/error box with Retry), `settings-price-check.vue` (dropdown), `poeprices.ts`, `Prices.ts`.

### 7.2 Prices (poe.ninja via api.exiledexchange2.dev): `R/src/web/background/Prices.ts`

- Constants (`:62-64`): `RETRY_INTERVAL_MS = 4 min`, `UPDATE_INTERVAL_MS = 31 min`, `INTEREST_SPAN_MS = 20 min`.
- Core currencies (`:86-110`): `exalted` (ex, ref "Exalted Orb", `/images/exa.png`), `chaos` (c, "Chaos Orb", `/images/chaos.png`). `DivCurrency` = "Divine Orb", `/images/div.png`.
- `load(force=false)` (`:158-238`):
  - Return immediately unless `leagues.selected` exists, `isPopular`, and `realm === "pc-ggg"` (so **no prices for Garena or private leagues**).
  - Unless `force`: return if the last update was < 31 min ago or the last interest was > 20 min ago.
  - Abort any in-flight download. Fetch #17 (item-drop, unused), set `availableCoreCurrencies` with translated names via
    `ITEM_BY_REF("ITEM", ref)![0].name` (needs the data files loaded), and reset `coreCurrency` to `exalted` if it is unavailable. Fetch #18 (`namespaceMap.json`,
    `{schemaVersion:1, map:[{ns:"ITEM"|"GEM"|"UNIQUE", cx:boolean, url, type}]}`) and #19 (`overviewData.json`, kept as a text blob).
  - `parseXchg(blob)` (`:471-477`) extracts the first `{"rates":...}` object (`{rates: Record<string,number>, primary, secondary}`).
    `splitJsonBlob` (`:479-522`) splits the blob at every `{"type":"` and keeps sections whose type is in the namespace map.
  - Exchange rate: if any rate is >= 10, use `rates[preferred]` when >= 5, else `rates.exalted`. This sets `xchgRate` (core per divine) and `xchgRateCurrency`.
  - Clear the price cache and set `lastUpdateTime`. Errors → `console.warn` only.
- `queuePricesFetch()` (`:240-243`): sets interest, then `load()`. Called on every successful price-check parse (`PriceCheckWindow.vue:301-303`).
- `selectedLeagueToUrl(proxy)` (`:245-262`): Standard → `standard`, Hardcore → `hardcore`, otherwise the raw id for the proxy. For poe.ninja links:
  lowercase with spaces removed, and an `hc` prefix becomes an `hc` suffix.
- `findPriceByQuery({ns,name,variant})` (`:264-291`): string search in the blob. `autoCurrency`, `cachedCurrencyByQuery`, `toDivine`, `addPrice`, `subtractPrice`, `comparePrice` are pure math.
- Timers and watchers: `setInterval(load, 4 min)` (`:436-438`). `watch(leagues.selectedId)` → reset, then `load(true)` (`:440-444`). This fires once at startup when
  the leagues list arrives. `watch(selectedCoreCurrencyId)` → reset, then `load(true)` (`:446-452`).
- `displayRounding()` (`:524-567`): formatting helper using hair spaces ` `.
- Note: `api.exiledexchange2.dev` is the upstream EE2 author's server ("me :)" in `M/proxy.ts:17`). OmaExiled depends on it for every price. Consider whether to keep it or
  query poe.ninja directly (it is in the allow-list but unused by this code). See Open questions.

### 7.3 Trade data (GGG stats/items, English): `R/src/web/background/TradeData.ts`

- Constants (`:6-8`): `RETRY_INTERVAL_MS = 30 min`, `UPDATE_INTERVAL_MS = 2 h`, `INTEREST_SPAN_MS = 60 min`.
- `load(force)` (`:137-187`): unless forced, only if the last update was >= 2 h ago and interest was within 60 min. In parallel: items (#14) → `Set` of every `type`
  and `text`. Stats (#15) → `Map<matcherText, {[modType]: statId[]}>` and a `Set<statId>`. **"Don't regress"**: only replace the data if both
  new counts are greater than the old ones (`:166-171`). Returns `{foundItems, foundStats}` (the count deltas). Errors → `error` and `console.warn`.
- `expressInterest()` (`:189-191`) is called by `TRADE_ITEM_BY_REF`, `TRADE_STAT_BY_STAT_ID`, `TRADE_STAT_BY_MATCH_STR` (`data/index.ts:525-617`).
- `setInterval(load, 30 min)` (`:194-196`).
- Boot coupling (`data/index.ts:517-523`): `loadTradeData()` awaits `trade.load(true)`. **If that first load errors, it returns before assigning
  `TRADE_ITEM_BY_REF` / `TRADE_STAT_BY_STAT_ID` / `TRADE_STAT_BY_MATCH_STR`**. These fallbacks (for items and stats not in the bundled data) then stay
  disabled until the next language change or app restart, even if the "reload trade data" button later succeeds. So the backend proxy must be up before the renderer boots.

---

## 8. Config

### 8.1 Persistence (EE2 backend: `M/host-files/ConfigStore.ts`)

- Path: `<app.getPath("userData")>/apt-data/config.json` (`:8-12`). On Linux, userData = `~/.config/<app name>`. Dev/unpackaged:
  `~/.config/exiled-exchange-2/`. Packaged with `productName`: `~/.config/Exiled Exchange 2/`.
  **This machine has `~/.config/exiled-exchange-2/apt-data/config.json`** (configVersion 34, language en, leagueId "Runes of Aldur",
  `hideOverlayOnBlur: null`, all 11 default widgets, `price-check` with leftover keys `autoFillEmptyRuneSockets` and `openItemEditorAbove`). It is a candidate for a one-time import.
- `load()` returns the raw text or `null` (`:24-30`).
- `save(contents, tmp)` (`:32-45`): when `isTemporary` is true and not already in tmp mode, the path becomes `config.json.tmp` **for the rest of the process**
  (later loads and saves use it too). The original file is never overwritten after a corrupt or incompatible load. `mkdir -p`. On write failure, `app.exit(1)`.
  In dev (`VITE_DEV_SERVER_URL` set), saving is skipped entirely, but `config-changed` is still broadcast.
- The backend writes `contents` verbatim (a compact `JSON.stringify` string). No atomic write in EE2. OmaExiled should write a temp file and rename it.
- OmaExiled suggestion: `${XDG_CONFIG_HOME:-~/.config}/omaexiled/config.json`, with an optional first-run import from the EE2 path above.

### 8.2 Renderer-side lifecycle (`R/src/web/Config.ts`)

| Function | Lines | Behavior |
|---|---|---|
| `AppConfig()` / `AppConfig(type)` | 15-23 | Whole config, or the **first** widget with `wmType === type` (undefined if none). |
| `updateConfig(updates)` | 25-28 | `_config = reactive(deepClone(updates))`. Sets the root font-size. Replaces the whole object, so all views re-render. |
| `saveConfig({isTemporary})` | 30-50 | **Returns early if any widget has `wmZorder === "exclusive" && wmWants === "show"`.** Otherwise sends `save-config` only if it is not deep-equal to `_lastSavedConfig`. `_lastSavedConfig` starts `null`, so the first save always sends. |
| `pushHostConfig()` | 52-57 | Sends `update-host-config` with `getConfigForHost()`. |
| `initConfig()` | 59-89 | Subscribes to `config-changed` (sets `_lastSavedConfig` and `updateConfig`). `contents` null → `updateConfig(defaultConfig())` (**not saved** until the first `saveConfig`). Parse error → defaults plus a temporary save (crash, see §2.1). Otherwise `updateConfig(upgradeConfig(parsed))`. **Migrated config is not saved immediately** (only on the next save trigger). |
| `poeWebApi()` | 91-116 | Trade host (§8.7). |

Save triggers in EE2:
1. `window` `blur` → `saveConfig()` (`OverlayWindow.vue:114-118`).
2. The topmost/exclusive widget changes away from an exclusive non-settings widget (price-check/item-check closing) → `saveConfig()` (`OverlayWindow.vue:312-326`).
3. Settings **Save** → `updateConfig(clone); saveConfig(); pushHostConfig(); wm.hide(settings)` (`SettingsWindow.vue:299-305`). **But** the clone was taken while
   the settings widget was shown (`SettingsWindow.vue:203-210`), so it contains `settings.wmWants === "show"` (exclusive), and `saveConfig()` returns early.
   The actual write happens later through trigger 1. In OmaExiled's separate, focusable settings window, trigger 1 only fires when that window loses focus. In the no-focus panel it may never fire.
   **Patch**: in the settings save path, hide first and then save, or call a `saveConfig({force:true})` that skips the exclusive check.

### 8.3 Top-level keys (`interface Config` `:127-157`, `defaultConfig()` `:159-233`)

| Key | Type | Default | Used by | Trimmed app |
|---|---|---|---|---|
| `configVersion` | number | `35` | `upgradeConfig` | KEEP |
| `leagueId` | string? | (absent) | Leagues, price check, poeprices | KEEP |
| `overlayKey` | string | `"Shift + Space"` | HostConfig `toggle-overlay`, settings hotkeys (required), hint texts (`OverlayWindow.vue:46-48`, price-check browser hint) | ADAPT (repurpose, e.g. "focus panel / toggle interactivity", or drop) |
| `overlayBackground` | string | `"rgba(129, 139, 149, 0.15)"` | full-screen dim layer when the overlay is active (`OverlayWindow.vue:8-12,367-370`) | DROP (no full-screen overlay) |
| `overlayBackgroundClose` | boolean | `true` | background click → focus-game | DROP |
| `overlayAlwaysClose` | boolean | `false` | background or close button always → `focus-game` | DROP or ADAPT |
| `hideOverlayOnBlur` | boolean | `false` | HostConfig → hide the Electron window on game blur | DROP (OmaExiled hides surfaces itself) |
| `restoreClipboard` | boolean | `false` | HostConfig → restore the clipboard after copy/paste | KEEP |
| `showAttachNotification` | boolean | `true` | "app ready" toast | DROP (or a notify-send when PoE2 is detected) |
| `commands` | `{text, hotkey: string\|null, send: boolean}[]` | 6 entries: `/hideout`(F5, send), `/exit`(F9, send), `@last ty`, `/invite @last`, `/tradewith @last`, `/hideout @last` (hotkey null, send true) | HostConfig `paste-in-chat`, settings/chat.vue | **KEEP** (chat macros) |
| `clientLog` | string\|null | `null` | HostConfig, settings general/leveling | DROP |
| `gameConfig` | string\|null | `null` | HostConfig → reads `poe2_production_Config.ini` for `show_advanced_item_descriptions` (default Alt) → copy combo `Ctrl + <showModsKey> + C` | OPTIONAL KEEP (OmaExiled hard-codes Ctrl+Alt+C. Keep it if the copy combo should follow the game's key). Proton path guess: `~/.local/share/Steam/steamapps/compatdata/2694490/pfx/drive_c/users/steamuser/Documents/My Games/Path of Exile 2/poe2_production_Config.ini` (`M/host-files/GameConfig.ts:10-36`) |
| `windowTitle` | string | `"Path of Exile 2"` | HostConfig → game window match | KEEP (match the Hyprland window title. Class is typically `steam_app_2694490` under Proton, see the Hyprland notes) |
| `logKeys` | boolean | `false` | HostConfig debug logging. Shows the overlay log when not active. | KEEP (debug) |
| `accountName` | string | `""` | trade listing highlight (`trade-api.ts`, `bulk-api.ts`) | KEEP |
| `stashScroll` | boolean | `true` | HostConfig → Ctrl+wheel stash-tab scrolling (uiohook) | OPTIONAL (not in scope. Hyprland `bind = CTRL, mouse_down/up` could emulate it) |
| `language` | `"en"\|"ru"\|"cmn-Hant"\|"ko"\|"ja"\|"de"\|"es"\|"pt"\|"fr"` | `"en"` | i18n, data files, trade host, poe2db links. HostConfig (EE2 uses it only for OCR). | KEEP |
| `preferredTradeSite` | `"default"\|"www"` | `"default"` | `poeWebApi()`, CheckedItem | KEEP |
| `realm` | `"pc-ggg"\|"pc-garena"` | `"pc-ggg"` | `poeWebApi()` (cmn-Hant), Prices gate | KEEP |
| `widgets` | `Widget[]` | registry defaults (§8.4) | everything | KEEP (trimmed) |
| `fontSize` | number | `16` | root rem | KEEP (affects panel size) |
| `enableAlphas` | boolean | `false` | library alpha | DROP |
| `alphas` | `Array<"library">` | `[]` | library alpha | DROP |
| `tipsFrequency` | `TipsFrequency` enum 1..6 (`Always=1, MoreOften=2, Normal=3, Rarely=4, VeryRarely=5, Never=6`, `:118-125`) | `3` (Normal). Migration v29 sets `6` (Never). | price-check tips (`CheckedItem.vue:302-305`), settings/help.vue | KEEP |
| `readClientLog` | boolean | `false` | HostConfig, XP tracker | DROP |
| Legacy keys created or removed by migrations | `itemCheckKey`, `mapCheckKey`, `priceCheckKey`, `priceCheckKeyHold`, `priceCheckLocked`, `showSeller`, `searchStatRange`, `priceCheckShowCursor`, `wikiKey`, `craftOfExileKey`, `delveGridKey`, `logLevel` | only read during migration | - | ignore |

### 8.4 Widgets

Base fields (`overlay/widgets.ts:1-8`): `wmId: number`, `wmType: string`, `wmTitle: string` (may be `"{icon=fa-xxx} title"`, parsed by `WidgetMenu.vue`),
`wmWants: "show"|"hide"`, `wmZorder: number | "exclusive" | null`, `wmFlags: string[]`.
Well-known flags (`:18-25`): `uninitialized` (new multi-instance widget, initialised by its component), `menu::skip` (hidden from the widget menu),
`has-browser` (price-check built-in browser open), `invisible-on-blur` (invisible while the overlay is inactive), `hide-on-blur` (hidden (`wmWants="hide"`) when focus-change reports
`overlay:false`), `hide-on-focus` (hidden when the overlay becomes active), `ignore-ui-visibility` (still visible when `visibility.isVisible=false`).
Dynamic flag: `settings::widget=<wmId>` (opens settings on that widget's page, `SettingsWindow.vue:227-242`).
`wmZorder`: `"exclusive"` = at most one shown at a time, takes over the screen. Showing a widget hides the current exclusive one. Numeric = stacking. `null` = never shown yet.
Visibility rules: `OverlayWindow.vue:249-273`.

Default widgets in registry order (`overlay/widget-registry.ts:26-39`). `wmId` is assigned sequentially (`Config.ts:210-228`):

| wmId | wmType | Component | Defaults (beyond base) | Base defaults | Trimmed |
|---|---|---|---|---|---|
| 1 | `menu` | `overlay/WidgetMenu.vue:86-105` | `anchor {pos:"tl",x:5,y:5}`, `alwaysShow:false` | title `""`, show, zorder `1`, flags `invisible-on-blur, menu::skip` | **KEEP entry** (z-order invariant §2.3). Component optional (it has a paste-item textarea, handy for debugging). |
| 2 | `settings` | `settings/SettingsWindow.vue:168-181` | - | title `{icon=fa-cog}`, hide, `exclusive`, flags `invisible-on-blur, ignore-ui-visibility` | KEEP (rendered in the separate settings window) |
| 3 | `item-search` | `item-search/WidgetItemSearch.vue:145-164` | `anchor {tl,10,20}`, `ocrGemsKey:null` | `{icon=fa-search}`, hide, null, `invisible-on-blur` | DROP |
| 4 | `experience-tracker` | `leveling/WidgetXpTracker.vue:90-109` | `anchor {bc,68,98}`, `showExp:true` | `XP`, hide, null, `[]` | DROP |
| - | `timer` (multi, no defaults) | `stopwatch/WidgetTimer.vue:52-56` | (`anchor`, `toggleKey`, `resetKey`) | - | DROP |
| 5 | `stash-search` "Map rolling" | `stash-search/WidgetStashSearch.vue:41-62` | `anchor {tl,35,46}`, `enableHotkeys:true`, `entries`: `"Increased Pack Size"`, `"Additional Packs"`, `"Burning Ground"`, `"Less Recovery Rate"` (with quotes in `text`, ids 1-4, `name:""`, `hotkey:null`) | hide, null, `invisible-on-blur` | **KEEP config** (hotkeys come from `entries[].hotkey` when `enableHotkeys`). The UI widget is optional, but the editor (`stash-search/stash-search-editor.vue`) needs an entry point in settings. |
| 6 | `stash-search` "Dump sorting" | same `:63-89` | `anchor {tl,34,56}`, entries: `Currency`, `"Martial Weapon"`, `Jewel`, `"Waystone Tier"`, `"Rarity: Normal"`, `Trials:` | same | KEEP config |
| 7 | `price-check` | `price-check/PriceCheckWindow.vue:175-212` | see below | `""`, hide, `exclusive`, `hide-on-blur, menu::skip` (re-forced on every mount `:252-255`) | **KEEP** |
| 8 | `item-check` | `item-check/WidgetItemCheck.vue:20-56` | see below | `""`, hide, `exclusive`, `hide-on-blur, menu::skip` | **KEEP** |
| 9 | `image-strip` | `overlay/WidgetImageStrip.vue:75-97` | `anchor {tc,50,10}`, `images:[{id:1,url:"syndicate.jpg"}]` | `Cheat sheets`, hide, null, `invisible-on-blur` | DROP |
| 10 | `delve-grid` | `overlay/WidgetDelveGrid.vue:36-50` | `toggleKey:null` | `""`, hide, null, `hide-on-focus, menu::skip` | DROP |
| - | `notepad` (multi, no defaults) | `notepad/WidgetNotepad.vue:70-74` | (`anchor`, `notepadBody`, `notepadSize`) | - | DROP |
| 11 | `library` | `library/WidgetLibrary.vue:89-135` | `anchor {tl,20,20}`, `logItemKey:null`, `libraryOutputPath:null`, `selectedProfile:"chaos"`, `profiles.chaos` = column opts | `{icon=fa-book}`, hide, null, `invisible-on-blur, menu::skip` | DROP |

`price-check` widget fields (`overlay/widgets.ts:38-64`, defaults `PriceCheckWindow.vue:186-209`). All **KEEP** unless noted:
`hotkey:"D"`, `hotkeyHold:"Ctrl"` (hold-mode combo = `"Ctrl + D"`), `hotkeyLocked:"Ctrl + Alt + D"` (opens with `focusOverlay:true`),
`showSeller:false` (`false|"account"|"ign"`), `searchStatRange:10`, `showRateLimitState:false`, `apiLatencySeconds:2`, `collapseListings:"api"` (`"api"|"app"`),
`smartInitialSearch:true`, `lockedInitialSearch:true`, `activateStockFilter:false`, `showCursor:true` (position circle), `requestPricePrediction:false` (poeprices),
`builtinBrowser:false` (**DROP**: Electron `<webview>`, `vite.config.mts:19` registers `webview` as a custom element), `rememberCurrency:false`, `defaultAllSelected:false`,
`itemHoverTooltip:"keybind"` (`"off"|"keybind"|"always"`), `alwaysShowTier:false`, `coreCurrency:"exalted"` (`"exalted"|"chaos"`), `currencyVolume:"both"`
(`"none"|"value"|"item"|"both"`), `rememberListingType:false`, `initialDelay:48` (ms before the first clipboard poll, goes to HostConfig), `savedAugments:{}` (`{[key]: (string|null)[]}`, item editor).
Orphans written by migrations but unused: `chaosPriceThreshold` (v4/v10), `autoFillEmptyRuneSockets` (v22), `openItemEditorAbove` (v25).

`item-check` widget fields (`item-check/widget.ts:4-12`, defaults `WidgetItemCheck.vue:31-53`):
`hotkey:null` (**the task's "Alt+D" is not an EE2 default**. Set `"Alt + D"` in the OmaExiled default if desired), `wikiKey:null`, `poedbKey:null`,
`craftOfExileKey:null`, `stashSearchKey:null` (→ `search-similar`), `samePricedKey:null` (→ `search-same-priced`), `samePricedType:"both"` (`"price"|"both"`),
`maps: {profile:1, showNewStats:false, selectedStats:[{matcher:"#% maximum Player Resistances",decision:"w--"}, {matcher:"Monsters reflect #% of Physical Damage",decision:"d--"},
{matcher:"Monsters reflect #% of Elemental Damage",decision:"d--"}, {matcher:"Area contains two Unique Bosses",decision:"g--"}]}`. Decision strings are three chars (one per profile 1-3):
`d` danger, `w` warning, `g` good, `s` seen, `-` unset (`map-check/common.ts:25-57`). `maps` is used by `MapCheck` **inside item-check** for waystones, heist contracts/blueprints, invitations and logbooks
(`WidgetItemCheck.vue:9,113-127`). KEEP if Alt+D on a waystone should still show map-mod verdicts (see Open questions).

### 8.5 `upgradeConfig()` (`Config.ts:235-690`): every step

Runs on every load. Mutates in place. Steps are cumulative from the stored `configVersion`. "Hazard" = crashes or produces garbage if that widget is missing from the trimmed config or defaults.

| Cond | Lines | Changes | Hazard if widgets are trimmed |
|---|---|---|---|
| `< 3` | 241-257 | push `image-strip` and `delve-grid` defaults (`wmZorder:null`), `menu.alwaysShow=false` | spreads `undefined` (garbage widget) if not in defaults. `menu!` crash |
| `< 4` | 259-280 | `price-check.chaosPriceThreshold=0.05`. `map-check.selectedStats[].matcher=matchRef`. image-strip image ids | `map-check!` crash |
| `< 5` | 282-288 | every `commands[].send=true` | - |
| `< 6` | 290-297 | price-check `showRateLimitState = (logLevel==="debug")`, `apiLatencySeconds=2` | - |
| `< 7` | 299-308 | map-check → `item-check` with `maps.selectedStats`. `itemCheckKey=mapCheckKey` | `map-check!` |
| `< 8` | 310-327 | `item-check.maps.showNewStats=false`. Convert valueDanger/Warning/Desirable → decision | - |
| `< 9` | 329-344 | price-check `collapseListings="api"`, `smartInitialSearch=true`, `lockedInitialSearch=true`, `activateStockFilter=false` | - |
| `< 10` | 346-365 | push `settings` widget. Move `priceCheckKey/Hold/Locked`, `showSeller`, `searchStatRange`, `priceCheckShowCursor` into price-check. `chaosPriceThreshold 0.05→0` | - |
| `< 11` | 367-373 | `requestPricePrediction=false` | - |
| `< 12` | 375-391 | insert `item-search` (shown) after settings. `realm="pc-ggg"`. `zh_TW`→`cmn-Hant` | garbage entry if item-search is not in defaults |
| `< 13` | 393-397 | `showAttachNotification=true` | - |
| `< 14` | 399-420 | image-strip urls strip `app-file://`. item-check `wikiKey`, `poedbKey=null`, `craftOfExileKey`, `stashSearchKey=null` | - |
| `< 15` | 422-451 | price-check `builtinBrowser=false`. item-search `ocrGemsKey=null`. item-check `maps.profile=1` and decisions → `"x--"` | `item-search!` (would be undefined → crash) |
| `< 16` | 453-470 | `delve-grid.toggleKey=delveGridKey`. item-check `hotkey=itemCheckKey`. Reset maps if no profile | **`delve-grid` missing → crash** |
| `< 17` | 472-475 | no-op | - |
| `< 18` | 477-482 | `enableAlphas=false`, `alphas=[]`, `preferredTradeSite="default"` | - |
| `< 19` | 484-488 | `defaultAllSelected=false` | - |
| `< 21` | 490-497 | `itemHoverTooltip="keybind"`, `alphas=[]` (there is no v20 step) | - |
| always | 499-514 | `rememberCurrency ??= false` (price-check). Every stash-search `enableHotkeys ??= true`. `logKeys ??= false` | price-check must exist |
| `< 22` | 516-525 | `autoFillEmptyRuneSockets=false`, `tipsFrequency=Normal` | - |
| `< 23` | 527-558 | flag rename `skip-menu`→`menu::skip`. Strip `settings::*` flags from settings. item-search title `{icon=fa-search}`, settings `{icon=fa-cog}`. Sort settings first | `item-search` crash |
| `< 24` | 559-565 | `alwaysShowTier=false` | - |
| `< 25` | 566-573 | `openItemEditorAbove=false` (orphan) | - |
| `< 26` | 575-583 | remove `filter-generator` widgets | - |
| `< 27` | 584-593 | item-check `samePricedKey=null` | - |
| `< 28` | 594-603 | item-check `samePricedType="both"` | - |
| `< 29` | 604-628 | `splice(itemSearch.wmId, 0, experience-tracker default)` (**uses the wmId as an array index**, an EE2 quirk). `tipsFrequency=Never`. price-check `coreCurrency="exalted"`, `currencyVolume="both"`. `readClientLog=false` | `item-search` crash. Garbage entry |
| `< 30` | 630-642 | splice the `library` default at index `itemSearch.wmId` | same |
| `< 31` | 644-652 | `rememberListingType=false` | - |
| `< 32` | 654-662 | `initialDelay=48` | - |
| `< 33` | 664-674 | library `selectedProfile="chaos"`, `profiles.chaos.modOpts.generation=true`. **Sets configVersion to 34** (skips 33) | **`library` missing → crash** |
| `< 35` | 676-686 | price-check `savedAugments={}`. `hideOverlayOnBlur=false` | - |

Recommendation for OmaExiled:
- If importing an EE2 config, run the **unmodified** EE2 `upgradeConfig` against the full EE2 default set (keep the EE2 widget specs available to the migration code, or
  vendor a frozen copy of `defaultConfig().widgets` as JSON). Then **post-filter** widgets to the KEEP set (`menu`, `settings`, `stash-search*`, `price-check`, `item-check`), and set
  `configVersion` to an OmaExiled-owned number (e.g. start the OmaExiled migration chain at 100).
- Then add a sanitizer: drop unknown `wmType`s, guarantee exactly one each of `menu`/`settings`/`price-check`/`item-check`, and clamp `language` to the 9 supported codes.
- `OverlayWindow` renders `registry.getWidgetComponent(wmType)`. An unknown type gives `<component :is="undefined">` (a Vue warning, renders nothing), so leftover entries are not fatal by themselves.
  The hazards are the `!` dereferences in `upgradeConfig`/`getConfigForHost` and the z-order invariant.

### 8.6 `getConfigForHost()` → `HostConfig` (`Config.ts:692-843`, type `ipc/types.ts:1-16`)

Shortcut actions produced, in order (`ShortcutAction = {shortcut: string; keepModKeys?: true; action}`):

| # | Condition | `shortcut` | `action` | `keepModKeys` | Trimmed |
|---|---|---|---|---|---|
| 1 | `priceCheck.hotkey` | `` `${hotkeyHold} + ${hotkey}` `` (default `"Ctrl + D"`) | `{type:"copy-item", target:"price-check", focusOverlay:false}` | true | KEEP |
| 2 | `priceCheck.hotkeyLocked` | default `"Ctrl + Alt + D"` | `{type:"copy-item", target:"price-check", focusOverlay:true}` | - | KEEP |
| 3 | always | `config.overlayKey` | `{type:"toggle-overlay"}` | - | ADAPT/DROP |
| 4 | `itemCheck.wikiKey` | user | `{type:"copy-item", target:"open-wiki"}` | - | KEEP |
| 5 | `itemCheck.craftOfExileKey` | user | `copy-item` / `open-craft-of-exile` | - | KEEP |
| 6 | `itemCheck.poedbKey` | user | `copy-item` / `open-poedb` | - | KEEP |
| 7 | `itemCheck.stashSearchKey` | user | `copy-item` / `search-similar` (renderer then sends `user-action stash-search` with `JSON.stringify(item.info.name)`) | - | KEEP |
| 8 | `itemCheck.samePricedKey` | user | `copy-item` / `search-same-priced` (text = note, plus name when `samePricedType==="both"` and the combined length is < 51) | - | KEEP |
| 9 | `itemCheck.hotkey` | user (Alt+D desired) | `{type:"copy-item", target:"item-check", focusOverlay:true}` | - | KEEP |
| 10 | `library.logItemKey` | user | `copy-item` / `log-item` | true | DROP (**`AppConfig("library")` deref, `:751-758`, crash if missing**) |
| 11 | `delveGrid.toggleKey` | user | `{type:"trigger-event", target:"delve-grid"}` | true | DROP (**deref `:760-767`**) |
| 12 | each `commands[]` with `hotkey` | `command.hotkey` | `{type:"paste-in-chat", text, send}` | - | KEEP |
| 13 | each `stash-search` widget with `enableHotkeys`, each `entries[]` with `hotkey` | `entry.hotkey` | `{type:"stash-search", text: entry.text}` | - | KEEP |
| 14 | each `timer` widget | `toggleKey`, `resetKey` | `trigger-event` `stopwatch-start-stop:<wmId>` / `stopwatch-reset:<wmId>` | true | DROP |
| 15 | each `item-search` with `ocrGemsKey` | | `{type:"ocr-text", target:"heist-gems"}` | true | DROP |

Other `HostConfig` fields: `restoreClipboard` (KEEP), `clientLog` (DROP), `gameConfig` (OPTIONAL), `stashScroll` (OPTIONAL), `overlayKey` (ADAPT),
`logKeys` (KEEP), `windowTitle` (KEEP), `language` (not needed by the backend), `readClientLog` (DROP), `libraryAlpha` = `enableAlphas && alphas.includes("library")` (DROP),
`libraryOutputPath` = `library.libraryOutputPath` (**deref, `:839`**, DROP), `initialDelay` = `priceCheck.initialDelay` (KEEP), `hideOverlayOnBlur` (DROP).
`ShortcutAction` type `"test-only"` is backend-internal (EE2 registers `Ctrl + <showModsKey> + C` to probe for conflicts, `M/shortcuts/Shortcuts.ts:122-131`).
Backend validation in EE2 (`Shortcuts.ts:133-175`): shortcuts equal to game-reserved combos are rejected with a log error: `Ctrl + C`, `Ctrl + V`, `Ctrl + A`, `Ctrl + F`, `Ctrl + Enter`,
`Home`, `Delete`, `Enter`, `ArrowUp`, `ArrowRight`, `ArrowLeft`, and the copy combo. Duplicates are rejected (except `toggle-overlay`). Keep this logic in the Bun backend.
Shortcut string format: keys joined by `" + "`, modifiers first in the order produced by `hotkeyToString` (`Ctrl + Shift + Alt`, `Shift + Alt`, `Ctrl + Shift`, `Ctrl + Alt`, `Alt`, `Ctrl`, `Shift`). Key names come from `KeyToCode` (§11).

Patch: rewrite `getConfigForHost` to use optional chaining for every widget lookup (`AppConfig("library")?.logItemKey`), or drop those blocks. Alternatively the Bun backend computes the
same list directly from `config.json`, which makes it robust to backend restarts (§3.2).

### 8.7 `poeWebApi()` (`Config.ts:91-116`), the trade host

`preferredTradeSite === "www"` → `www.pathofexile.com`. Otherwise by `language`: en → `www.pathofexile.com`, ru → `ru.pathofexile.com`,
cmn-Hant → `pathofexile.tw` if `realm==="pc-garena"`, else `www.pathofexile.com`. ko → `poe.kakaogames.com`, ja → `jp.pathofexile.com`, de → `de.pathofexile.com`,
es → `es.pathofexile.com`, pt → `br.pathofexile.com`, fr → `fr.pathofexile.com`. The same table is duplicated in `settings/general.vue:180-203`.
Exported as `getTradeEndpoint` (`price-check/trade/common.ts:7`). Every returned host is in the proxy allow-list.

---

## 9. i18n and per-language data

### 9.1 `R/src/web/i18n.ts`

- `init(lang)` (`:6-23`): `createI18n({legacy:false, locale:"en", fallbackLocale:"en", fallbackFormat:true, fallbackWarn:false, missingWarn:false, messages:{en: <fetched>}})`.
  Then `loadLang(lang)`. Missing keys render the key text (`fallbackFormat`).
- `loadLang(lang)` (`:25-41`): if `lang !== "en"`, fetch `${BASE_URL}data/<lang>/app_i18n.json` and `setLocaleMessage`. Set the locale. **Clear the previous non-en locale's messages**
  (`setLocaleMessage(prev, {})`). Set `document.documentElement.lang`, then `await nextTick()`. Edge: calling `loadLang` with the current locale would wipe it. In practice the `watch` only fires on change.
- `useI18nNs(name)` (`:43-56`): `t(":key")` → `t("<name>.key")` (namespace shorthand used by settings and other components).
- Files: `R/public/data/<lang>/app_i18n.json` (en is about 23 KB, 47 top-level namespaces including ones for dropped features, which is harmless).

### 9.2 Languages

Selectable (`settings/general.vue:5-15`, `Config.language` type `:146`, `make-index-files.mjs:7`): `en` English, `ru` Русский, `cmn-Hant` 正體中文, `ko` 한국어, `ja` 日本語,
`de` Deutsch, `es` Español, `pt` Português (Brasil), `fr` Français. `R/public/data/th/` exists with **only** `app_i18n.json` (not selectable. Data files are missing, so selecting it would crash the boot).
Changing language away from `cmn-Hant` forces `realm="pc-ggg"` (`general.vue:172-178`).

### 9.3 Data files per language (`R/src/assets/data/index.ts`, `R/public/data/<lang>/`)

`app_i18n.json`, `client_strings.js` (ES module, `export default {...}`, loaded with `import(/* @vite-ignore */ ...)`, served as JavaScript), `items.ndjson`, `stats.ndjson`
(git-tracked), and `items-name.index.bin`, `items-ref.index.bin`, `stats-ref.index.bin`, `stats-matcher.index.bin` (**git-ignored**, `R/public/data/.gitignore: *.index.bin`,
generated by `R/src/assets/make-index-files.mjs`: sorted `Uint32Array` pairs `[fnv1a32(key), byteOffset]`. Keys: `"<namespace>::<name>"`, `"<namespace>::<refName>"`, `stat.ref`, `matcher.string`/`matcher.advanced`).
Sizes for en: items.ndjson 1.67 MB, stats.ndjson 0.9 MB, about 2.7 MB per language in total. `R/public/data` totals 25 MB (all languages), `R/public/images` 2.2 MB.
Shared: `R/public/data/item-drop.json` (+`.jsonc`), `patrons.json`. `CLIENT_STRINGS_REF` is always the `en` client strings (parser reference).

---

## 10. Build setup (rebuild the renderer standalone)

### 10.1 `R/package.json`

- `"type": "module"`. Scripts: `dev` = `vite`. `build` = `vue-tsc --noEmit && vite build`. `make-index-files` = `node src/assets/make-index-files.mjs`. `test` = `vitest`.
  `check-types`, `lint`, `format`. The user's `omarchy*` branches add `"prebuild": "npm run make-index-files"`. **Do that** so the `.bin` indexes always exist in `dist/`.
- Runtime deps: `@fortawesome/fontawesome-free 6.x`, `@sindresorhus/fnv1a ^3`, `@vueuse/core ^11` (11.3.0), `animate.css ^4.1.1`, `apexcharts ^4`, `dot-prop 9.x`,
  `fast-deep-equal ^3.1.3`, `fastest-levenshtein ^1.0.16`, `luxon 3.x`, `neverthrow ^8`, `object-hash ^3`, `sockette ^2.0.6`, `tailwindcss 3.x` (3.4.19),
  `tippy.js ^6.2.7`, **`vue 3.2.37` (pinned)**, `vue-i18n ^10.0.8`, `vue3-apexcharts ~1.1.1`, `vuedraggable 4.1.0` (image-strip only, droppable).
- Dev deps: `vite ^5` (5.4.21), `@vitejs/plugin-vue ^4.6.2`, `typescript 5.6.x`, `vue-tsc ^2` (2.2.12), `postcss ^8`, `autoprefixer ^10`, `vitest ^4`, `vite-tsconfig-paths`,
  `vitest-mock-extended`, `@vitest/coverage-v8`, `node-fetch` (tests), `prettier 3.4.2`, `eslint-config-prettier`, `@types/*`. Optional: eslint and its plugins.
- PostCSS config lives **inside package.json** (`"postcss": {"plugins": {"tailwindcss/nesting":{}, "tailwindcss":{}, "autoprefixer":{}}}`). `browserslist: ["chrome >= 101"]`.
  There is no separate `postcss.config.*`. If you move it, keep `tailwindcss/nesting` first (App.vue and component styles use nested rules and `@apply`).
- `allowScripts: {"esbuild@0.21.5": true}` (npm install-scripts allow-list).

### 10.2 `R/vite.config.mts`

- `build: {target:"esnext", assetsInlineLimit:0, sourcemap:true}`. `optimizeDeps.esbuildOptions.target = "esnext"`.
- `plugins: [vue({template:{compilerOptions:{isCustomElement: tag => tag === "webview"}}})]` (remove with the built-in browser).
- `resolve.alias`: `"@"` → `./src`, **`"@ipc"` → `./src/../../ipc`** (i.e. `<repo>/ipc`, **outside** the renderer dir), `"@specs"` → `./specs`.
  `resolve.extensions: [".ts",".js",".vue",".json"]`. In OmaExiled, put the shared `ipc/` (types + KeyToCode) where both the Bun backend and the renderer can import it, and update the
  alias and `tsconfig.json` `paths` (`"@ipc/*": ["../ipc/*"]`).
- `define: {"import.meta.vitest": "undefined"}` (in-source tests in parser files are stripped).
- `server.proxy` (dev only): `"^/(config|uploads|proxy)"` → `http://127.0.0.1:8584`, `"/events"` → ws `http://127.0.0.1:8584`. Dev flow: backend on 8584, `vite` on 5173, host loads `http://localhost:5173`.
- No `base` → `"/"`. `import.meta.env.BASE_URL` = `"/"`. Many paths are hard-coded absolute (`/images/...`, `/icon.ico`), so **do not change the base**. No `.env` files and no `VITE_*` vars are read
  (only `BASE_URL` and `DEV`). `__dirname` in an `.mts` works because Vite bundles the config.
- Output (`R/dist/`): `index.html`, `assets/index-<hash>.js|css`, hashed fonts (Fontin, FrizQuadrata, Exo2, FontAwesome), and a copy of `public/` (`data/`, `images/`, `icon.ico`, `icon.png`). About 30 MB.
  EE2's electron-builder copies `../renderer/dist` next to `main.js` and serves it from `__dirname` (`main/electron-builder.yml`).

### 10.3 Other config files

- `R/tsconfig.json`: `target/module esnext`, `strict`, `moduleResolution: node`, `isolatedModules`, `allowJs`, `useDefineForClassFields`, `paths` (above), `types: ["vite/client","vitest/importMeta"]`,
  `lib: [esnext, dom, dom.iterable]`, includes `src/**` and `specs/**`. References `tsconfig.node.json` (which includes `vite.config.ts`, a stale name; harmless).
- `R/tailwind.config.js`: `content: ["./src/**/*.{ts,vue}"]`. Custom **replacement** palette (`theme.colors`, not `extend`): `transparent`, `current`, `black`, `white`, `fire #c80000`,
  `cold #5aadff`, `lightning #ffff00`, `normal #c8c8c8`, `magic #8888ff`, `rare #ffff77`, `unique #af6025`, plus 100-900 scales for gray, red, orange, yellow, green, teal, blue, indigo,
  purple, pink, rose, fuchsia, slate (old Tailwind 1 values). Uses `module.exports` inside a `"type":"module"` package. This works because Tailwind loads configs through jiti. Rename to `.cjs` if a tool complains.
- `R/src/assets/font.css`: `@font-face` for `FontinSmallCaps` (`./font/Fontin-SmallCaps-Hinted.ttf`), `Fontin` regular/italic/bold, `FrizQuadrataC` (Cyrillic `U+400-4FF`), `Exo2` 400/500/600.
  Classes `.font-poe` (Fontin, FrizQuadrataC), `.font-poe-sc` (FontinSmallCaps, FrizQuadrataC), `.font-exo2`. Fonts are bundled, so no system fonts are needed. CJK text falls back to system fonts (install `noto-fonts-cjk` for ko/ja/cmn-Hant).
- `R/index.html`: `<meta name="color-scheme" content="dark">`, title "Exiled Exchange 2", `<div id="app">`, `<script type="module" src="/src/main.ts">`.
- `R/vitest.config.ts`: `vite-tsconfig-paths`, `globals`, `setupFiles: ./specs/vitest.setup.ts`, alias `@/assets/data/en` → `./src/parser/en`.

### 10.4 Standalone rebuild recipe (OmaExiled)

```
# copy renderer/ (minus node_modules, dist) and ipc/ into the OmaExiled tree; fix the @ipc alias + tsconfig paths
cd <oma>/renderer
bun install            # or npm ci (package-lock.json exists)
node src/assets/make-index-files.mjs   # or: bun src/assets/make-index-files.mjs  -> public/data/*/*.index.bin
npx vue-tsc --noEmit && npx vite build # or: bunx --bun vite build (Node is safer for vite 5 / vue-tsc)
# serve dist/ at "/" from the Bun backend
```

---

## 11. `ipc/KeyToCode.ts` and mapping shortcuts to Hyprland

- `KeyToCode` (`:1-109`): key name → Windows virtual-key code. Names: `Backspace, Tab, Enter, Shift, Ctrl, Alt, CapsLock, Escape, Space, PageUp, PageDown, End, Home,
  ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Insert, Delete, 0-9, A-Z, Numpad0-9, NumpadMultiply, NumpadAdd, NumpadSubtract, NumpadDecimal, NumpadDivide, F1-F24,
  Semicolon, Equal, Comma, Minus, Period, Slash, Backquote, BracketLeft, Backslash, BracketRight, Quote`. These are the **only key names the settings hotkey recorder produces**
  (renderer `settings/HotkeyInput.vue` uses this table).
- `CodeToKey` (`:111-113`): the reverse. Used by `M/host-files/GameConfig.ts` to parse `poe2_production_Config.ini` key codes.
- `KeyToElectron` (`:115-225`): Electron accelerator names. Replace with a Hyprland mapping in the backend.
- `hotkeyToString(keys, ctrl, shift, alt)` (`:227-245`), `mergeTwoHotkeys(a,b)` (`:247-252`), `isModKey(k)` (`:254-260`, Ctrl/Shift/Alt only). Super/Meta are not supported.

Suggested EE2 key name → Hyprland/xkb keysym (verify against `xkbcli`/`wev`). Consider `code:<keycode>` binds for layout independence:
`Backspace→BackSpace, Tab→Tab, Enter→Return, CapsLock→Caps_Lock, Escape→Escape, Space→space, PageUp→Prior, PageDown→Next, End→End, Home→Home,
ArrowLeft→Left, ArrowUp→Up, ArrowRight→Right, ArrowDown→Down, Insert→Insert, Delete→Delete, 0-9→0-9, A-Z→a-z, Numpad0-9→KP_0-KP_9, NumpadMultiply→KP_Multiply,
NumpadAdd→KP_Add, NumpadSubtract→KP_Subtract, NumpadDecimal→KP_Decimal, NumpadDivide→KP_Divide, F1-F24→F1-F24, Semicolon→semicolon, Equal→equal, Comma→comma,
Minus→minus, Period→period, Slash→slash, Backquote→grave, BracketLeft→bracketleft, Backslash→backslash, BracketRight→bracketright, Quote→apostrophe`.
Modifiers: `Ctrl→CTRL, Alt→ALT, Shift→SHIFT`. Example: `"Ctrl + Alt + D"` → `bind = CTRL ALT, D, ...`.

---

## 12. Required renderer patches / port checklist

1. `IPC.ts`: replace the `isElectron` UA sniff with an explicit host-mode flag. Decide per row of §3.3. Optionally add a client role to the WS URL. Optionally queue `sendEvent` while disconnected.
2. `main.ts`: call `Host.init()` before `initConfig()`, or have the backend sanitize config, to avoid the corrupt-config crash. Consider making `Data.init`'s trade-data load non-blocking.
3. `Config.ts`: `getConfigForHost` with optional chaining (no library/delve/timer/item-search). A new trimmed `defaultConfig` (keep `menu` and `settings` entries). An OmaExiled
   `upgradeConfig` (import, filter, sanitize, §8.5). Fix `saveConfig` gating for the settings-window save (§8.2). Optionally set item-check `hotkey: "Alt + D"`.
4. `OverlayWindow.vue`: drop `useClientLog`/`game-log`. Add the `wasActive` guard to `focus-change`. `poePanelWidth = 0`. Add a settings-window mode (mount `SettingsWindow` full-window, skip the poe.ninja/league timers where possible).
   Keep `render-state` meaningful for map/unmap of the layer surface.
5. `widget-registry.ts`: register only menu (optional), settings, stash-search (optional UI), price-check, item-check. `SettingsWindow.vue` `menuByType`: remove leveling, stopwatch, item-search, library.
   Add a stash-search entries editor entry point. Remove the "map_check.name" duplicate and delve-grid rows in `settings/hotkeys.vue:81-92`. Trim `settings/general.vue` (§8.3).
6. Price-check/item-check geometry: replace `window.screenX`/`innerWidth` side logic with a backend-provided side or panel-relative position. Remove `<webview>`/built-in browser (`builtinBrowser`, `has-browser`, `vite.config.mts:19`).
7. External links: the Qt host must route `window.open` and `target=_blank` to `xdg-open`.
8. Backend `/config` → `HostState` with an OmaExiled version and a static updater state. `/events` with role-aware `item-text` routing. `/proxy` per §5.1, with timeouts.
9. Build: add `prebuild: make-index-files`. Relocate the `@ipc` alias.

---

## 13. System prerequisites on this machine (what to install)

Checked on this machine (2026-10-30, read-only):

| Tool / package | Status | Needed for |
|---|---|---|
| `bun` 1.4.3 (`/usr/bin/bun`, pacman `bun`) | installed | backend, `bun install` |
| `node` (mise v26.8.1 first in PATH; also `/usr/bin/node` from `nodejs-lts-iron` 20.20.2; fnm shells) / `npm` | installed | Vite 5 / vue-tsc / make-index-files (Bun can also run them) |
| `g++` 16.2.1, `pkgconf` | installed | Qt host |
| **`cmake`** | **MISSING** | building the Qt6 C++ host → `sudo pacman -S cmake` |
| `ninja` | missing (optional) | faster CMake builds → `sudo pacman -S ninja` (or use Make) |
| `qt6-base` 6.12.0, `qt6-declarative` 6.12.0, `qt6-wayland` 6.12.0, `qt6-webchannel` 6.12.0 | installed | Qt host |
| `qt6-webengine` **6.11.2-2** | installed (this is the current repo version) | Qt host. It is one minor version behind qt6-base 6.12. Smoke-test a minimal QtWebEngine window before building on it. |
| `layer-shell-qt` 6.8.1 (CMake `LayerShellQt`, needs Qt6Gui >= 6.11) | installed | layer-shell overlay surfaces |
| `wl-clipboard` 2.3.0 (`wl-copy`/`wl-paste`) | installed | clipboard |
| `hyprctl`, `jq` | installed | Hyprland integration |
| CJK fonts (`noto-fonts-cjk`) | not checked | only if using ko/ja/cmn-Hant UI |

So the only hard requirement missing is **`cmake`** (`sudo pacman -S cmake ninja`).

---

## 14. Open questions

1. Overlay-mode semantics: should the panel auto-close when the cursor moves away (EE2 `track-area` → `hide-exclusive-widget`, needs cursor polling), on game focus loss (`focus-change`), on Escape (needs a temporary Hyprland bind), or only by the close button?
2. Should "map check" inside item-check (waystones/contracts → `MapCheck` with `item-check.maps`) be kept, given "map check" is listed as dropped?
3. Keep depending on `api.exiledexchange2.dev` (the upstream author's server) for poe.ninja prices, or fetch poe.ninja directly?
4. What should `overlayKey` (Shift+Space) do in OmaExiled: toggle keyboard focus to the panel, open settings, or nothing?
5. Should the settings window be a separate full renderer instance (duplicate data loads and network polling) or a lightweight mode that skips background services?
6. Import the existing EE2 config from `~/.config/exiled-exchange-2/apt-data/config.json` on first run?
7. Should the backend compute HostConfig from `config.json` itself (robust to restarts) instead of relying on `update-host-config` pushes?
8. Cloudflare/UA policy for proxied pathofexile.com requests without a browser cookie jar. Is a plain Bun `fetch` with a descriptive UA accepted reliably?
