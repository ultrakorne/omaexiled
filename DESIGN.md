# OmaExiled design

OmaExiled is a native Omarchy (Arch + Hyprland + omarchy-shell) port of the
price-check part of [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2)
(EE2), itself a fork of Awakened PoE Trade. It keeps EE2's parser, filters,
trade API client and Vue UI, and replaces Electron with Wayland-native pieces.

`docs/port-notes/` maps every EE2 subsystem this port depends on; read the
matching note before changing an area.

## Scope

Ported from EE2:

- price check (parser, all filters, presets, item editor, trade search and
  bulk exchange, prices, trends, related items, rate limiting)
- item check (Alt+D)
- stash search hotkeys
- chat command macros (F5 `/hideout`, F9 `/exit`, `@last ty`, `/invite @last`,
  `/tradewith @last`, `/hideout @last`)
- the settings those features need (league, realm, language, font size,
  hotkeys, price-check, item-check, chat, stash search)
- the tray menu, as an Omarchy bar widget

Not ported: stopwatch, notepad, leveling, map check, image strip, delve grid,
item search, updater, heist gem finder, everything else that is not used by
the features above.

## Why this stack

PoE2 runs under Proton as a fullscreen XWayland client. EE2 on Linux puts a
game-sized XWayland override-redirect Electron window on top and toggles
click-through. On Hyprland that window does not stay above a fullscreen
client, and pointer input only returns after an Electron `globalShortcut`
(see `docs/port-notes/02-main-process.md` and the user's `omarchy*` branches).

A wlr-layer-shell surface on the **overlay** layer is drawn above fullscreen
windows and takes pointer input natively inside its input region. Nothing has
to fake click-through: the parts of the surface outside the input region
simply do not receive input.

| Piece | Tech | Why |
|---|---|---|
| `renderer/` | EE2's Vue 3 app, trimmed | Faithful port: the parser, filters, trade client and UI are reused, not rewritten |
| `backend/` | Bun (TypeScript) | Replaces Electron main: HTTP + WebSocket server, trade proxy, config, Hyprland IPC, clipboard |
| `host/` | Qt 6 QML + QtWebEngine + layer-shell-qt | Shows the renderer in an overlay layer surface (Chromium, same engine as EE2's Electron; reliable on NVIDIA) and the settings window |
| `omarchy-plugin/` | Quickshell QML (omarchy-shell plugin) | Bar widget and menu that replace the Electron tray |
| Hyprland | runtime binds via its IPC | Hotkeys only while PoE2 is focused; `sendshortcut` makes the game copy an item or type a chat command |

Verified on this machine: a `QQuickView` hosting a `WebEngineView`, made a
layer surface with `LayerShellQt::Window::get()` before `show()`, maps on
the overlay layer, renders translucent, and resizes live. Making a
`QWidget`-based `QWebEngineView` a layer surface does **not** work (it maps
as a normal xdg toplevel), so the host is QML-based. Quickshell's own
WebEngine support hangs on start in Quickshell 0.3.2, so the web view cannot
live inside omarchy-shell.

## Processes

```
                 self-gating Lua binds (pass through unless PoE2 is focused)
 Hyprland ───────── socket2: custom>>omaexiled:<action>, activewindow, … ─────────┐
    ▲                                                                              ▼
    │ request socket: /eval, /dispatch send_shortcut, j/cursorpos …   ┌──────────────────────┐
    └─────────────────────────────────────────────────────────────────┤   backend (Bun, TS)  │
                                                                      │ HTTP 127.0.0.1:8584  │
 wl-copy / wl-paste ◀─────────────────────────────────────────────────┤ WS /events?role=…    │
                                                                      │ host.sock · shell.sock│
                                                                      └──┬─────────▲────▲────┘
                                           host.sock (NDJSON) commands   │         │    │ shell.sock (NDJSON)
                                                                         ▼         │    │
                         ┌──────────────── host (Qt 6, QML) ────────────────┐      │  ┌─┴──────────────────────┐
                         │ overlay layer surface  → /?mode=overlay  ────────┼─WS───┤  │ omarchy-shell bar widget│
                         │ settings toplevel      → /?mode=settings ────────┼─WS───┤  └────────────────────────┘
                         │ in-app browser (captcha/login, exports cookies)  │      │
                         └──────────────────────────────────────────────────┘      │
                           user's browser → http://127.0.0.1:8584/ (EE2 browser mode) ─WS┘
```

- `omaexiled.service` (systemd user unit, `PartOf=graphical-session.target`,
  `Restart=on-failure` so "Quit" stays quit) runs `bin/omaexiled run`. Its
  `ExecStopPost` runs `bin/omaexiled disable-binds` after every exit, so the
  binds of a killed backend pass keys through at once (see "Hotkeys").
- The backend starts the host when PoE2's window appears (the overlay page is
  preloaded so the first price check is instant) or when a window is
  requested, stops it 10 minutes after PoE2 closes and no window is open, and
  restarts it if it crashes.
- All runtime files live in `$XDG_RUNTIME_DIR/omaexiled/`: `host.sock`,
  `shell.sock`, `shell.ready`, `binds.lua`.
- Config lives in `~/.config/omaexiled/` (`config.json` written verbatim from
  the renderer like EE2, `host-config.json` = last `HostConfig`, `cookies.json`
  mode 0600). On first run, if `~/.config/exiled-exchange-2/apt-data/config.json`
  exists it is imported once (the renderer migrates it).
- HTTP listens on `127.0.0.1:8584` (`OMAEXILED_PORT` overrides). A fixed port
  keeps the pages' origin, and so their storage, stable. 8584 is also EE2's dev
  port, so `vite` dev proxying works unchanged.

## Contracts

### Renderer ↔ backend (WebSocket `/events`)

EE2's protocol is kept: JSON text frames `{name, payload}` (`payload` absent
when empty), event names and payloads from `ipc/types.ts`. Changes:

