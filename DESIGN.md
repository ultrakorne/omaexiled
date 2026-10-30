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
Hyprland ──binds (only while PoE2 is focused)──▶ omaexiled ctl <action>
   ▲   │ socket2 events (active window, open/close)       │ HTTP POST /api/ctl
   │   ▼                                                  ▼
   │  ┌──────────────────────── backend (Bun) ─────────────────────────┐
   └──┤ Hyprland IPC · clipboard (wl-paste/wl-copy) · config store      │
 sendshortcut │ HTTP: renderer, /data, /proxy/*, /api/*  · WS /events   │
      └──────────────┬───────────────────────────────────▲─────────────┘
           stdio JSON│                                   │ WS /events (EE2 protocol)
                     ▼                                   │
      ┌──────────── host (Qt) ───────────┐     ┌─────────┴──────────┐
      │ overlay layer surface ───────────┼─────▶ renderer page       │
      │ settings toplevel window ────────┼─────▶ renderer page       │
      └──────────────────────────────────┘     └────────────────────┘
      omarchy-shell bar widget ──HTTP /api/status, /api/action──▶ backend
```

- `omaexiled.service` (systemd user unit, `PartOf=graphical-session.target`)
  runs the backend.
- The backend starts the host when PoE2 appears (so the first price check
  is instant) or when a window is requested, and stops it a while after PoE2
  closes. It restarts a crashed host.
- Backend and host talk newline-delimited JSON over the host's stdin/stdout.
- Each renderer page talks to the backend over the EE2 WebSocket protocol,
  so most renderer code is unchanged.

## Overlay model

The host owns one overlay layer surface per game monitor:

- anchored to all four edges of the monitor that shows PoE2, on the
  `overlay` layer, exclusive zone `-1`, namespace `omaexiled`;
- mapped only while a widget (price check, item check) is visible, unmapped
  otherwise, so nothing covers the game when idle;
- its **input region** is the union of the visible widget rectangles that the
  renderer reports; everything else passes through to the game;
- keyboard interactivity is `none` while mapped, so the game keeps the
  keyboard. Details of when it switches to `on_demand` (to type into a filter
  field) are in the host section below.

Because the surface covers the game, the renderer keeps EE2's own placement
logic (panel left or right of the item, the check-position circle) in page
coordinates.

## Hotkeys

The backend watches Hyprland's event socket. While the active window is
PoE2 it installs the configured binds through Hyprland IPC; when focus
leaves PoE2 it removes them, so `Ctrl+D` and `F5` behave normally in other
apps. Each bind runs `omaexiled ctl <action>`.

| Action | Default | What the backend does |
|---|---|---|
| price check | `Ctrl+D` | sendshortcut `Ctrl+Alt+C` to PoE2, wait for item text on the clipboard, show the price check |
| item check | `Alt+D` | same copy, then show the item check |
| chat command | `F5` `/hideout`, `F9` `/exit`, … | put text on the clipboard, send Enter, paste, Enter |
| stash search | configured | focus the stash search box, paste, Enter |
| overlay | `Shift+Space` | toggle the last widget |

Two more trigger modes are settings: a pass-through bind on the game's own
`Ctrl+C` / `Ctrl+Alt+C`, and a passive clipboard watch that opens a price
check for any copied item.
