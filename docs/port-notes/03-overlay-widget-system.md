# 03 — Renderer overlay / widget system, price-check & item-check presentation

Source: `/home/ultra/Developer/Exiled-Exchange-2` (branch `master`, HEAD `cca30662`).
All paths below are relative to that repo unless absolute. Line numbers are for `master`.

Scope: how EE2's renderer hosts widgets in one full-screen transparent Electron overlay,
and exactly how the price-check panel and the item-check panel are shown, positioned,
focused and hidden — plus what OmaExiled must build instead (one Wayland layer-shell surface
per panel, driven by a Bun backend and a Qt6/QtWebEngine host).

---

## 0. TL;DR

* EE2 renders **every** widget inside **one** full-screen transparent `BrowserWindow`
  (electron-overlay-window, sized to the game window). `OverlayWindow.vue` is the
  "window manager": it `provide("wm", …)`s a `WidgetManager`, renders each entry of
  `AppConfig().widgets` via `v-show`, and decides visibility from `wmWants`, `wmZorder`
  ("exclusive") and `wmFlags` (`hide-on-blur`, `invisible-on-blur`, …) plus the overlay focus
  state `active` received from main (`MAIN->OVERLAY::focus-change`).
* The price-check panel (`PriceCheckWindow.vue`) is a full-screen, `pointer-events:none`
  flex row: `[spacer = PoE side panel width][#price-window 28.75rem][related items / rate-limit]`,
  reversed (`flex-row-reverse`) when the item was checked on the right half of the game window
  ("inventory"). The panel column is always **full game-window height**.
* Show = `MAIN->CLIENT::item-text` with `target:"price-check"`. Two modes:
  * **hold** (`Ctrl + D`, `focusOverlay:false`): overlay is NOT focused; renderer sends
    `OVERLAY->MAIN::track-area`; main then auto-closes the panel when the user lets go of the
    hold key and moves the cursor > `2.5rem` (40 px) from the press point, or activates the
    overlay when the cursor enters the panel column while still holding the key / clicks it.
  * **locked** (`Ctrl + Alt + D`, `focusOverlay:true`): main focuses the overlay; the panel
    stays until the overlay loses focus (Esc, Ctrl+W, overlay key, background click, close
    button, stash-search action, game refocus).
* Hide = `wm.hide()` (sets `wmWants:"hide"`), triggered by `hide-on-blur` (overlay lost focus),
  `MAIN->OVERLAY::hide-exclusive-widget` (area tracker), the title-bar close button, the
  overlay background click, or another exclusive widget being shown.
* For OmaExiled: replace `OverlayWindow.vue` with a **per-widget page shell** that hosts exactly
  one widget (`price-check` or `item-check`), provides a compatible `wm` object, reports
  "should show / content rects" to the backend, and receives geometry (game bounds, side)
  from the backend. Placement becomes layer-shell anchors + margins computed by the backend.
  Several renderer spots read `window.screenX/innerWidth` and `navigator.userAgent` ("Electron")
  and **must be patched** (list in §8.3).

---

## 1. Files and their roles

| File | Lines | Role | Port disposition |
|---|---|---|---|
| `renderer/src/main.ts` | 1-28 | bootstrap: `initConfig()` → i18n → `Data.init` → `Host.init()` (WebSocket) → mount `App.vue` | keep (add widget-page switch) |
| `renderer/src/web/App.vue` | 1-145 | `<div id="app" class="text-sm font-poe-sc"><OverlayWindow/></div>`; global CSS (tailwind, `.layout-column`, `.btn`, scrollbars) | keep CSS; replace `<OverlayWindow/>` with per-widget shell |
| `renderer/src/web/overlay/OverlayWindow.vue` | 1-413 | the window manager (provides `wm`), visibility rules, focus handling, background, logs, attach toast | **replace** with minimal shell (§8) |
| `renderer/src/web/overlay/interfaces.ts` | 1-16 | `WidgetManager` interface, re-exports `widgets.ts` | keep (maybe extend) |
| `renderer/src/web/overlay/widgets.ts` | 1-88 | `Widget`, `WidgetSpec`, `WellKnownFlag`, `Anchor`, `PriceCheckWidget`, etc. | keep |
| `renderer/src/web/overlay/widget-registry.ts` | 1-39 | registry of widget components (`component.widget` = `WidgetSpec`) | trim (see §8.3 – default config generation depends on it) |
| `renderer/src/web/overlay/Widget.vue` | 1-425 | generic movable widget chrome (anchor positioning, hover action panel Hide/Edit/Move/Delete), global `.widget-default-style` | needed only if item-check keeps its chrome; else drop |
| `renderer/src/web/overlay/WidgetMenu.vue` | 1-178 | floating widget menu + "paste item text to price check" textarea | drop (overlay concept) |
| `renderer/src/web/overlay/LoadingAnimation.vue` | 1-67 | "Exiled Exchange 2 – Is ready…" toast on `MAIN->OVERLAY::overlay-attached` | drop (optionally backend `notify-send`) |
| `renderer/src/web/overlay/DevWidget.vue` | 1-196 | dev playground for ItemEditorV2; commented out in OverlayWindow (l.50-52) | drop |
| `renderer/src/web/overlay/WidgetImageStrip.vue`, `WidgetDelveGrid.vue` | – | other widgets | drop |
| `renderer/src/web/price-check/PriceCheckWindow.vue` | 1-451 | price-check panel widget | keep, patch (§8.3) |
| `renderer/src/web/price-check/CheckPositionCircle.vue` | 1-43 | ring drawn at the cursor position of the check | drop or native (§9) |
| `renderer/src/web/item-check/WidgetItemCheck.vue` | 1-126 | item-check widget (MapCheck or ItemInfo inside `Widget.vue`) | keep, patch; MapCheck dropped |
| `renderer/src/web/item-check/widget.ts` | 1-13 | `ItemCheckWidget` config type | keep |
| `renderer/src/web/item-check/ItemInfo.vue` | 1-83 | item-check content (wiki/poedb/CoE/stash/price buttons, weapon DPS) | keep |
| `renderer/src/web/item-check/hotkeyable-actions.ts` | 1-197 | `registerActions()` handles item-text targets `open-wiki`, `open-poedb`, `open-craft-of-exile`, `search-similar`, `search-same-priced` | keep (route carefully, §8.4) |
| `renderer/src/web/stash-search/WidgetStashSearch.vue` | 1-176 | floating stash-search button lists (overlay-only) | drop UI, keep config semantics |
| `renderer/src/web/stash-search/widget.ts` | 1-12 | `StashSearchWidget` type | keep |
| `renderer/src/web/stash-search/stash-search-editor.vue` | 1-90 | settings editor for one stash-search widget | keep (in settings window) |
| `renderer/src/web/background/IPC.ts` | 1-94 | WebSocket transport `Host`/`MainProcess`, `isElectron` | patch (§8.3) |
| `renderer/src/web/Config.ts` | 1-843 | config load/save/upgrade, `getConfigForHost()` | see config notes; overlay-relevant bits in §3.10 |
| `main/src/windowing/OverlayWindow.ts` | 1-236 | Electron overlay window, focus switching, Esc handling | replaced by backend + Qt host |
| `main/src/windowing/WidgetAreaTracker.ts` | 1-123 | hold-mode auto-close / auto-activate state machine | re-implement in backend (§5.8, §9) |
| `main/src/windowing/OverlayVisibility.ts` | 1-71 | hide all widgets while Alt is held alone | optional |
| `main/src/windowing/GameWindow.ts` | 1-57 | game window tracking (focus, bounds) | replaced by Hyprland integration |
| `main/src/server.ts` | 1-149 | HTTP+WS server, `last-active` client routing | replaced by Bun backend (routing changes, §8.4) |
| `main/src/shortcuts/Shortcuts.ts` | 1-330+ | hotkeys → `item-text` emission | replaced (other notes) |

---

## 2. Renderer bootstrap and globals that matter for windows

* `renderer/index.html`: `<meta name="color-scheme" content="dark">`, `<div id="app">`. No html/body
  background is set. In Electron the window is transparent (`OVERLAY_WINDOW_OPTS`).
  **Qt host:** call `QWebEnginePage::setBackgroundColor(Qt::transparent)` and use an alpha-capable
  surface; verify `color-scheme: dark` does not make Chromium paint a dark canvas (if it does,
  add `html,body{background:transparent}` in the shell).
* `renderer/src/main.ts:8-23`: `initConfig()` (fetches `GET /config`) → `I18n.init(lang)` →
  `Data.init(lang)` → `Host.init()` (opens `ws://${location.host}/events`, resolves on open) →
  watch language → `createApp(App).use(i18n).mount("#app")`.
* `renderer/src/web/Config.ts:25-28` `updateConfig()` sets
  `document.documentElement.style.fontSize = ${config.fontSize}px` → **1rem = `fontSize` CSS px**
  (default `fontSize: 16`, Config.ts:209). Every rem size below scales with it. The backend reads
  `fontSize` from config.json to size surfaces.
* `App.vue:2` root `#app` has classes `text-sm font-poe-sc` (Tailwind 3.4.19: `text-sm` =
  0.875rem / line-height 1.25rem; font FontinSmallCaps). `App.vue:23-34`:
  `#app { height:100vh; display:flex; flex-direction:column; overflow:hidden; justify-content:space-between }`,
  `:focus{outline:0}`. `.layout-column{display:flex;flex-direction:column;height:100%}` (App.vue:36-40).
  Scrollbar width 0.875rem (App.vue:42-44).
* `renderer/src/web/background/IPC.ts`:
  * `Host.isElectron` = `navigator.userAgent.includes("Electron")` (l.88-90).
  * `Host.onEvent(name, cb)` **silently ignores every `MAIN->OVERLAY::*` event when
    `!isElectron`** (l.51-53). QtWebEngine's UA does not contain "Electron" → all overlay events
    (`focus-change`, `visibility`, `overlay-attached`, `hide-exclusive-widget`) would be dropped.
    Must be patched (§8.3).
  * `Host.selfDispatch(event)` dispatches locally (used to re-run an item check, §5.3).
  * `Host.proxy(url)` = `fetch("/proxy/"+url)`.
  * `Host.sendEvent` → `socket.send(JSON.stringify(event))` (Sockette auto-reconnect).