- **Roles.** Pages connect to `/events?role=overlay|settings|browser` (the
  renderer derives the role from its `?mode=` page parameter; no parameter =
  `browser`). `item-text` goes to `overlay` clients only (never "last active");
  if none is connected the backend starts the host and queues the event until
  the overlay page connects (5 s timeout). Everything else that EE2 broadcast
  is still broadcast.
- **Security.** HTTP and WS requests must have `Host` equal to
  `127.0.0.1:<port>` or `localhost:<port>`. WS upgrades and `/proxy` requests
  that carry an `Origin` must have our origin. Anything else gets 403.
- **Kept, unchanged:** `CLIENT->MAIN::save-config`, `MAIN->CLIENT::config-changed`
  (broadcast incl. sender), `CLIENT->MAIN::update-host-config`,
  `CLIENT->MAIN::used-recently`, `CLIENT->MAIN::user-action` (`quit`,
  `stash-search`), `MAIN->CLIENT::log-entry` (history on connect),
  `MAIN->CLIENT::item-text`, `MAIN->OVERLAY::focus-change`,
  `MAIN->OVERLAY::hide-exclusive-widget`, `OVERLAY->MAIN::render-state`,
  `OVERLAY->MAIN::focus-game`, `OVERLAY->MAIN::track-area`.