---

## 3. The widget framework (EE2)

### 3.1 Widget config object — `overlay/widgets.ts:1-8`

```ts
interface Widget {
  wmId: number;                      // unique id, 1..n
  wmType: string;                    // "price-check" | "item-check" | "settings" | "menu" | "stash-search" | ...
  wmTitle: string;                   // menu label; "{icon=fa-xxx} Title" syntax parsed by WidgetMenu
  wmWants: "show" | "hide";          // desired visibility (persisted in config!)
  wmZorder: number | "exclusive" | null; // number = stacking among normal widgets; "exclusive" = modal; null = never brought to top yet
  wmFlags: Array<WellKnownFlag | string>;
}
```
Widget instances live in `AppConfig().widgets` (persisted to config.json) and each widget type
adds its own config keys to the same object (e.g. `PriceCheckWidget`, `ItemCheckWidget`).

### 3.2 `WidgetSpec` & registry — `widgets.ts:10-16`, `widget-registry.ts:16-39`

```ts
interface WidgetSpec {
  type: string;                       // matches wmType
  instances: "single" | "multi";
  trNameKey?: string;                 // i18n key for "add widget" menu
  initInstance?: () => Widget;        // for "single"
  defaultInstances?: () => Widget[];  // for "multi"
}
```
* A widget component exposes its spec as a static `widget` option on the component
  (`export default defineComponent({ widget: {...} satisfies WidgetSpec, ... })`).
* `registry.widgets` = array of components; `registry.getWidgetComponent(wmType)` finds by
  `component.widget.type` (`widget-registry.ts:18-24`). Registration order (l.27-39): menu, settings,
  item-search, experience-tracker, timer, stash-search, price-check, item-check, image-strip,
  delve-grid, notepad, library.
* `Config.ts:210-228` `defaultConfig().widgets` is generated from the registry: every "single" spec's
  `initInstance()` and every "multi" spec's `defaultInstances()`, with `wmId` re-numbered
  `widgets.length + 1` in registry order. **Trimming the registry changes the default widget list
  and wmIds** (fine for fresh configs, but see §8.3 for code that assumes certain widgets exist).

### 3.3 Flags — `widgets.ts:18-25` + dynamic flags

| Flag | Processed in | Exact semantics |
|---|---|---|
| `uninitialized` | set by `wm.create()` (OverlayWindow.vue:238-247); consumed in multi widgets' setup (`WidgetStashSearch.vue:112-129`, notepad, image-strip) | widget created from the "+" menu; component fills defaults on first mount and calls `wm.show()` |
| `menu::skip` | `WidgetMenu.vue:120` | not listed as a button in the widget menu. (Old name `skip-menu`, migrated in `Config.ts:527-533`, configVersion 23.) |
| `has-browser` | `PriceCheckWindow.vue:362-364`, set/cleared by `showBrowser`/`closeBrowser` (l.415-424) | price-check currently shows the built-in `<webview>` |
| `invisible-on-blur` | `OverlayWindow.vue:249-273` | while overlay is NOT active (`active=false`) the widget is not rendered (but `wmWants` is kept), it re-appears when the overlay is activated again |
| `hide-on-blur` | `OverlayWindow.vue:137-142` | on `focus-change` with `overlay:false`, `wm.hide()` is called (sets `wmWants:"hide"`) — permanent until shown again |
| `hide-on-focus` | `OverlayWindow.vue:143-148` | on `focus-change` with `overlay:true`, `wm.hide()` (delve grid only) |
| `ignore-ui-visibility` | `OverlayWindow.vue:263-266` | stays visible while UI is hidden by Alt (settings only) |
| `settings::widget=<wmId>` (dynamic) | set by `PriceCheckWindow.openLeagueSelection` (l.407-411) and `Widget.vue toggleEdit` (l.317-332); consumed by `SettingsWindow.vue` watcher on `wmFlags` (l.227-243): selects that widget's settings page, then clears the flag | "open settings at widget X" |

Default flags/zorder of the relevant widgets:

| wmType | wmWants | wmZorder | wmFlags | source |
|---|---|---|---|---|
| `price-check` | hide | `"exclusive"` | `["hide-on-blur","menu::skip"]` (reset on every mount, PriceCheckWindow.vue:252-255) | PriceCheckWindow.vue:178-211 |
| `item-check` | hide | `"exclusive"` | `["hide-on-blur","menu::skip"]` (`wmWants` reset to hide on mount, WidgetItemCheck.vue:92) | WidgetItemCheck.vue:23-55 |
| `settings` | hide | `"exclusive"` | `["invisible-on-blur","ignore-ui-visibility"]` | SettingsWindow.vue:171-180 |
| `menu` | show | `1` | `["invisible-on-blur","menu::skip"]`, anchor tl 5/5 | WidgetMenu.vue:89-104 |
| `stash-search` (2 defaults) | hide | null | `["invisible-on-blur"]` | WidgetStashSearch.vue:41-90 |

### 3.4 `WidgetManager` — the `"wm"` injection (`interfaces.ts:5-16`, provided at OverlayWindow.vue:335-346)

```ts
interface WidgetManager {
  poePanelWidth: ComputedRef<number>;              // CSS px width of PoE's stash/inventory side panel
  size: Ref<{ width: number; height: number }>;    // window.innerWidth/innerHeight, updated on resize (l.180-192)
  active: Ref<boolean>;                            // overlay has focus / is interactive
  widgets: ComputedRef<Widget[]>;                  // AppConfig().widgets
  show: (wmId: number) => void;
  hide: (wmId: number) => void;
  remove: (wmId: number) => void;
  bringToTop: (wmId: number) => void;
  create: (wmType: string) => void;
  setFlag: (wmId: number, flag: string, state: boolean) => void; // returns boolean changed (typed void)
}
```
Exact implementations (OverlayWindow.vue):
* `show(wmId)` (l.194-201): `bringToTop(wmId)`; if the current `topmostOrExclusiveWidget` is
  exclusive → `hide()` it (so **showing an exclusive widget hides the other exclusive one**:
  price-check ↔ item-check ↔ settings); then `wmWants = "show"`.
* `hide(wmId)` (l.203-205): `wmWants = "hide"`.
* `remove(wmId)` (l.207-209): filter out of `AppConfig().widgets`.
* `setFlag(wmId, flag, state)` (l.211-227): add/remove a string flag; returns true if changed.
* `bringToTop(wmId)` (l.229-236): if not already topmost and not exclusive →
  `wmZorder = topmostWidget.wmZorder + 1`. `topmostWidget` (l.297-302) = widget with the highest
  numeric zorder; the code assumes it always exists "because of the widget-menu" (zorder 1).
  **If no numeric-zorder widget exists (menu removed) `bringToTop`/`topmostOrExclusiveWidget`
  throw** (`topmostWidget.value.wmId` of undefined).
* `create(wmType)` (l.238-247): push `{wmId: max+1, wmType, wmTitle:"", wmWants:"hide", wmZorder:null, wmFlags:["uninitialized"]}`.
* `poePanelWidth` (l.328-333): `isElectron ? window.innerHeight * 986/1600 : 0`
  ("sidebar is 986px at Wx1600H" → ratio **0.61625 × game window height**). Also exposed as CSS
  var `--game-panel` on `#overlay-window` (l.5: `poePanelWidth.toFixed(4)+"px"`).
  (Main uses a slightly different 370/600 ratio for stash-scroll in `GameWindow.uiSidebarWidth`.)

Consumers of `wm` (only these exist): `Widget.vue` (`bringToTop`, `hide`, `widgets`, `setFlag`,
`show`, `remove`), `WidgetMenu.vue`, `PriceCheckWindow.vue` (`poePanelWidth`, `show`, `hide`,
`setFlag`, `widgets`, `active`), `WidgetItemCheck.vue` (`size`, `poePanelWidth`, `show`),
`WidgetStashSearch.vue` (`show`), `SettingsWindow.vue` (`widgets`, `setFlag`, `hide`), and
dropped widgets (item-search, notepad, delve-grid, image-strip, timer).

The other provide/inject key in the tree is `"builtin-browser"`: `(url: string) => void`,
**provided by `PriceCheckWindow.vue:426` itself** and injected by `BackgroundInfo.vue:29`,
`trade/TradeLinks.vue:46`, `trade/TradeBulk.vue:202`, `trade/TradeListing.vue:200`.

### 3.5 Visibility algorithm — `OverlayWindow.vue:249-273` (exact)

```
showExclusive = first widget with wmZorder==="exclusive" && wmWants==="show"
if (!active && showExclusive?.wmFlags has "invisible-on-blur") showExclusive = undefined
for each widget w:
  isVisible =
    hideUI ? (active && w.wmWants==="show" && w has "ignore-ui-visibility")
    : (!active && w has "invisible-on-blur") ? false
    : showExclusive ? (w === showExclusive)          // an exclusive widget hides ALL others
    : w.wmWants === "show"
```
Each widget component is rendered always (mounted once) and toggled with `v-show` (l.13-20), with
`:config="widget"` and `id="widget-<wmId>"`. **All widgets are mounted all the time**, so their
setup side effects (event listeners such as `registerActions()`) are always active.

### 3.6 Overlay-level state & behaviors (OverlayWindow.vue)

| State | Init / source | Effect |
|---|---|---|
| `active` | `!Host.isElectron` (l.94); `MAIN->OVERLAY::focus-change.overlay` (l.133-136) | visibility rules, `hide-on-blur`/`hide-on-focus`, background colour, check-position circle, logs/notification |
| `gameFocused` | `focus-change.game` | unused (commented template l.53-55) |
| `hideUI` | `MAIN->OVERLAY::visibility` → `!isVisible` (l.151-153) | hides everything (Alt held) |
| `showEditingNotification` | true when topmost/exclusive is `settings` (l.315) or a file `<input>` clicked (l.376-380); false when `active` (l.99-103) | banner "Press {overlayKey} to continue editing." (l.34-49) |

* `focus-change` handler (l.133-150): set `active`/`gameFocused`; if `active` became false → hide
  all `hide-on-blur` widgets; else hide all `hide-on-focus` widgets. (The user's `omarchy_new`
  branch changed this to hide only on a true→false transition because XWayland emitted repeated
  `overlay:false` events — keep that lesson.)