- **`item-text.position`** is the cursor at key press in **overlay-surface
  coordinates** (CSS px relative to the game window's top-left), so EE2's
  `position - window.screenX` math keeps working (`screenX` is 0 on Wayland).
- **New events** (add to `ipc/types.ts`):
  - `OVERLAY->MAIN::input-region {rects: {x,y,width,height}[], full: boolean}`:
    the overlay page's interactive rectangles in surface CSS px. `full: true`
    while the overlay is active. Sent whenever the set changes (rAF-debounced).
  - `CLIENT->MAIN::open-settings {}`: open the settings toplevel window.
  - `CLIENT->MAIN::open-browser {url: string}`: open the in-app browser
    window (captcha / login on pathofexile.com).
  - `MAIN->CLIENT::updater-state` is answered with
    `{state: "update-not-available", checkedAt}`; there is no updater.
- **`HostConfig`** (`CLIENT->MAIN::update-host-config`) gains two optional
  booleans, `gameCopyBind` and `clipboardWatch` (the extra price-check
  triggers, see "Hotkeys"); absent means off. The renderer keeps them as
  global config keys of the same names and passes them through
  `getConfigForHost()`.
- **Dropped:** `widget-action`, `ocr-text`, `game-log`, `write-data`,
  `re-parse-log`, `visibility`, `overlay-attached`, `/uploads`.

### HTTP

- `GET /config` → `HostState {contents: string|null, version, updater}`.
  Invalid JSON on disk is moved aside to `config.json.bad-<ts>` and served as
  `null`.
- `GET /<static>` from `renderer/dist` at origin root, `.js` as
  `text/javascript`, `/data/**` with `Cache-Control: no-cache`, path traversal
  rejected.
- `ANY /proxy/<host>/<raw path+query>` → `https://<host>/…`, path not
  decoded. Allow-list and header rules are in
  `docs/port-notes/05-trade-api-and-price-sources.md` (proxy spec). Cookies
  for the official PoE hosts come from the backend jar (fed by the host's
  in-app browser and an optional `POESESSID` setting). The User-Agent is the
  host's Chromium UA (reported in the host `hello`), so a Cloudflare
  `cf_clearance` obtained in the in-app browser stays valid.

### Backend ↔ host (`host.sock`, NDJSON)

The backend listens; the host is started as
`omaexiled-host --socket <path> --url http://127.0.0.1:<port>` and connects.
Chromium child processes inherit stdout, so the protocol never uses stdio.
Every message is one JSON object with a `type`.

Backend → host:

| type | fields | effect |
|---|---|---|
| `overlay.show` | `output` (monitor name), `rect {x,y,width,height}` (game window, monitor-local logical px) | map the overlay surface on that output with margins so it covers `rect`; no-op if already mapped there |
| `overlay.prepare` | `output`, `rect` (as `overlay.show`) | remember the game geometry; if the overlay is not mapped, warm the page up there (below) so its viewport is the game window; if mapped, only remember it. Sent on host connect and whenever the PoE2 window's output or rect changes while the overlay is hidden |
| `overlay.hide` | | unmap (QWindow::hide destroys the layer surface) |
| `overlay.input` | `rects[]`, `full` | `setMask()` to the union of `rects`, or the whole surface when `full`; then `update()` to commit |
| `settings.open` | | show / raise the settings window (`/?mode=settings`) |
| `settings.close` | | hide it |
| `browser.open` | `url` | open the in-app browser window at `url` |
| `devtools` | `target` | open DevTools for `overlay` / `settings` |
| `quit` | | exit |

Host → backend:

| type | fields | when |
|---|---|---|
| `hello` | `version`, `userAgent` | after connecting |
| `overlay.state` | `mapped`, `keyboardFocus` | on change |
| `window.closed` | `window` (`settings`/`browser`) | user closed it |
| `cookies` | `cookies[] {name,value,domain,path,expires,secure,httpOnly}` | on any cookie change for `pathofexile.com` domains |
| `log` | `level`, `message` | host diagnostics |

Overlay page rules handled inside the host: map with keyboard interactivity
`none`, switch to `on_demand` once the compositor has shown the first frame
(Qt's second frame swap; switching right after the first commit still takes
the keyboard from the game), `setActivateOnShow(false)`,
no context menu, `newWindowRequested` / `window.open` → `xdg-open` via
`QDesktopServices`, transparent background.

Warm-up: Chromium gives a page its viewport size only once it is exposed,
and the renderer reads it when `item-text` arrives, before the surface is
shown. So after the overlay page loads, and on an `overlay.prepare` that
differs from the page's current layout, the host maps the hidden page once at
the last game geometry (`overlay.prepare` / `overlay.show`; the primary
screen before any) with no input region and keyboard `none`, and unmaps it
after the second frame. A warm-up is not reported in `overlay.state` and
never replaces a shown surface; an `overlay.show` takes a warm-up surface
over.

### Backend ↔ bar widget (`shell.sock`, NDJSON)

As specified and verified in `docs/port-notes/09-omarchy-shell-plugin.md` §8:
on connect `hello`, then a full `state` (re-sent on every change); widget
commands `open-settings`, `quit` (plus `open-browser`, `toggle-overlay`).
`shell.ready` is written after listening. The same socket serves
`omaexiled ctl <command> [args]` (one JSON request, one JSON reply).

## Overlay model

The host owns one overlay layer surface on the monitor that shows PoE2:

- layer `overlay`, exclusive zone `-1`, namespace `omaexiled`, anchored to
  all four edges with margins so it covers exactly the game window (the whole
  monitor for fullscreen PoE2). A runtime `no_anim` layer rule for
  `^omaexiled$` removes Omarchy's fade-in;
- mapped only while the overlay page wants to show something
  (`render-state {shouldShow}`) and PoE2 is focused (with no game, as in
  `ctl` tests, it covers a monitor), destroyed otherwise
  (apart from the two-frame warm-ups), so the game keeps direct scanout when
  idle. After PoE2 closes it stays unmapped, whatever the page reports, until
  the next price check or overlay key;
- the **input region** is what the page reports (`input-region`): the visible
  widgets' rectangles (price panel, related-items column, open tooltips /
  popovers) while inactive, the whole surface while active;