* `isOverlayVisible` (l.275-282): `!isElectron || active || showEditingNotification || logKeys ||
  any widget visible`; watched with `immediate:true` → `OVERLAY->MAIN::render-state {shouldShow}`
  (l.284-295). Main uses it only when `hideOverlayOnBlur` is true (`OverlayWindow.ts:208-219`).
* Background (l.8-12): full-window div, `background = active ? AppConfig().overlayBackground : undefined`
  (default `"rgba(129, 139, 149, 0.15)"`). Click → `handleBackgroundClick` (l.348-365):
  1. `overlayAlwaysClose` → `OVERLAY->MAIN::focus-game`;
  2. else if `!isElectron` → hide the topmost widget if it is exclusive;
  3. else if `overlayBackgroundClose` (default true) → `OVERLAY->MAIN::focus-game`.
  (The background only receives clicks while the overlay is interactive; otherwise the whole
  Electron window is click-through.)
* Logs (l.21-32): when `!active && logKeys`, last 11 lines of `Host.logs` shown (max-width 38rem).
* `LoadingAnimation` (l.33): toast for 2500 ms on `MAIN->OVERLAY::overlay-attached` if
  `showAttachNotification` (LoadingAnimation.vue:27-34), positioned `bottom:20%` centered.
* Startup side effects (l.90-92): `usePoeninja()` (starts poe.ninja price polling; global state),
  `useLeagues().load()` (fetch `/api/trade2/data/leagues` via proxy), `useClientLog()` +
  `MAIN->CLIENT::game-log` queue (l.155-168).
* `onMounted` + `nextTick` (l.170-178): `CLIENT->MAIN::used-recently {isOverlay: isElectron}` and
  `pushHostConfig()` (sends `CLIENT->MAIN::update-host-config` = hotkeys etc.).
* `window "focus"` (l.119-124) → `CLIENT->MAIN::used-recently {isOverlay:isElectron}`.
* `window "blur"` (l.114-118) → `nextTick(saveConfig)`.
* `MAIN->CLIENT::config-changed` (l.126-131) → if topmost/exclusive is `settings`, hide it.

### 3.7 z-order / exclusivity summary

* Exclusive widgets (`price-check`, `item-check`, `settings`) are modal: at most one is
  `wmWants:"show"` at a time (enforced by `show()`), and while one is visible **all other widgets
  are invisible** (§3.5). Their `wmZorder` is never changed.
* Normal widgets stack by `wmZorder` (CSS `z-index` set by `Widget.vue` l.171/219); mousedown on a
  widget → `bringToTop` (Widget.vue:300-305).

### 3.8 `Widget.vue` — generic chrome (used by item-check, stash-search, menu…)

Props (l.137-162): `config: Widget & {anchor: Anchor}` (required), `moveHandles: string|string[]`
(`undefined` = all 9, `"center"`, `"corners"`, `"top-bottom"`, `"none"`/other = none),
`readonly` (hide "Edit"; default false), `removable` (default true), `hideable` (default true),
`inlineEdit` (default true; false → "Edit" opens SettingsWindow at this widget via
`settings::widget=<wmId>` + `wm.show(settings)`). Slot props: `isEditing`, `isMoving`.

Positioning (`widgetPosition`, l.175-221): `.widget{position:absolute; display:flex}`,
`top: anchor.y%`, `left: anchor.x%`, plus `transform` by `anchor.pos`:

| pos | transform | max-width % | max-height % |
|---|---|---|---|
| tl | none | 100-x | 100-y |
| tc | translate(-50%,0) | 2·min(100-x,x) | 100-y |
| tr | translate(-100%,0) | x | 100-y |
| cr | translate(-100%,-50%) | x | 2·min(100-y,y) |
| br | translate(-100%,-100%) | x | y |
| bc | translate(-50%,-100%) | 2·min(100-x,x) | y |
| bl | translate(0,-100%) | 100-x | y |
| cl | translate(0,-50%) | 100-x | 2·min(100-y,y) |
| cc | translate(-50%,-50%) | 2·min(100-x,x) | 2·min(100-y,y) |

Action panel (l.8-45, `actionsPosition` l.223-250): `absolute px-1`, background `rgba(0,0,0,0.01)`;
inner `.actionsPanel` = column of buttons (`py-1`, white text, `rgba(0,0,0,.4)`, rounded),
**shown only while hovering the widget** (`.widget:not(:hover) .actionsPanel{display:none}`).
Placed `top:0;left:100%` if anchor x≤50 && y≤50; `top:0;right:100%` if x≥50 && y≤50;
`bottom:0;right:100%` if x≥50 && y≥50; `bottom:0;left:100%` if x≤50 && y≥50. Buttons: Hide
(`wm.hide`), Edit, Move (toggles 1rem move handles; dragging sets `anchor.x/y` as % of window),
Delete (hold 1000 ms, `wm.remove`). Global style `.widget-default-style` (l.417-425): rounded,
`bg-gray-900`, shadow `0 1px 3px 0 rgba(0,0,0,.75), 0 1px 2px 0 rgba(0,0,0,.75)`.

### 3.9 Config persistence hooks tied to the overlay

* `saveConfig()` (Config.ts:30-50) **does nothing while any exclusive widget has `wmWants:"show"`**,
  and only sends when the config differs from `_lastSavedConfig` →
  `CLIENT->MAIN::save-config {contents, isTemporary}`; main writes the file and broadcasts
  `MAIN->CLIENT::config-changed {contents}` to **all** clients (`ConfigStore.ts:15-21`), which
  replaces their `AppConfig()` (Config.ts:60-63).
* Saves happen on: window blur (OverlayWindow.vue:114-118), and when the topmost/exclusive widget
  changes away from an exclusive non-settings widget (l.312-326, "TODO: hack") — i.e. **closing the
  price-check or item-check panel triggers the save** of anything changed while it was open
  (`leagueId` via Leagues.ts:30-31, `savedAugments` via AugmentEditor.vue:279-287,
  `showRateLimitState` via RateLimiterState.vue:83-85, etc.).
* Settings window saves explicitly (`updateConfig(clone); saveConfig(); pushHostConfig()`).

---

## 4. Main-process counterpart (what the renderer expects from "main")

### 4.1 Events (exact names/payloads from `ipc/types.ts`)

| Event | Direction | Payload | Sender / handler | Notes |
|---|---|---|---|---|
| `MAIN->CLIENT::item-text` | main→client | `{target: string, clipboard: string, item?: unknown, position: {x,y}, focusOverlay: boolean}` | `Shortcuts.ts:224-232` (sent to **`last-active`** client only) | `position` = `screen.getCursorScreenPoint()` at hotkey press (global DIP). `item` only set by renderer-local `selfDispatch` callers |
| `MAIN->OVERLAY::focus-change` | broadcast | `{game: boolean, overlay: boolean, usingHotkey: boolean}` | `OverlayWindow.ts:192-206` on game active-change | `usingHotkey` unused by renderer |
| `MAIN->OVERLAY::visibility` | broadcast | `{isVisible: boolean}` | `OverlayVisibility.ts:41-70` | Alt-hold UI hiding |
| `MAIN->OVERLAY::overlay-attached` | broadcast | none | `OverlayWindow.ts:184-187` | attach toast |
| `MAIN->OVERLAY::hide-exclusive-widget` | broadcast | none | `WidgetAreaTracker.ts:76-79` | only `PriceCheckWindow` listens (l.342-344) |
| `OVERLAY->MAIN::focus-game` | client→main | none | → `assertGameActive` (`OverlayWindow.ts:25-28,105-113`) | |
| `OVERLAY->MAIN::render-state` | client→main | `{shouldShow: boolean}` | `OverlayWindow.ts:38-41` | window show/hide when `hideOverlayOnBlur` |
| `OVERLAY->MAIN::track-area` | client→main | `{holdKey: string, closeThreshold: number, from: {x,y}, area: {x,y,width,height}, dpr: number}` | `WidgetAreaTracker.ts:15-63` | hold-mode tracking |
| `CLIENT->MAIN::used-recently` | client→main | `{isOverlay: boolean}` | `server.ts:101-103` sets `lastActiveClient = socket`; `OverlayWindow.ts:32-34` sets `wasUsedRecently` | decides who receives item-text and whether focusOverlay activates the overlay |
| `CLIENT->MAIN::user-action` | client→main | `{action:"stash-search", text}` (also quit/updater) | `Shortcuts.ts:73-77` → `stashSearch()` which first calls `overlay.assertGameActive()` (text-box.ts) | stash search from item-check/stash widgets |
| `MAIN->CLIENT::config-changed` | broadcast | `{contents: string}` | ConfigStore | |

`server.ts:58-70` `sendEventTo("last-active"|"any"|"broadcast")`: `last-active` = the socket that
most recently sent `used-recently` or connected last (l.97-103); on close, if one client remains it
becomes last-active (l.106-112). The user's Linux notes confirm a stray WS client steals item-text
events because of this. **Do not keep this routing in OmaExiled** (§8.4).

### 4.2 Overlay focus state machine (`OverlayWindow.ts`)

* `isInteractable` = overlay focused & accepting mouse.
* `assertOverlayActive()` (l.94-103): if not interactable → `isInteractable=true`, show window,
  `OverlayController.activateOverlay()` (focus overlay, stop ignoring mouse),
  `poeWindow.isActive=false` → emits `active-change(false)` → (a) `focus-change {game:false, overlay:true}`
  broadcast, (b) **all global shortcuts are unregistered** (`Shortcuts.ts:61-71`) while the overlay
  is focused.
* `assertGameActive()` (l.105-113): if interactable → `isInteractable=false`,
  `OverlayController.focusTarget()` (focus game, overlay click-through), `poeWindow.isActive=true`
  → `focus-change {game:true, overlay:false}` → renderer hides `hide-on-blur` widgets.
* `toggleActiveState()` (l.115-122): overlay key (default `"Shift + Space"`).
* Keys while the overlay page (or its `<webview>`) has keyboard focus — `handleExtraCommands`
  (l.134-168, attached to `before-input-event` of the window and every attached webview,
  l.63-69): `Escape` or `Ctrl + W` → `assertGameActive` (→ panel hidden by `hide-on-blur`);
  the configured overlay key → toggle. There is **no Escape handling in the renderer** itself.
* `window.open` / `target=_blank` → `setWindowOpenHandler` → `shell.openExternal(url)`, deny (l.71-74).
* `copy-item` hotkey with `focusOverlay:true` → after the item text arrives, `if (wasUsedRecently)
  assertOverlayActive()` (`Shortcuts.ts:233-235`).

### 4.3 Hold-mode tracker (`WidgetAreaTracker.ts`) — exact

Armed by `OVERLAY->MAIN::track-area` (l.15-63). Coordinates converted to physical px on
win32/linux (l.18-53); `area` = the price-window column only (full height).
Listeners removed by: any new `copy-item` (Shortcuts.ts:223), the overlay toggle hotkey
(Shortcuts.ts:204), and the transitions below.

```
on mousemove(e):                                   // l.71-88
  modifier = e.ctrlKey ? "Ctrl" : e.altKey ? "Alt" : undefined
  if (!overlay.isInteractable && modifier !== holdKey):
      if hypot(e - from) > closeThreshold:          // closeThreshold = 2.5rem in CSS px (40 @16px) * dpr
          broadcast MAIN->OVERLAY::hide-exclusive-widget; removeListeners()
      // else: nothing (panel stays while cursor within threshold even without the key)
  else if pointInside(e, area):                     // strict > / < (l.98-105)
      overlay.assertOverlayActive()                 // panel becomes focused/interactive; listeners stay
  else if overlay.isInteractable:
      removeListeners(); overlay.assertGameActive() // left the panel after activating → closes (hide-on-blur)
  // else (holding key, outside area, not active): nothing
on mousedown(e):                                    // l.90-95
  if pointInside(e, area): removeListeners(); overlay.assertOverlayActive()   // "pin" until focus returns to game
```
Consequences: after a hold-mode check the user must **keep holding Ctrl while moving to the panel**,
otherwise the panel closes once the cursor is > 40 px away. Once entered with the key held, the key
may be released; leaving the column then closes the panel. Clicking the column pins it.

### 4.4 Alt-hold UI hiding (`OverlayVisibility.ts`)

keydown of Alt alone (no shift/ctrl) → after **275 ms** (85 ms if overlay interactable)
`visibility {isVisible:false}`; any other keydown, keyup without alt, or mousemove without alt →
cancel timer / `{isVisible:true}` (l.15-70). Renderer hides all widgets except
`ignore-ui-visibility` ones (§3.5).

---

## 5. PriceCheckWindow (`renderer/src/web/price-check/PriceCheckWindow.vue`)

### 5.1 Spec & config keys (`initInstance`, l.178-211; type `widgets.ts:38-64`)

| Key | Default | Used where | Purpose |
|---|---|---|---|
| `wmId` | 0 (renumbered) | | |
| `wmType` | `"price-check"` | | |
| `wmTitle` | `""` | | |
| `wmWants` | `"hide"` | reset on mount (l.252-255) | |
| `wmZorder` | `"exclusive"` | | modal |
| `wmFlags` | `["hide-on-blur","menu::skip"]` | reset on mount | |
| `hotkey` | `"D"` | `getConfigForHost` → shortcut `"${hotkeyHold} + ${hotkey}"`, `copy-item` target price-check, `focusOverlay:false`, `keepModKeys:true` | hold-mode key |
| `hotkeyHold` | `"Ctrl"` (`"Ctrl"`\|`"Alt"`) | above + `track-area.holdKey` (l.278) | hold modifier |
| `hotkeyLocked` | `"Ctrl + Alt + D"` | shortcut, `focusOverlay:true` | locked mode |
| `showSeller` | `false` (`"account"`\|`"ign"`) | TradeListing/TradeItem | |
| `searchStatRange` | 10 | filters | |
| `showRateLimitState` | false | RateLimiterState (toggle writes config) | |
| `apiLatencySeconds` | 2 | trade | |
| `collapseListings` | `"api"` | trade | |
| `smartInitialSearch` | true | CheckedItem.vue:181-184 (`!advancedCheck`) | auto-search in hold mode |
| `lockedInitialSearch` | true | CheckedItem.vue:181-184 (`advancedCheck`) | auto-search in locked mode |
| `activateStockFilter` | false | trade | |
| `builtinBrowser` | false | TradeLinks.vue:51-55, TradeBulk.vue:278 | use `<webview>` for "Trade" links |
| `showCursor` | true | `showCheckPos` (l.366-368) | draw CheckPositionCircle |
| `requestPricePrediction` | false | poeprices | |
| `rememberCurrency` | false | CheckedItem | |
| `defaultAllSelected` | false | filters | |
| `itemHoverTooltip` | `"keybind"` (`"off"`\|`"always"`) | TradeItem.vue:158-210 | listing hover tooltip; "keybind" = only while **Shift** held (window keydown/keyup) |
| `alwaysShowTier` | false | filters | |
| `coreCurrency` | `"exalted"` (`"chaos"`) | TradeBulk, Prices | |
| `currencyVolume` | `"both"` | | |
| `rememberListingType` | false | CheckedItem | |
| `initialDelay` | 48 | `HostConfig.initialDelay` → clipboard delay | |
| `savedAugments` | `{}` | AugmentEditor.vue:258-287 (writes) | |
| (legacy, set by migrations) `autoFillEmptyRuneSockets`, `openItemEditorAbove`, `chaosPriceThreshold` | | not in the TS type | keep in JSON |

Global config keys read by the panel: `fontSize` (width/threshold calc), `overlayKey` (browser hint
text l.95-99), `overlayAlwaysClose` (close button), `leagueId` (watch → `loadUltraLateItems()`,
l.233-242), `language`/`realm`/`preferredTradeSite` (trade), `tipsFrequency` (CheckedItem tips).

### 5.2 Mount-time behavior

* `watch(leagueId, loadUltraLateItems, {immediate:true})` (l.233-242).
* `usePoeninja()` → `xchgRate`, `xchgRateCurrency`, `initialLoading`, `queuePricesFetch` (l.245-250).
* `nextTick`: `config.wmWants="hide"`, `config.wmFlags=["hide-on-blur","menu::skip"]` (l.252-255) —
  any persisted `has-browser`/`invisible-on-blur` flag is cleared at start.
* State refs: `item: Result<ParsedItem, ParseError> | null`, `advancedCheck=false`,
  `checkPosition={x:1,y:1}` (l.257-259).

### 5.3 Reaction to `MAIN->CLIENT::item-text` (l.261-305), step by step

1. Ignore unless `e.target === "price-check"`.
2. If `Host.isElectron && !e.focusOverlay` (hold mode): compute and send `OVERLAY->MAIN::track-area`:
   * `width = 28.75 * AppConfig().fontSize` (CSS px of the panel column),
   * `screenX = (e.position.x - window.screenX > window.innerWidth/2)`
     `? window.screenX + window.innerWidth - poePanelWidth - width` (column left of inventory panel)
     `: window.screenX + poePanelWidth` (column right of stash panel),
   * payload `{holdKey: config.hotkeyHold, closeThreshold: 2.5*fontSize, from: e.position,
     area: {x: screenX, y: window.screenY, width, height: window.innerHeight}, dpr: devicePixelRatio}`.
3. `closeBrowser()` (clear `has-browser`).
4. `wm.show(config.wmId)` (hides any other exclusive widget, then `wmWants:"show"`).
5. `checkPosition = e.position`; `advancedCheck = e.focusOverlay`.
6. `item = handleItemPaste({clipboard: e.clipboard, item: e.item})` (l.307-336):
   `e.item ? ok(e.item) : parseClipboard(e.clipboard)`; then Heist contracts and Sentinels that are
   not Unique → `err("item.unknown")`; error mapping: `"item.wrong_language|<game>|<ee>"` →
   `{name, message: name+"_help", rawText, format:[gameLang, eeLang]}`, else
   `{name: err, message: err+"_help", rawText}`.
7. If ok → `queuePricesFetch()`.
8. `performance.mark(...)` calls (harmless).

Local re-dispatchers of this event (same handler runs): `fallback/ReloadTradeData.vue:78-89`
("Retry Item": `{target:"price-check", clipboard: rawText, position: pos /* = checkPosition */,
focusOverlay:true}`), `WidgetMenu.vue:158-174` (paste box, dropped),
`item-search/WidgetItemSearch.vue:390-399` (dropped).

### 5.4 Placement: `clickPosition` & DOM layout

`clickPosition` (l.370-379):
```
isBrowserShown ? "inventory"
  : checkPosition.x > window.screenX + window.innerWidth/2 ? "inventory" : "stash"
```
i.e. cursor in the right half of the **game window** → panel goes to the **left of the inventory
panel**; left half → panel goes to the **right of the stash panel**.

DOM (l.1-127):
```
<div root  style="position:absolute; top:0; left:0; width:100%; height:100%"
           class="flex grow h-full pointer-events-none  flex-row (stash) | flex-row-reverse (inventory)">
  <div v-if="!isBrowserShown" class="layout-column shrink-0" style="width: var(--game-panel)"/>   ← spacer over PoE side panel
  <div id="price-window" class="layout-column shrink-0 text-gray-200 pointer-events-auto" style="width: 28.75rem">
     <AppTitleBar .../>                       ← 1.5rem tall
     <div class="grow layout-column min-h-0 bg-gray-800"> … content … </div>
  </div>
  <webview v-if="isBrowserShown" class="pointer-events-auto flex-1" width=100% height=100% />
  <div v-else class="layout-column flex-1 min-w-0">                 ← remaining screen width
     <div class="flex  flex-row|flex-row-reverse">
        <related-items v-if="item ok" class="pointer-events-auto" :click-position/>
        <rate-limiter-state class="pointer-events-auto"/>
     </div>
  </div>
</div>
```
* stash: `[spacer][price-window][related column]` from the left edge.
* inventory (`flex-row-reverse`): visually `[related column][price-window][spacer]` with the spacer
  on the right edge.
* The price-window column is `height:100%` of the overlay = **full game-window height**; its body
  (`bg-gray-800`) fills to the bottom regardless of content.
* Clicks on the transparent parts fall through to the overlay background div (only meaningful when
  the overlay is interactive → `handleBackgroundClick`).