- keyboard: mapped with `none`, then `on_demand` once the first frame is
  shown. The game keeps the keyboard; hovering the panel gives it the
  keyboard; moving back over the game returns it. In the active mode too the
  keyboard only moves to the overlay with the next pointer motion (`Esc` and
  the overlay key work either way, they are binds).

Because the surface is the game window, the renderer runs in EE2's **overlay
mode** (the old `Host.isElectron` branch, now driven by `?mode=overlay`) and
keeps EE2's own geometry: panel left or right of the item
(`innerHeight * 986/1600` panel offset), the related-items column, the
check-position circle.

### Active vs inactive (EE2 semantics, kept)

| | inactive (quick check) | active (locked check, item check, Shift+Space) |
|---|---|---|
| input region | widget rectangles | whole surface (dim background, click outside closes) |
| keyboard | game, until the pointer is over the panel | overlay (pointer is over it) |
| close | hold-mode rules, Esc, close button | Esc, background click, close button, overlay key |

The backend owns the state: it sends `focus-change {game, overlay}` exactly
like EE2's main process (`overlay` = active) and the renderer keeps the
`wasActive` guard from the user's `omarchy_new` branch. Because that guard
keeps an inactive panel, the backend also sends `hide-exclusive-widget` when
PoE2 loses focus or closes, in both modes (EE2 hid hide-on-blur widgets on
every blur).

Settings: the bar opens the settings window. In the active overlay the cog
and the price panel's league title open EE2's settings widget inside the
overlay. During a quick (inactive) check, where that widget would stay
invisible, the league title sends `CLIENT->MAIN::open-settings` instead.

Hold mode (quick check, `focusOverlay: false`) reproduces
`WidgetAreaTracker`: the backend polls the cursor and the modifier keys
(`/repl` with `hl.get_cursor_pos` and `hl.is_key_down`) every 50 ms after
`track-area`; the panel closes (`hide-exclusive-widget`) when the cursor never
entered the panel area, the hold key is released and the cursor is more than
`closeThreshold` from the press point. Entering the panel area stops tracking.
The renderer computes the area and the panel side from the reactive surface
size and sends `track-area` again if that size changes while a hold-mode
check is shown. A failed key-state request skips that poll; only three
unusable replies in a row (a Hyprland without `hl.is_key_down`) make the
rest of that tracking session treat the hold key as released.