### 5.5 Sizes (exact CSS)

| Element | Size | Px @ fontSize 16 |
|---|---|---|
| `#price-window` | `width: 28.75rem`, height 100% | 460 × game height |
| AppTitleBar (`ui/AppTitlebar.vue:26-33`) | `height:1.5rem; line-height:1.5rem`, bg-gray-900; buttons `px-2 pt-px` | 24 tall |
| Exchange-rate button | `<i fa-exchange-alt> N` (popover on click, boundary `#price-window`) / spinner / `w-8` (2rem) placeholder | |
| spacer | `width: var(--game-panel)` = `0.61625 × game height` | 887.4 @1440p, 665.6 @1080p |
| RelatedItems `.wrapper` (`related-items/RelatedItems.vue:150-168`) | `display:flex; margin-top:1.5rem (mt-6); border:0.25rem; max-width:min(100%,24rem)`; two `w-1/2 p-2` columns; inner side rounded-lg (`inventory`: left-rounded, no right border; `stash`: right-rounded, no left border) | ≤ 384 wide |
| RateLimiterState button (`trade/RateLimiterState.vue:97-105`) | `position:absolute; bottom:0; margin:0 1.5rem (mx-6); padding:0 1rem (px-4); line-height:1.5rem; rounded-t`; text "Rate limiting"; **always rendered**. Static horizontal position = start of the related column (next to the panel), vertical = bottom of the overlay | ≈ 24 + 32 + text ≈ 150 wide, 24 tall |
| RateLimiterState box (when `showRateLimitState`) | `absolute bottom-0 mb-8 (2rem) p-4 border 0.25rem font-sans` | ≈ 300 wide |
| CheckPositionCircle | 5rem circle at cursor, inner 1.25rem dot (§5.9) | 80 |
| Item editor popover (`filters/FiltersBlock.vue:171`, `item-editor/ItemEditorV2.vue:2`) | tippy `placement:"right"`, content `min-w-96 max-w-96` (24rem) — renders **outside** the 28.75rem column | 384 |
| Listing hover tooltip (`trade/TradeItem.vue:196-205`) | tippy `placement:"left"`, item image + text (`px-8`), no boundary — renders **outside** the column | variable (~300-450) |
| Other popovers (FilterModifier `right-start`, OnlineFilter `bottom-start`, FeedbackOption `bottom`) | boundary `#price-window` (preventOverflow only) | |

Tippy (v6.3) appends interactive poppers to the reference's `parentNode` (inside `#price-window`)
but positions them with transforms, so they visually overflow the column.

**Recommended surface width for the port:** `28.75rem + 24rem = 52.75rem` (844 px @16) so related
items, the rate-limit tab/box and flipped popovers fit; with a **dynamic input region** = union of
the visible interactive element rects (§8.5) so the transparent remainder is click-through.
Minimum (if related items/rate-limit are moved inside the column): `28.75rem`.

### 5.6 Hold mode vs locked mode

| | Hold (`Ctrl + D`) | Locked (`Ctrl + Alt + D`) |
|---|---|---|
| shortcut in host config | `${hotkeyHold} + ${hotkey}`, `keepModKeys:true` (only the non-mod key is released before copying; the held modifier is not re-pressed) | `hotkeyLocked`, all keys released before copy |
| `focusOverlay` | false | true |
| main after item-text | nothing (overlay stays click-through) | `assertOverlayActive()` if `wasUsedRecently` |
| renderer | sends `track-area`; `advancedCheck=false` | no track-area; `advancedCheck=true` |
| initial auto-search | `smartInitialSearch` (+ category rules, CheckedItem.vue:181-195) | `lockedInitialSearch` |
| dismissal | §4.3 tracker, or any focus-loss once activated | Esc / Ctrl+W / overlay key / background click (if `overlayBackgroundClose`) / close button / stash-search / game refocus → `hide-on-blur` |

Auto-search details (CheckedItem.vue:181-195): if the relevant setting is off → no search; else
search immediately only for Unique, HeistBlueprint, SanctumRelic, Charm, categories without a trade
id, unidentified or veiled items; otherwise the user must press "Search" (or move the mouse from the
filters onto the Search button area: `handleSearchMouseenter`, l.274-286, also blurs the focused
element).

### 5.7 Focus/blur, Esc, close button, background

* `hide-on-blur` flag → hidden on `focus-change {overlay:false}` (§3.6). With the browser shown the
  flags switch to `invisible-on-blur` (l.381-389): the panel+browser are only invisible while the
  game is focused and come back with the overlay key ("Press {overlayKey} to switch between browser
  and game.", `app.toggle_browser_hint`, l.94-100).
* Esc / Ctrl+W: handled in main only while the overlay has keyboard focus (§4.2). In hold mode the
  overlay has no focus, so Esc goes to the game and does NOT close the panel.
* Close button (`AppTitleBar @close` → `closePriceCheck`, l.391-405):
  1. `overlayAlwaysClose` → `OVERLAY->MAIN::focus-game`;
  2. else if browser shown or `!isElectron` → `wm.hide()`;
  3. else → `OVERLAY->MAIN::focus-game` (→ `hide-on-blur`). Note: `assertGameActive` is a no-op
     when the overlay is not interactable — fine in Electron because the panel cannot be clicked
     then; **not fine in OmaExiled where the panel is clickable without focus** (patch, §8.3).
* Title click (`AppTitleBar @click` → `openLeagueSelection`, l.407-411): finds the `settings`
  widget (`!` — throws if missing), sets `settings::widget=<priceCheck.wmId>`, `wm.show(settings)`
  (which hides the price-check because both are exclusive). Title text = selected league id or
  "Exiled Exchange 2" (l.356-358).
* `MAIN->OVERLAY::hide-exclusive-widget` → `wm.hide(price-check)` (l.342-344).
* `watch(wmWants)`: on `"hide"` → `closeBrowser()` (l.346-353).

### 5.8 Auto-hide rules

Exactly the §4.3 tracker (hold mode) + `hide-on-blur` + exclusive replacement. There is **no**
mouse-leave handler in the renderer and no timeout. (The user's `omarchy_2` branch added a 12 s
arm timeout + dwell ticks for Linux; it is not upstream and was judged unsafe for the game-sized
overlay — irrelevant once the panel is its own surface.)

### 5.9 CheckPositionCircle (`CheckPositionCircle.vue`)

* Rendered when `showCheckPos = wm.active && config.showCursor` (l.366-368) — i.e. **only while the
  overlay is interactive** — inside the panel body with `style="z-index:-1"` (l.58-62).
* Root: `absolute rounded-full`, `width/height 5rem`, `background rgba(255,255,255,0.35)`,
  `box-shadow 0 1px 3px 0 #000, 0 1px 2px 0 #000`; `top = calc(position.y - window.screenY px - 2.5rem)`,
  `left = calc(position.x - window.screenX px - 2.5rem)` (centered on the check point).
  Containing block = the PriceCheckWindow root (full overlay), so it is drawn in **game-window
  coordinates, usually outside the panel**, painted below the panel content.
* Inner dot: `relative rounded-full`, offset `1.875rem/1.875rem`, size `1.25rem`, `rgba(255,255,255,0.5)`.
* Purpose: show which item was checked while the overlay dims the screen (`overlayBackground`).

### 5.10 Built-in browser (`<webview>`)

* `showBrowser(url)` (l.415-420): `setFlag("has-browser", true)`; next tick `iframeEl.src = url`.
  `iframeEl` is an Electron `<webview>` custom element (vite `isCustomElement: tag==="webview"`,
  `vite.config.mts`; `webviewTag:true` in `OverlayWindow.ts:50`).
* When shown: spacer removed, layout forced to "inventory" (`flex-row-reverse`) → price column at
  the right edge of the game window and the webview fills **all remaining width** (`flex-1`).
* Consumers of the `"builtin-browser"` injection:
  * `TradeLinks.vue:51-63`: two-button (internal + external) only if `isElectron && builtinBrowser`,
    else a single button doing `window.open(link)`.
  * `TradeBulk.vue:277-282` error "Browser" button: builtin if `builtinBrowser && isElectron`, else `window.open`.
  * `TradeListing.vue:267-269` error "Browser" button: **always** `showBrowser(makeTradeLink())`.
  * `BackgroundInfo.vue:58-60` leagues-failed "Browser" button: **always**
    `showBrowser("https://<poeWebApi()>/api/trade2/data/leagues")` — this is the Cloudflare /
    login recovery path: the `<webview>` shares Electron's `session.defaultSession` cookie jar with
    the HTTP proxy (`proxy.ts:45-54` `useSessionCookies:true`, UA = `app.userAgentFallback`;
    `onHeadersReceived` strips `Partitioned` from `set-cookie`, l.77-90).
* Settings warning `builtin_browser_warning` ("…can potentially steal my POESESSID").
* External links: `window.open()` and `<a target="_blank">` (e.g. CheckedItem.vue support links)
  rely on Electron's `setWindowOpenHandler → shell.openExternal`.

### 5.11 Other panel content

* `background-info` (updater notice — updater is dropped; leagues loading/error with Retry/Browser).
* error branch (l.63-82): `ui-error-box` with translated name/message, `reload-trade-data`
  (`:item-text="item.error.rawText" :pos="checkPosition"`), raw text `<pre>`.
* ok branch: `unidentified-resolver` (emits `identify` → replace item) and `checked-item`
  (only if a league is selected).
* Keyboard-dependent features inside the panel: numeric/text inputs in filters (need keyboard
  focus), Shift-hold tooltips (`itemHoverTooltip:"keybind"`, window `keydown`/`keyup` with
  `event.key==="Shift"`, TradeItem.vue:170-192; TradeListing.vue:211-232 tracks Shift too).

---

## 6. Item-check widget (`item-check/WidgetItemCheck.vue`)

### 6.1 Spec & config (l.19-57; type `item-check/widget.ts:1-13`)

| Key | Default | Purpose |
|---|---|---|
| `wmZorder` | `"exclusive"` | modal (hides price-check / settings when shown) |
| `wmFlags` | `["hide-on-blur","menu::skip"]` | |
| `hotkey` | `null` (user wants `Alt + D`; must be set in OmaExiled defaults if desired) | shortcut → `copy-item`, target `item-check`, `focusOverlay:true` (Config.ts getConfigForHost) |
| `wikiKey` | null | `copy-item` target `open-wiki` |
| `poedbKey` | null | `open-poedb` |
| `craftOfExileKey` | null | `open-craft-of-exile` (settings UI shows it only for English) |
| `stashSearchKey` | null | `search-similar` |
| `samePricedKey` | null | `search-same-priced` |
| `samePricedType` | `"both"` (`"price"`) | include item name in same-price search if `note.length+name.length < 51` |
| `maps` | `{profile:1, showNewStats:false, selectedStats:[…4 entries]}` | MapCheck only (dropped) — keep in JSON |

### 6.2 Behavior

* Setup: `registerActions()` (l.80) — subscribes to item-text for the 5 action targets
  (`hotkeyable-actions.ts:85-113`): parses clipboard, then
  `openWiki` → `window.open("https://www.poe2wiki.net/wiki/<refName>")`,
  `openPoedb` → `window.open("https://poe2db.tw/<lang>/<path>")` (`POEDB_LANGS`, `getPoe2dbPath`),
  `openCoE` → `window.open("https://craftofexile.com/?game=poe2&eimport=<encodeURIComponent(rawText)>")`,
  `findSimilarItems` → `CLIENT->MAIN::user-action {action:"stash-search", text: JSON.stringify(info.name)}`,
  `findSamePricedItems` → same with `note` (+ name). These need no window and run in whichever
  renderer has the item-check widget mounted.
* `props.config.wmWants = "hide"` at setup (l.92).
* item-text with `target:"item-check"` (l.82-90): `checkPosition = e.position`;
  `item = parseClipboard(e.clipboard).unwrapOr(null)`; **only if parse ok** → `wm.show()`.
  (Main still activates the overlay for `focusOverlay:true` even if parsing fails.)
* No track-area; closes only through `hide-on-blur` (Esc, Ctrl+W, overlay key, background click,
  game refocus, stash-search button which calls `assertGameActive`), the hover "Hide" action,
  or another exclusive widget being shown. Does **not** listen to `hide-exclusive-widget`.
* Content: `MapCheck` if map-like (non-unique Map, HeistContract, HeistBlueprint, Invitation,
  "Expedition Logbook") else `ItemInfo` (l.8-11, 111-125). **Map check is dropped in OmaExiled →
  render `ItemInfo` for everything** (or nothing for map-likes — product decision).

### 6.3 Placement (`anchor`, l.94-109) — exact

```
width = wm.size.width; panel = wm.poePanelWidth
side  = checkPosition.x > window.screenX + width/2 ? "inventory" : "stash"
anchor = side==="stash" ? { pos:"cl", x: panel/width*100, y:50 }
                        : { pos:"cr", x: (width-panel)/width*100, y:50 }
```
Passed to `<Widget :config="{...config, anchor}" move-handles="none" :removable="false" :inline-edit="false">`
→ vertically centered on the game window; left edge touching the stash panel (stash) or right edge
touching the inventory panel (inventory). Hover action panel shows "Hide" and "Edit" (Edit opens
settings at item-check: `[SettingsItemcheck, SettingsMaps]`), placed `top:0;left:100%` (stash,
x≤50,y=50) or `top:0;right:100%` (inventory) — i.e. on the screen-center side.

### 6.4 Sizes (`ItemInfo.vue:2-5`)

`bg-gray-800 text-gray-200 border-gray-900 border-4 (0.25rem) flex flex-col`,
`min-width: 20rem; max-width: min(100vw - var(--game-panel), 30rem)` → **320–480 px @16**;
height = content: title row (`bg-gray-900 py-1 px-4`), button row (`flex gap-1 py-1`: wiki, poedb,
[CoE if `info.craftable && itemIsModifiable`], ⋮, "Find in stash", [$ if `item.note`]), optional DPS
grid (`my-2`, 3 rows). Roughly 4–8 rem tall. Action panel adds ≈ 3–4 rem width on hover.
`--game-panel` must be defined in the standalone page (set `0px`).

---

## 7. Stash-search widget parts (`stash-search/**`)

* Config type (`widget.ts:1-12`): `StashSearchWidget extends Widget { anchor: Anchor; enableHotkeys: boolean;
  entries: Array<{id:number; name:string; text:string; hotkey:string|null}> }`.
* Defaults (`WidgetStashSearch.vue:41-90`): two instances `"Map rolling"` (anchor tl 35/46, 4 entries)
  and `"Dump sorting"` (anchor tl 34/56, 6 entries), `wmZorder:null`, `wmFlags:["invisible-on-blur"]`,
  `enableHotkeys:true`, hotkeys null.
* Overlay UI (l.1-29): `Widget` with `move-handles="corners"`, `inline-edit=false`; title + "enable
  keys" toggle (only if any entry has a hotkey); a button per entry (`max-w-sm` 24rem, `p-2 leading-4`,
  ellipsis) → `CLIENT->MAIN::user-action {action:"stash-search", text}` (l.131-136). Visible only
  while the overlay is active (invisible-on-blur) and `wmWants:"show"` (toggled from the widget menu).
* `watch(enableHotkeys) → pushHostConfig()` (l.142-147).
* "uninitialized" init (l.112-129) runs **only when the component mounts**: flags, random tl anchor
  20–40%, `enableHotkeys:true`, `entries:[{id:1,text:"Currency",name:"",hotkey:null}]`, `wm.show()`.
* Hotkeys: `getConfigForHost` (Config.ts:780-794) emits `{shortcut: entry.hotkey, action:{type:"stash-search", text: entry.text}}`
  for every stash-search widget with `enableHotkeys` and non-null entry hotkeys.
* Editor (`stash-search-editor.vue`): props `configProp<StashSearchWidget>()` (`config`, `configWidget`),
  edits `wmTitle`, drag-reorders `entries` (vuedraggable, handle `[data-qa=drag-handle]`), per-entry
  text (red if `> 250` chars, l.32), friendly name, hotkey; add/remove entries.
  **In SettingsWindow it is only reachable via a stash-search widget's hover "Edit" button**
  (`menuByType("stash-search")`, SettingsWindow.vue:340-341) — the default settings menu does
  not list it.
* Port: the floating stash-search panels are an overlay concept → drop the UI; keep entries +
  hotkeys + `enableHotkeys`; the settings window needs its own "Stash search" section listing all
  `stash-search` widgets, with add (must initialize all fields itself because
  `WidgetStashSearch` never mounts), delete, and the editor. Optionally the bar plugin can list
  entries (click → backend focuses PoE2 then runs the stash search).

---

## 8. Minimal per-widget shell (replacement for OverlayWindow.vue)

Goal: one page per surface: `index.html?widget=price-check` and `index.html?widget=item-check`
(settings is a normal window, see settings notes). Each page mounts exactly one widget component.

### 8.1 What the shell must provide

1. `provide("wm", WidgetManager)` — compatible object:
   * `poePanelWidth: computed(() => 0)` and CSS var `--game-panel: 0px` on the container (placement
     moved to the compositor; `ItemInfo` max-width then = `min(100vw, 30rem)`).
   * `size`: window inner size (as original).
   * `active: Ref<boolean>` — OmaExiled meaning: "this surface currently has keyboard focus"
     (from Qt focus in/out → backend → `MAIN->OVERLAY::focus-change`), or simply the panel was
     clicked. Used by `showCheckPos` and `hide-on-blur` logic.
   * `widgets`: `computed(() => AppConfig().widgets)`.
   * `show(id)`: if `id` is the hosted widget → `wmWants="show"`. If `id` is the `settings` widget
     → send a NEW event (e.g. `CLIENT->MAIN::open-settings {widgetWmId?: number}`) using the pending
     `settings::widget=<id>` flag, and do not touch the hosted widget. (Covers
     `openLeagueSelection` and `Widget.vue` "Edit" without patching them.)
   * `hide(id)`: `wmWants="hide"`.
   * `setFlag`: same as original (needed for `has-browser` switching and `settings::widget=`).
   * `bringToTop`, `create`, `remove`: no-ops (or original logic; no numeric-zorder widget needed).
2. The `"builtin-browser"` injection is provided by PriceCheckWindow itself — nothing to do in the
   shell, but its behaviour must be changed (§8.3).
3. Global side effects formerly in OverlayWindow: `usePoeninja()` and `useLeagues().load()` in the
   price page (PriceCheckWindow also calls `usePoeninja()`); client-log handling dropped;
   `pushHostConfig()` from exactly ONE place (recommended: backend computes hotkeys itself, or only
   the settings/price page pushes) — never from every page.
4. Listen to `MAIN->OVERLAY::hide-exclusive-widget` → `wm.hide(hosted)` (PriceCheckWindow already
   does; item-check does not, so the shell must).