## Verified platform behavior

Measured on this machine (Hyprland 0.56.2, Lua config, NVIDIA) with
`tools/fake-poe`, an xcb window titled "Path of Exile 2" with class
`steam_app_2694490`, fullscreen like the real game:

| Question | Result |
|---|---|
| Overlay layer surface above a fullscreen XWayland window | drawn on top |
| `QWindow::setMask()` on a full-monitor layer surface | becomes the input region; pointer motion and clicks outside it reach the game |
| Keyboard interactivity `on_demand` set **before** map | steals keyboard focus from the game on map |
| Map with `none`, then switch to `on_demand` | game keeps the keyboard. Pointer over the panel focuses the panel; pointer back over the game returns focus to the game |
| Switching interactivity at runtime | only applies after a surface commit: call `QQuickWindow::update()` after `setKeyboardInteractivity()` |
| `hl.dsp.send_key_state` Ctrl+Alt+C to the XWayland window | received; its X11 clipboard copy is visible to `wl-paste` within 400 ms |
| `hyprctl eval 'hl.bind(...)'` / `hl.unbind(...)` at runtime | works; `hl.unbind` removes **every** bind on that combo |
| Mouse button via `send_key_state { key = "mouse:272" }` | delivered as a click |

Hyprland Lua API names in use: `hl.bind`, `hl.unbind`, `hl.dispatch`,
`hl.dsp.send_key_state`, `hl.dsp.send_shortcut`, `hl.dsp.cursor.move`,
`hl.timer`, `hl.get_active_window`, `hl.get_cursor_pos`, `hl.is_key_down`,
`hl.layer_rule`, `hl.window_rule`, `hl.on`, plus Lua's `os.time()` (the
binds lease). `hyprctl dispatch` takes Lua
dispatcher expressions, not the old `dispatcher args` strings. Send keys as a
`down` then, after a short `hl.timer`, an `up` (Omarchy's
`bindings/clipboard.lua` does the same to avoid stuck synthetic keys).

Not verifiable without the game: whether Wine/Proton accepts the injected
keys like Qt's xcb backend does, and whether PoE2 confines the pointer to its
window (which would keep pointer focus off the panel). Both are on the in-game
checklist.

## Hotkeys

At start, on every `configreloaded>>` and whenever `HostConfig` changes, the
backend writes `$XDG_RUNTIME_DIR/omaexiled/binds.lua` and runs
`dofile(...)` through `/eval`. The module keeps its state in
`_G.omaexiled`:

- one `hl.bind(combo, callback, {auto_consuming = true, dont_inhibit = true,
  description = "OmaExiled: …"})` per combo, created once per Lua state and
  later only `set_enabled(true/false)` (never `hl.unbind` / `remove`, which
  would also delete the user's binds on that combo);
- the callback returns `{ ok = false }` (key passes through to the focused
  window) unless the backend is alive (`M.enabled and (M.lease or 0) >=
  os.time()`, with `M = _G.omaexiled`), the active window is PoE2 and the
  combo maps to an action; then it calls
  `hl.dispatch(hl.dsp.event("omaexiled:<actionId>"))` and the key is consumed;
- the lease: the backend sets `_G.omaexiled.lease = os.time() + 15` through
  `/eval` right after every install and every 5 s while it runs, so a killed
  or hung backend stops taking PoE2's keys within 15 s;
- `Escape` is bound the same way but only acts while a panel is visible
  (`_G.omaexiled.panel`, set by the backend: the surface is shown and the
  overlay is active or the page's input region is not empty; a surface
  mapped only for the debug key log or the editing banner does not count).
  The backend sets it again after every forced install (on connecting to
  Hyprland, on a config reload, on `ctl reload-binds`) and clears it when the
  host disconnects;
- on backend shutdown `enabled` and `panel` become false and the lease is
  cleared. After any exit the unit's `ExecStopPost` (`omaexiled
  disable-binds`) does the same through `hyprctl eval`
  (`M.enabled=false M.lease=0 M.panel=false`).

The backend receives `custom>>omaexiled:<actionId>` on socket2 and maps the
id to the `HostConfig.shortcuts` entry. PoE2 is the window whose class is
`steam_app_2694490` or whose title equals `HostConfig.windowTitle`
("Path of Exile 2").

| Action | Default | Backend steps |
|---|---|---|
| price check (quick) | `Ctrl+D` | sentinel → clipboard, `send_shortcut` copy chord to the PoE2 window, poll `wl-paste` (48 ms initial, every 48 ms, 500 ms limit), `item-text {focusOverlay:false}`, `track-area` hold mode |
| price check (locked) | `Ctrl+Alt+D` | same with `focusOverlay:true` → active overlay |
| item check | `Alt+D` | same, target `item-check`, active |
| chat command | `F5` `/hideout`, `F9` `/exit`, … | EE2's three `@last` branches with `send_shortcut` steps, then Enter, Enter, Up, Up, Esc when `send` |
| stash search | configured | `Ctrl+F`, `Ctrl+V`, `Enter` |
| overlay key | `Shift+Space` | toggle active (EE2: the menu plus open widgets) |

Copy chord = `Ctrl+C` merged with PoE2's "show advanced item descriptions"
key from its ini (default Alt), i.e. `Ctrl+Alt+C`. Keys are sent from the
backend over the request socket (a full press/release per step, ~30 ms
apart), never from inside a bind callback. Clipboard restore waits 300 ms.
Two more trigger modes are settings (Settings, Price check; both off by
default), sent as the optional `HostConfig` booleans: `gameCopyBind`, a
pass-through bind on the game's own copy chord, and `clipboardWatch`, a
passive clipboard watch (`wl-paste --watch`, only while PoE2 is focused).

Known conflicts on this machine: Omarchy binds `F9` (dictation) and the
user's config binds `Ctrl+Alt+D` (old prototype script). Both would fire
together with ours while PoE2 is focused; the backend logs every combo that
already has a non-OmaExiled bind.


## Repository layout

| Path | What |
|---|---|
| `renderer/` | EE2's Vue app, trimmed (vendored from upstream `cca30662`; `git log -- renderer` shows every change) |
| `ipc/` | event types shared by renderer and backend |
| `backend/` | Bun backend (`src/`, `test/`) |
| `host/` | Qt 6 host (`omaexiled-host.pro`, `src/`, `qml/`) |
| `omarchy-plugin/` | bar widget, copied to `~/.config/omarchy/plugins/omaexiled/` |
| `bin/omaexiled` | entry point: `run`, `ctl`, `status`, `logs`, `install`, `uninstall`, `update-plugin`, `disable-binds` |
| `packaging/` | systemd user unit |
| `tools/fake-poe/` | fake PoE2 XWayland window for tests |
| `docs/port-notes/` | EE2 subsystem notes (the porting reference) |

## Build, run, test

- `make` builds the renderer (`npm ci`, `make-index-files`, `vite build`),
  the host (`qmake6 && make`), the fake game, and installs backend deps.
- `make test` runs the renderer suite (vitest, must stay at upstream's
  527 passing minus tests of dropped features) and the backend suite
  (`bun test`).
- `bin/omaexiled install` builds, installs the systemd unit, the bar widget
  and `~/.local/bin/omaexiled`, and enables the service.
- `tools/fake-poe` plus `bin/omaexiled ctl` drive end-to-end tests without
  the game; `docs/IN-GAME-TESTS.md` is the checklist that needs the real one.