5. Listen to `MAIN->OVERLAY::focus-change` → update `active`; on a **true→false transition only**
   hide the hosted widget if it has `hide-on-blur` (lesson from the user's omarchy branches).
6. Visibility: render the widget with `v-show="widget.wmWants === 'show'"` (no exclusive/hideUI
   logic needed; optional Alt-hide via `MAIN->OVERLAY::visibility`).
7. Report state to the backend: `watch(() => widget.wmWants, w => send OVERLAY->MAIN::render-state
   {shouldShow: w==="show"})` (reuse the existing event name, now per-client) + input region / size
   (§8.5).
8. Save policy: after the hosted widget goes from show→hide call `saveConfig()` on `nextTick`
   (replicates OverlayWindow.vue:312-326; `saveConfig` is a no-op while the widget is shown). Do not
   rely on `window blur` (a never-focused panel never blurs).
9. Container: `<div id="overlay-window" class="relative overflow-hidden" style="width:100vw;height:100vh;--game-panel:0px">`
   so the absolute PriceCheckWindow root (`top:0;left:0;100%×100%`) fills the surface.
10. `window.open` / `target=_blank`: either the Qt host implements `QWebEnginePage::createWindow`
    (capture the URL, `xdg-open` it, discard the page) or the shell overrides `window.open` and a
    capturing click listener for `a[target=_blank]` → NEW `CLIENT->MAIN::open-external {url}`.

Sketch:
```ts
// WidgetPage.vue (replaces OverlayWindow.vue for per-widget pages)
const wmType = new URLSearchParams(location.search).get("widget")!;   // "price-check" | "item-check"
const widget = computed(() => AppConfig().widgets.find(w => w.wmType === wmType)!);
const active = shallowRef(false);
const size = /* same as OverlayWindow.vue:180-192 */;
function find(id: number) { return AppConfig().widgets.find(w => w.wmId === id); }
provide<WidgetManager>("wm", {
  poePanelWidth: computed(() => 0), size, active,
  widgets: computed(() => AppConfig().widgets),
  show(id) {
    const w = find(id)!;
    if (w.wmType === "settings") {
      const f = w.wmFlags.find(f => f.startsWith("settings::widget="));
      Host.sendEvent({ name: "CLIENT->MAIN::open-settings" /* NEW */, payload: { wmId: f ? Number(f.split("=")[1]) : null } });
      if (f) w.wmFlags = w.wmFlags.filter(x => x !== f);
      return;
    }
    w.wmWants = "show";
  },
  hide(id) { find(id)!.wmWants = "hide"; },
  remove() {}, bringToTop() {}, create() {},
  setFlag(id, flag, state) { /* copy of OverlayWindow.vue:211-227 */ },
});
Host.onEvent("MAIN->OVERLAY::hide-exclusive-widget", () => { widget.value.wmWants = "hide"; });
Host.onEvent("MAIN->OVERLAY::focus-change", (s) => {
  const was = active.value; active.value = s.overlay;
  if (was && !s.overlay && widget.value.wmFlags.includes("hide-on-blur")) widget.value.wmWants = "hide";
});
watch(() => widget.value.wmWants, (w, prev) => {
  Host.sendEvent({ name: "OVERLAY->MAIN::render-state", payload: { shouldShow: w === "show" } });
  if (prev === "show" && w === "hide") nextTick(() => saveConfig());
}, { immediate: true });
```

### 8.2 Bootstrap changes

* `main.ts`: choose the root by `?widget=` (price/item → `WidgetPage`, `settings` → settings shell).
* `IPC.ts` `init()`: connect to `ws://${location.host}/events${location.search}` (or send a NEW hello
  event) so the backend knows which surface/role a socket belongs to.

### 8.3 Renderer patches required (file:line → change)

| Location | Problem in OmaExiled | Change |
|---|---|---|
| `background/IPC.ts:51-53` | drops all `MAIN->OVERLAY::*` events unless UA contains "Electron" | replace `isElectron` with a host-mode flag (e.g. UA contains `OmaExiled`, set by the Qt host via `QWebEngineProfile::setHttpUserAgent`, or a query param), and accept overlay events |
| `background/IPC.ts:88-90` (`isElectron`) and every use: OverlayWindow.vue (replaced), `PriceCheckWindow.vue:265,397`, `TradeLinks.vue:52`, `TradeBulk.vue:278`, `WidgetDelveGrid.vue:68` (dropped) | semantics differ per site | decide per site (rows below) |
| `PriceCheckWindow.vue:265-290` (track-area) | uses `window.screenX/innerWidth` (no global window position on Wayland; QtWebEngine reports ~0) → wrong `area` | keep sending for `holdKey`/`closeThreshold`/`from`, but backend must ignore `area` and use its own surface geometry; or replace with a NEW slimmer event |
| `PriceCheckWindow.vue:370-379` (`clickPosition`) | `window.screenX + innerWidth/2` is the panel surface, not the game window → side nearly always "inventory" | use backend-provided geometry: `checkPosition.x > game.x + game.width/2` (game bounds via a NEW `MAIN->OVERLAY::game-bounds {x,y,width,height}` event or optional extra fields on item-text, stored in a shell store / `wm`) |
| `PriceCheckWindow.vue:391-405` (`closePriceCheck`) | `focus-game` path relies on the overlay being interactable; panel is clickable without focus | always `wm.hide()` (+ optionally send `OVERLAY->MAIN::focus-game` so the backend returns keyboard focus to PoE2 if the panel had it); keep `overlayAlwaysClose` irrelevant |
| `PriceCheckWindow.vue:103-109, 413-424` (`<webview>`, `showBrowser`) | `<webview>` does not exist in QtWebEngine; iframing pathofexile.com is very likely blocked by frame headers | v1: make `showBrowser(url)` open externally (NEW `CLIENT->MAIN::open-external` / `window.open`) and never set `has-browser`; force `TradeLinks.builtin=false`, `TradeBulk` external. The Cloudflare/login recovery (BackgroundInfo, TradeListing error) then needs a Qt-native browser window sharing cookies with the Bun proxy (open question) |
| `CheckPositionCircle.vue:37-42` | `window.screenX/Y`; circle lies outside the panel surface | drop (`showCursor` ignored) or draw natively (§9) |
| `WidgetItemCheck.vue:94-109` (`anchor`) | `window.screenX`, `wm.size`, `poePanelWidth` assume full-screen overlay | side from backend geometry; in a content-sized surface just render content at (0,0) (anchor `tl` 0/0) — the compositor places the surface |
| `WidgetItemCheck.vue:8-11` | MapCheck dropped | always `ItemInfo` (remove MapCheck import) |
| `item-check/ItemInfo.vue:4`, `map-check/MapCheck.vue:4` | use `var(--game-panel)` | define `--game-panel:0px` in shell |
| `Config.ts:751-766, 839` (`getConfigForHost`) | `AppConfig("library")`/`AppConfig("delve-grid")` dereferenced without null-check → TypeError if those widgets are removed from registry/config | guard or delete those blocks (port to backend) |
| `PriceCheckWindow.vue:408`, `Widget.vue:322-324`, `SettingsWindow.vue` | `find(w => w.wmType==="settings")!` | keep a `settings` widget entry in config (or patch) |
| `OverlayWindow.vue:297-310` logic (if reused) | assumes a numeric-zorder widget (menu) exists | not reused by the shell |
| `trade/TradeItem.vue:170-192` | Shift tooltip needs window keydown/keyup; the panel normally has no keyboard focus | host injects synthetic `KeyboardEvent("keydown"/"keyup", {key:"Shift"})` into the page when the backend sees Shift (non-consuming Hyprland bind) — or default `itemHoverTooltip` to `"always"`/`"off"` |

### 8.4 Event routing (replace "last-active")

* Identify each WS client by role (`price-check`, `item-check`, `settings`).
* Route `MAIN->CLIENT::item-text` by `target`:
  `price-check` → price page; `item-check`, `open-wiki`, `open-poedb`, `open-craft-of-exile`,
  `search-similar`, `search-same-priced` → item page (it runs `registerActions()`; keep that page
  loaded even while hidden). Never broadcast these targets to several pages (duplicate
  `window.open`/stash searches). `log-item` (library) dropped.
* `MAIN->OVERLAY::hide-exclusive-widget` / `focus-change` / `visibility` → only to the affected page.
* `MAIN->CLIENT::config-changed` → broadcast (all pages keep their config copy in sync).
* `CLIENT->MAIN::used-recently` becomes unnecessary (keep accepting it; ignore).
* Exclusivity is now the backend's job: showing the price surface must hide the item surface and
  vice versa (send `hide-exclusive-widget` to the other page + unmap it). Showing a panel must
  **not** close the settings window (in EE2 it did, because settings was exclusive in the same overlay).

### 8.5 Show/hide, size and input-region protocol (proposal)

* Renderer → backend: `OVERLAY->MAIN::render-state {shouldShow}` per page (existing name/payload).
* Renderer → backend (NEW, e.g. `OVERLAY->MAIN::input-region {rects: Array<{x,y,width,height}>}`
  in CSS px, surface-local): union of `getBoundingClientRect()` of `#price-window`, the related-items
  wrapper, the rate-limiter button/box (all carry `.pointer-events-auto`), and every
  `[data-tippy-root]`; recompute on DOM/size changes (ResizeObserver + MutationObserver, or a rAF
  diff loop while visible, send only on change). Qt host applies it with `QWindow::setMask(QRegion)`
  (QtWayland maps the mask to `wl_surface.set_input_region` — verify) so the transparent rest of
  the 52.75rem surface is click-through.
* Item page (NEW, e.g. `OVERLAY->MAIN::content-size {width,height}`): measured size of the
  `ItemInfo` root (inline-block container) so the host can resize the surface
  (`LayerShellQt::Window::setDesiredSize` / `QWindow::resize`).
* Backend → renderer: geometry needed by the renderer (`game-bounds` / side) **before** the
  corresponding `item-text`.
* Ordering: backend sends `item-text` to the page, and maps the surface either immediately or on the
  page's `render-state {shouldShow:true}`. Beware Chromium throttling of hidden pages (rAF paused,
  timers clamped): the first frame after unhiding may lag; measure, and consider mapping the
  surface as soon as the hotkey fires.

---

## 9. Overlay-concept behaviors → layer-shell redesign

Geometry inputs the backend needs (all in **logical** compositor px; Hyprland `hyprctl -j monitors`
gives `x,y,width,height` in physical px plus `scale`; `hyprctl -j clients` gives `at`/`size` of the
PoE2 client; `hyprctl -j cursorpos` gives `{x,y}`; verify units with scale ≠ 1 and XWayland
`force_zero_scaling`). This machine: one monitor DP-1 2560×1440 @ scale 1.

Let `G = {x,y,w,h}` = PoE2 client rect (equals the output when fullscreen), `O` = output rect,
`fs` = `config.fontSize`, `P = G.h × 986/1600` (PoE side-panel width), `side = cursor.x > G.x + G.w/2 ? inventory : stash`.

| EE2 behavior | OmaExiled replacement |
|---|---|
| Full-screen transparent overlay, widgets absolutely positioned | one `LayerShellQt::Window` per panel: `layer = LayerOverlay` (above fullscreen), `exclusiveZone = -1` (ignore the bar's zone so offsets are from the output edge), `scope = "omaexiled-price"` / `"omaexiled-item"`, `screen` = monitor of PoE2 |
| Price panel placement (spacer + flex direction) | **stash:** anchors `Top|Bottom|Left`, margins `left = (G.x-O.x)+P`, `top = G.y-O.y`, `bottom = (O.y+O.h)-(G.y+G.h)`; **inventory:** anchors `Top|Bottom|Right`, margin `right = (O.x+O.w)-(G.x+G.w)+P`, same top/bottom. Width `52.75·fs` (or `28.75·fs` minimal). Renderer keeps `flex-row` (stash) / `flex-row-reverse` (inventory) so `#price-window` sits on the anchored edge. Example 1440p, fs 16: P = 887.4 → stash surface x = 887..1731; inventory surface right edge at 1672.6 (price column 1212.6..1672.6) |
| Item-check placement (`cl`/`cr`, y 50%) | anchors `Left` (stash, margin-left `(G.x-O.x)+P`) or `Right` (inventory, margin-right `(O.x+O.w)-(G.x+G.w)+P`), **no top/bottom anchor → compositor centers vertically** (with `exclusiveZone=-1`); for a non-fullscreen game add `Top` anchor with `margin-top = G.y-O.y + (G.h - h)/2`. Size = reported content size (320–480 × ~64–128 @16) |
| Overlay focus (`active`), click-through until activated | surface is natively mouse-interactive within its input region; `keyboardInteractivity = OnDemand` (focus only when clicked, needed for typing in filters) with **`setActivateOnShow(false)`** (LayerShellQt default `true` would steal focus on show); or `None` if typing is not needed. Verify Hyprland does not focus on-demand layers on map |
| `focus-change` / `hide-on-blur` | host reports focus in/out of the surface; backend → `focus-change {game, overlay}` to that page; hide only on a true→false transition. Also hide all panels when the active Hyprland window changes away from PoE2 (alt-tab), treating "an OmaExiled layer has keyboard focus" as still in game context (verify what `socket2 activewindow` reports when a layer surface is focused — the bind-activation logic must not drop the hotkeys in that state) |
| Esc / Ctrl+W (overlay focused) | game focused: a **consuming** Hyprland bind for `Escape` registered only while a panel is visible (EE2 locked mode never let Esc reach the game; hold mode let it through and did not close the panel — choose; consuming bind recommended). Panel focused: Qt host intercepts `Escape`/`Ctrl+W` (and the overlay key) before the page and asks the backend to hide + return focus (mirrors `handleExtraCommands`) |
| Hold-mode tracker (§4.3) | backend state machine: `inside(area)` ↔ host pointer `Enter`/`Leave` on the surface (input-region aware); `mousedown inside` ↔ host mouse press → "pinned"; `distance from from` ↔ poll cursor via Hyprland IPC socket (`j/cursorpos`, ~30–50 ms) only while armed & not entered; `modifier === holdKey` ↔ hold-key release detection (Hyprland has no modifier query: use temporary non-consuming release binds, e.g. `bindrn` on `Control_L`/`Control_R` or `Alt_L`/`Alt_R`, notifying the backend). Close = `hide-exclusive-widget` + unmap. No focus is ever moved on hover (the user's "no hover activation" safety rule is satisfied) |
| Locked mode keeps overlay focused | panel stays mapped (game keeps keyboard focus) until: Esc bind, close button, next check (exclusive replace), PoE2 losing focus, or click-outside if the panel had keyboard focus (focus-out). Clicking the game while the panel is not focused cannot be detected — accept |
| Overlay background dim + click-to-close (`overlayBackground`, `overlayBackgroundClose`, `overlayAlwaysClose`) | dropped (no full-screen surface). Keep keys in config for compatibility, hide them in settings |
| Alt-hold hides UI (`MAIN->OVERLAY::visibility`) | optional: non-consuming press/release binds on Alt → `visibility` to pages (275 ms delay); recommend dropping in v1 |
| `render-state` + `hideOverlayOnBlur` | per-page `render-state` maps/unmaps that page's surface; `hideOverlayOnBlur` obsolete. Unmap when hidden (a mapped transparent overlay surface above the fullscreen game costs compositing/direct scanout) |
| Exclusive modal logic | backend: only one of price/item visible; settings is an independent normal window |
| CheckPositionCircle (only while overlay active) | drop, or optional tiny native Qt layer surface (80×80 logical @16, `LayerOverlay`, anchors Top|Left, margins = cursor − 40, empty input region / `Qt::WindowTransparentForInput`), shown while the panel has focus |
| Built-in `<webview>` browser (+ `invisible-on-blur`, overlay-key toggle) | drop; external browser via `xdg-open`/`omarchy-launch-browser`. Captcha/login cookie path → separate decision (Qt browser window + cookie export to backend, matching UA) |
| `overlay-attached` toast (`showAttachNotification`) | optional `notify-send` from backend when PoE2 window appears |
| Widget menu, paste-to-price-check box, `logKeys` log overlay, "continue editing" banner | dropped (bar plugin may offer "price check clipboard" → backend sends item-text `focusOverlay:true`) |
| `window.open` → `shell.openExternal` | Qt `createWindow` capture or renderer shim → backend `xdg-open` |
| Stash-search floating widgets (visible when overlay active) | dropped; hotkeys kept; editor moves to settings; optional bar-plugin list |
| `wasUsedRecently`/`last-active` | role-based routing (§8.4) |

---

## 10. CSS size table (rem → px at default fontSize 16; multiply rem by `fontSize`)

| Thing | rem | px @16 |
|---|---|---|
| Price column `#price-window` width | 28.75 | 460 |
| Price title bar height | 1.5 | 24 |
| Related items max width (incl. 0.25rem border) / top margin | 24 / 1.5 | 384 / 24 |
| Recommended price surface width | 52.75 | 844 |
| Hold-mode close threshold (`closeThreshold`) | 2.5 | 40 |
| Rate-limit tab: margin-x / padding-x / height | 1.5 / 1 / 1.5 | 24 / 16 / 24 |
| Rate-limit box bottom margin | 2 | 32 |
| Item editor popover width | 24 | 384 |
| CheckPositionCircle / inner dot / inner offset / center offset | 5 / 1.25 / 1.875 / 2.5 | 80 / 20 / 30 / 40 |
| ItemInfo min / max width, border | 20 / 30, 0.25 | 320 / 480, 4 |
| Scrollbar width | 0.875 | 14 |
| PoE side panel (`--game-panel`) | – | `0.61625 × game height` (887.4 @1440, 665.6 @1080) |
| Settings window (normal window, for reference) | max 50 × 38 (+ patrons strip above) | 800 × 608 |

---

## 11. Config keys touched by this area (disposition)

* Global: `fontSize` (keep — rem base, surface sizing), `overlayKey` (keep — repurpose: e.g. give the
  visible panel keyboard focus / toggle; also shown in hint strings), `overlayBackground`,
  `overlayBackgroundClose`, `overlayAlwaysClose`, `hideOverlayOnBlur`, `showAttachNotification`
  (overlay-only; keep in JSON, hide/repurpose in UI), `logKeys` (debug), `windowTitle` (game
  detection — backend notes), `widgets[]` (keep, incl. a `settings` entry).
* Price-check: all keys in §5.1 (keep; `builtinBrowser` and `showCursor` become no-ops unless the
  native alternatives are built).
* Item-check: §6.1 (keep; `maps` unused).
* Stash-search: §7 (keep).

---

## 12. Edge cases & gotchas

1. `Host.onEvent` silently drops `MAIN->OVERLAY::*` when not Electron (IPC.ts:51) — the #1 trap.
2. Wayland gives no global window position: anything using `window.screenX/screenY` (PriceCheckWindow
   l.269-274, 374; CheckPositionCircle l.39-40; WidgetItemCheck l.99; WidgetMenu l.166-167) is wrong
   in QtWebEngine.
3. `item-text.position` must stay in the same coordinate space as the backend's game bounds
   (global logical px) because `ReloadTradeData` replays it (`:pos="checkPosition"`).
4. Item-check shows only if parsing succeeds; the backend should not map the surface until the page
   says `render-state {shouldShow:true}` (otherwise an empty surface appears).
5. `saveConfig` is blocked while an exclusive widget is shown; per-page shells must save on hide.
   Multiple pages each hold a full config copy: a page that saves later can overwrite another page's
   unsaved changes only through its own mutations (config-changed resyncs others) — keep config
   writes rare and save immediately on hide.
6. All widgets were always mounted in EE2 (v-show), so listeners like `registerActions()` were
   always active; in per-widget pages make sure each listener lives in exactly one loaded page.
7. Price-check `wmFlags` are reset on mount; `has-browser` never persists.
8. `ui-popover boundary="#price-window"` uses `document.querySelector` at mount — the id must stay.
9. Shift-tooltips (`itemHoverTooltip:"keybind"`, the default) and text inputs need keyboard focus.
10. The rate-limit tab is always rendered and lives outside the 28.75rem column (bottom of the
    surface, next to the column) — include it in the surface width and input region.
11. `getConfigForHost` crashes if `library`/`delve-grid` widgets are missing.
12. Default `item-check.hotkey` is `null`; the requested Alt+D must be an OmaExiled default.
13. LayerShellQt `activateOnShow` defaults to `true` → would steal focus from the game on every show.
14. Layer animations: Hyprland may animate layer surfaces (fade/slide); disable for the
    `omaexiled-*` namespaces with a layer rule (check the 0.56 `layerrule` syntax).
15. Upstream Linux lesson (user branches `omarchy*`): repeated `overlay:false` focus events under
    XWayland; never hide on a non-transition. Never auto-focus on hover.

---

## 13. System packages relevant to this area (checked on this machine, read-only)

Installed: `qt6-base 6.12.0`, `qt6-wayland 6.12.0`, `qt6-declarative 6.12.0`, `qt6-webengine 6.11.2`
(this is the current Arch `extra` version; it lags qt6-base — not runtime-tested here),
`qt6-webchannel 6.12.0`, `layer-shell-qt 6.8.1` (headers `/usr/include/LayerShellQt`, CMake config
`/usr/lib/cmake/LayerShellQt` — only depends on Qt6Gui, no ECM needed; QML module
`org.kde.layershell`), `wl-clipboard 2.3.0`, `bun 1.4.3`, `base-devel`/`gcc 16`, `xdg-utils`,
`hyprland 0.56.2`, `quickshell`.

Missing for building the Qt6 host: **`cmake`** (and recommended `ninja`):
`sudo pacman -S --needed cmake ninja` (`qmake6` exists as a fallback, but LayerShellQt ships a
CMake package config).
