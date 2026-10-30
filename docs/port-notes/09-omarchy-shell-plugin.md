# 09 — Omarchy shell (Quickshell) plugin API: the OmaExiled bar widget

Scope: everything needed to replace EE2's Electron tray icon (`main/src/AppTray.ts`) with an
omarchy-shell bar widget: manifest, the QML contract a bar widget gets from the host, the UI kit,
how a widget talks to the long-running Bun backend, install/enable/reload/debug, IPC targets,
and a skeleton that was loaded and exercised on this machine.

Sources read (read-only): `/usr/share/omarchy/shell/{README.md,shell.qml,Commons/**,Ui/**,services/**}`,
`/usr/share/omarchy/shell/plugins/{README.md,bar/**,panels/{power,tailscale,clock,weather}/**,menu/**,agents/**}`,
`/usr/share/omarchy/bin/{omarchy-shell,omarchy-plugin-*,omarchy-bar,omarchy-restart-shell,omarchy-launch-shell}`,
`~/.config/omarchy/plugins/{ultra.agents,com.omastorm.radar}/**`, Quickshell type info in
`/usr/lib/qt6/qml/Quickshell/**/*.qmltypes`, EE2 `main/src/{AppTray.ts,main.ts,server.ts}`,
`OmaExiled/DESIGN.md`.

Versions on this machine: Omarchy `4.0.0.alpha` (`/usr/share/omarchy/version`), `OMARCHY_PATH=/usr/share/omarchy`,
quickshell `0.3.2.r7.g2b4501a-1` (repo `omarchy`, "distributed by Omarchy"), Qt base/declarative 6.12.0,
bun 1.4.3.

All line numbers below refer to those files as installed on 2026-10-30.

---

## 0. TL;DR / decisions for implementers

- Ship the widget as a **third-party plugin** with `kinds: ["bar-widget"]`, id `omaexiled`, installed at
  `~/.config/omarchy/plugins/omaexiled/` (directory name = manifest id). Source lives in the repo at
  `omarchy-plugin/` (as DESIGN.md already says) and is **copied** there, not symlinked (see §7.4).
- Root the widget on `qs.Ui` `Panel` + `BarIconButton` + `KeyboardPanel` exactly like first-party
  `omarchy.power` / `omarchy.tailscale` and the user's `ultra.agents`. That gives the popup, outside-click
  dismissal, one-popup-at-a-time, theme colours, Esc/j/k/Enter keys, and makes
  `omarchy-shell shell toggle omaexiled` work for free.
- Talk to the backend over a **Unix stream socket with newline-delimited JSON**
  (`$XDG_RUNTIME_DIR/omaexiled/shell.sock`): backend pushes `hello` + full `state` on connect and on
  every change; widget sends `{"v":1,"type":"open-settings"}` / `{"v":1,"type":"quit"}`. This is the
  pattern Omastorm uses (Rust engine ⇄ Quickshell `Socket`), and Quickshell `Socket` ⇄ Bun
  `Bun.listen({unix})` was verified end-to-end on this machine (§9). HTTP from QML (`XMLHttpRequest`
  GET/POST to Bun) was also verified and is the fallback if DESIGN.md's `/api/status` + `/api/action`
  shape is kept — but it needs port discovery and polling (§8.4).
- "Open in Browser" / "Open config folder" are done by the widget itself with
  `Quickshell.execDetached(["env","-C",$HOME,"xdg-open", <url|dir>])` using `state.url` / `state.configDir`.
- Never run the backend as a QML `Process` child of the widget: every file write under
  `~/.config/omarchy/plugins/**` (any plugin) hot-reloads all plugin widgets and would kill it. Start it
  with `Quickshell.execDetached` (or better: systemd user unit; the widget only offers "Start").
- A plugin **can** expose `IpcHandler` targets callable with `omarchy-shell <target> <fn> [args]` /
  `qs ipc -p $OMARCHY_PATH/shell call …` (verified: Omastorm's `theme` target and `ultra.agents`'s
  `omarchy.agents` target are live in the running shell).
- Nothing needs to be installed for this area (§1).

---

## 1. System requirements (answer to "what do I have to install")

Everything the bar plugin needs is already installed:

| Package | Installed | Used for |
|---|---|---|
| `quickshell` | 0.3.2.r7.g2b4501a-1 (repo `omarchy`) | runs omarchy-shell; `Quickshell.Io` `Socket`, `Process`, `FileView`, `IpcHandler` |
| `qt6-declarative` | 6.12.0-2 | QML engine (incl. `XMLHttpRequest`) |
| `inotify-tools` | 4.26.270-1 | the registry's `inotifywait` hot-reload watcher (`PluginRegistry.qml` L663-676) |
| `jq` | 1.8.2-1 | `omarchy plugin …` / `omarchy bar …` scripts |
| `gum` | 2.0.2-1 | interactive prompts of `omarchy plugin add/update/remove` |
| `xdg-utils` | 1.2.1-2 | `xdg-open` for "Open in Browser" (default browser `omarchy-browser.desktop`) and "Open config folder" (`inode/directory` → `org.gnome.Nautilus.desktop`) |
| `bun` | 1.4.3-1 | backend; `Bun.listen({unix})` verified against Quickshell `Socket` |
| `socat` | 1.8.1.3-1 | optional: inspect the backend socket (`socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/omaexiled/shell.sock`) |
| fonts | `JetBrainsMono Nerd Font` is `fc-match monospace` | bar font = Nerd Font, so Font Awesome / Material glyph codepoints render |

Not needed: `qt6-websockets` (not installed; only required if QML were to use the `WebSocket` type — the
socket/XHR designs below do not). Other areas (Qt host) depend on `qt6-webengine 6.11.2-2` and
`layer-shell-qt 6.8.1-1`, both installed (repo state: webengine 6.11.2 against qtbase 6.12.0 is what
`extra` ships today; see the host notes for compatibility testing).

---

## 2. How omarchy-shell hosts plugins (runtime model)

- One long-running Quickshell process: Hyprland autostart runs `omarchy-launch-shell`, which runs
  `QS_DISABLE_FILE_WATCHER=1 QS_NO_RELOAD_POPUP=1 systemd-cat -t omarchy-shell -- quickshell -n -p "$OMARCHY_PATH/shell"`
  (`/usr/share/omarchy/bin/omarchy-launch-shell`). Quickshell's own QML file watcher is **off**; Omarchy
  reloads plugins itself.
- Entry: `/usr/share/omarchy/shell/shell.qml` (`ShellRoot`). Shared instances: `PluginRegistry`,
  `BarWidgetRegistry`, `AppLibrary` (shell.qml L20-22).
- QML module root is the shell dir, so plugins (first- and third-party) can `import qs.Ui` and
  `import qs.Commons` (Omastorm `ui/RadarBar.qml` L3-4 and `ultra.agents/Panel.qml` do).
- Discovery (`PluginRegistry.rescan()`, L689-726): a bash script prints every manifest. First-party:
  `find $OMARCHY_PATH/shell/plugins -mindepth 2 -maxdepth 3 -name manifest.json -o -name '*.manifest.json'`.
  Third-party: `for sub in ~/.config/omarchy/plugins/*/` with a `manifest.json` directly inside (top level
  only; glob also matches a symlink to a directory). Parsed by `parseScanOutput` (L576-661).
- Third-party ids never shadow first-party ones; any third-party id starting with `omarchy.` is rejected
  ("rejected: id is reserved for first-party Omarchy plugins", PluginRegistry.qml L629-637).
- Enabled state (`isEnabled`, L148-162; README "Storage rules"): a third-party plugin is enabled **iff its
  id appears in `~/.config/omarchy/shell.json`** — for a bar widget, as an entry in
  `bar.layout.{left,center,right}`; for other kinds, in `plugins[]`. First-party non-bar plugins are
  enabled unless in `disabledPlugins[]`.
- `shell.json` (`~/.config/omarchy/shell.json`) becomes canonical once it exists; defaults are **not**
  deep-merged (`applyShellConfig`, shell.qml L75-96). `version: 1` is required or the shell falls back to defaults.
- Bar-widget registration (`syncPluginWidgets`, shell.qml L1384-1453): for every enabled plugin with
  `bar-widget` kind, `Qt.createComponent(entryPointUrl, Component.Asynchronous)` is registered in
  `BarWidgetRegistry` under the manifest id with metadata `{displayName, description, category
  (default "Plugin"), allowMultiple, defaults, settingsForm, schema, pluginId, sourceDir, source:"plugin",
  firstParty}`. Errors log `Plugin widget <id> failed: <errorString>` (shell.qml L1517).
- The built-in bar (`plugins/bar/Bar.qml`) builds **one bar surface per screen** (`Variants { model:
  Quickshell.screens }`, L1210-1220) and a `ModuleSlot` per layout entry (L1787+). So a widget that
  appears once in the layout exists **once per monitor**.
- Hot reload (§7.3): any `close_write,create,delete,move` under `~/.config/omarchy/plugins` → 150 ms debounce
  → `reloadPlugins()` (shell.qml L1455-1476): unload all panels, non-`keepLoaded` services, all plugin
  widgets; `Qt.clearComponentCache()`; rescan; re-register.

## 3. Plugin manifest (`manifest.json`)

Authoritative checks: `PluginRegistry.validateManifest()` (`/usr/share/omarchy/shell/services/PluginRegistry.qml`
L43-92) at scan time, and `omarchy plugin validate <dir>` (`/usr/share/omarchy/bin/omarchy-plugin-validate`),
which `omarchy plugin add` runs before installing and which is stricter. A manifest that fails the shell's
check is dropped with a `PluginRegistry: …` warning in the shell log; the plugin simply does not exist.

### 3.1 Fields

| Field | Required | Rule / meaning |
|---|---|---|
| `schemaVersion` | yes | must be the JSON number `1` (string `"1"` is rejected) |
| `id` | yes | shell: non-empty, no `/`, no `..`, not starting with `/`; CLI: `^[A-Za-z0-9][A-Za-z0-9._-]*$`, must not start with `omarchy.` (reserved; the shell also rejects it). Use it as the directory name. |
| `name` | yes | human name (`omarchy plugin list`, `listPlugins`) |
| `version` | yes | free string (Omastorm watches it to detect an update waiting on a shell restart) |
| `kinds` | yes | non-empty array of `bar-widget`, `panel`, `overlay`, `menu`, `service`, `bar` |
| `entryPoints` | yes | object; key per kind: `barWidget`, `panel`, `overlay`, `menu`, `service`, `bar`. Values: relative paths inside the plugin dir — no leading `/`, no `..` (whole manifest rejected otherwise, PluginRegistry.qml L80-90); CLI also requires the file to exist, rejects newlines, and requires an entry point for every declared kind |
| `barWidget` | for bar widgets | see 3.2 |
| `keepLoaded` | no | `true`: panel/overlay/menu Loader stays active between summons; a `service` survives plugin hot-reload (and is then **not** replaced by new code until a shell restart). Not useful for a bar widget. |
| `description`, `author`, `license`, `homepage` | no | informational |
| `omarchy.capabilities` | no | honoured only for first-party manifests (e.g. `["authentication"]` on `omarchy.lock`) |
| `omarchy.clonedFrom`, `omarchy.clonePaths` | no | written/used by `omarchy plugin clone` (e.g. `ultra.agents` has `"clonedFrom": "omarchy.agents"`) |
| `activation` | no | appears as `"on-demand"` in `plugins/agents/manifest.json` and `ultra.agents`, but **no code reads it** (grep over shell + bin). Ignore. |

Unknown keys are ignored. The CLI also refuses **any symlink inside** the plugin folder (`.git` excepted).

### 3.2 `barWidget` block

| Key | Meaning |
|---|---|
| `displayName` | label (falls back to `name`) |
| `description` | falls back to manifest `description` |
| `category` | free string, default `"Plugin"` (first-party uses `Time`, `Network`, `System`, `AI`, `Weather`, `Files`, `Status`, `Layout`, `Compositor`, `Media`, `Info`, `Audio`) |
| `allowMultiple` | `true` lets several layout entries with this id exist, each with its own inline settings |
| `defaultSection` | `left` / `center` / `right`; where `omarchy plugin enable` inserts it (default `center`). Any other value **rejects the whole manifest** (PluginRegistry.qml L72-79). Insert position inside the section: after the anchor `omarchy.workspaces` (left), `omarchy.weather` (center), `omarchy.tray` (right), else at the end (`barTarget`, PluginRegistry.qml L250-277). |
| `defaults` | object. **Metadata only**: copied into the registry entry (shell.qml L1409) but never merged into the `settings` the widget receives. The widget must apply its own fallbacks (`setting(name, fallback)`). |
| `schema` | array of setting descriptors. **Metadata only** in this build (no settings UI consumes it). Shapes seen in first-party manifests: `{key,type:"integer",label,min,max,step,defaultValue}`, `{key,type:"enum",label,options:[…],defaultValue,description}`, `{key,type:"string",…}`, `{key,type:"path",…}`, `{key,type:"boolean",…}`, `{key,type:"multiselect",options:[{value,label,description}],noSelectionText,placeholderText,emptyText}` |
| `settingsForm` | name of a first-party built-in form (`"weatherSettings"`, `"spacerSettings"`); not for third-party use |
| `aliases` | array of strings (agents manifests); not read by the shell |

### 3.3 Kinds — what each one gets

| Kind | Instantiated by | Lifetime | Props injected (only if the root declares them) | Enabled when (third-party) |
|---|---|---|---|---|
| `bar-widget` | `Bar.qml` `ModuleSlot` → `injectProps()` (Bar.qml L2016-2023) | per layout entry **per monitor**; destroyed on every plugin reload | `bar` (facade, §4.2), `moduleName`, `settings` | id in `bar.layout.*` |
| `panel` / `overlay` / `menu` | one `Loader` per plugin in shell.qml (L1330-1370), `asynchronous: true` | while summoned (or always if `keepLoaded`) | `omarchyPath`, `shell` (scoped facade), `manifest` (copy incl. `__sourceDir`), `barWidgetRegistry`, `pluginRegistry`, `service` | id in `plugins[]` **or** anywhere in the bar layout |
| `service` | `ensureService()` (shell.qml L904-954), parent `null` for third-party | from enable until disable/reload (`keepLoaded` survives reload) | `omarchyPath`, `shell`, `manifest`, `barWidgetRegistry`, `pluginRegistry` | id in `plugins[]` or bar layout |
| `bar` | replaces the whole bar | — | `omarchyPath`, `shell`, `manifest`, `barWidgetRegistry`, `pluginRegistry`, `barConfig` | `bar.id` |

Routing consequence: if a plugin has `bar-widget` **and** `panel`/`overlay`/`menu`, `shell summon/hide/toggle <id>`
goes to the panel Loader, not the bar widget (`isBarWidgetPanelPlugin`, shell.qml L1141-1153). OmaExiled
needs only `["bar-widget"]`.

### 3.4 Examples

First-party bar widget with settings metadata (`plugins/panels/tailscale/manifest.json`):

```json
{
  "schemaVersion": 1,
  "id": "omarchy.tailscale",
  "name": "Tailscale",
  "version": "1.0.0",
  "author": "Omarchy",
  "license": "MIT",
  "description": "Tailscale status, connection switching, machine browsing, and quick copy actions in the Omarchy bar.",
  "kinds": ["bar-widget"],
  "entryPoints": { "barWidget": "Panel.qml" },
  "barWidget": {
    "displayName": "Tailscale",
    "description": "Toggle Tailscale, switch connections, browse machines, and copy machine IPs or names.",
    "category": "Network",
    "allowMultiple": false,
    "defaultSection": "right",
    "defaults": { "refreshIntervalSec": 30 },
    "schema": [
      { "key": "refreshIntervalSec", "type": "integer", "label": "Refresh interval (seconds)",
        "min": 5, "max": 3600, "step": 5, "defaultValue": 30 }
    ]
  }
}
```

Third-party widget + panel that bootstraps an external engine (`~/.config/omarchy/plugins/com.omastorm.radar/manifest.json`):

```json
{
  "schemaVersion": 1,
  "id": "com.omastorm.radar",
  "name": "Omastorm",
  "version": "0.1.14",
  "kinds": ["bar-widget", "panel"],
  "entryPoints": { "barWidget": "ui/RadarBar.qml", "panel": "ui/Panel.qml" },
  "barWidget": { "displayName": "Omastorm", "category": "Weather", "allowMultiple": false, "defaultSection": "right" }
}
```

The OmaExiled manifest is in §9.1 (validated with `omarchy plugin validate` → exit 0).

## 4. Bar-widget QML contract

### 4.1 What the host does with the entry file

1. `Qt.createComponent(file://…/<entry>.qml, Asynchronous)` once per plugin reload (shell.qml `loadPluginWidget`, L1504-1528).
2. For every layout entry with that id, on every monitor, `ModuleSlot` loads it with a `Loader`
   (`anchors.fill: parent`) and calls `injectProps()` on load, again via `Qt.callLater`, on
   `activeItem` change and on settings change (Bar.qml L1852-1886, L2013-2023):

```qml
// plugins/bar/Bar.qml L2016-2023
function injectProps() {
  var target = activeItem
  if (!target) return
  if ("bar" in target) target.bar = firstParty
    ? root : root.pluginBarApiFor(pluginApiId, moduleName, registered)
  if ("moduleName" in target) target.moduleName = moduleName
  if ("settings" in target) target.settings = moduleSettings
}
```

   So the root object must **declare** `property QtObject bar` (or `var`), `property string moduleName`,
   `property var settings`. `qs.Ui` `BarWidget` (Ui/BarWidget.qml) and `qs.Ui` `Panel` (Ui/Panel.qml) both do.
   Nothing else is injected into a bar widget: no `shell`, no `manifest`, no `__sourceDir` (use
   `Qt.resolvedUrl("…")` for files next to the QML).
3. `settings` = the layout entry minus `id` (`BarModel.entrySettings`, BarModel.js L10-18) — e.g. entry
   `{ "id": "omaexiled", "hideWhenStopped": true }` → `settings = { hideWhenStopped: true }`. Updated live when
   `shell.json` changes (`omarchy bar set`, hand edit, `updateEntryInline`).
4. Sizing: slot `implicitWidth = activeItem.visible ? (vertical ? barSize : activeItem.implicitWidth) : 0`,
   `implicitHeight = activeItem.visible ? activeItem.implicitHeight : 0` (Bar.qml ModuleSlot). Set
   `implicitWidth/implicitHeight` on the root from the button; return 0 / `visible:false` to vanish.
   Bar thickness: `Style.bar.sizeHorizontal` 26, `sizeVertical` 28; icon slot `Style.bar.iconSlot` 27,
   icon canvas 16, icon font 13, status slot 21 (Commons/Style.qml L342-349). The skeleton measures 27×26.
5. Left-button drags on the slot reorder widgets (4 px threshold); clicks are passed through to the widget
   (Bar.qml ModuleSlot `modulePointer`).
6. Optional hints read off the root: `openPanelIndicatorWidth` / `openPanelIndicatorHeight` (length of the
   accent mark the bar draws under a slot whose item is the active popout).

### 4.2 The `bar` object a **third-party** widget receives (`qs.Ui` `PluginBarApi`, Ui/PluginBarApi.qml)

First-party widgets get the real `Bar`; third-party widgets get this capability-scoped facade, bound live to
the bar (Bar.qml `bindPluginBarApi`, L129-144; `pluginBarApiFor`, L245-289):

| Member | Notes |
|---|---|
| `foreground`, `barForeground`, `background`, `urgent` (color) | live theme colours; `barForeground` differs from `foreground` on a transparent bar |
| `fontFamily` (string) | bar font (here `JetBrainsMono Nerd Font`) |
| `position` (`top`/`bottom`/`left`/`right`), `vertical` (bool), `barSize` (int), `transparent` (bool) | geometry |
| `foregroundAnimationEnabled`, `centerSectionRevealHeld`, `centerHoverRevealSuppressed`, `setCenterHoverRevealSuppressed(v)` | center-section reveal plumbing (ignore) |
| `activePopout`, `clickTargets`, `layoutConfig` (detached copy), `foreignPopoutMarker` | popout coordination state |
| `showTooltip(target, text)`, `hideTooltip(target)` | shared bar tooltip; `WidgetButton` calls them from `tooltipText` |
| `registerClickTarget(t)`, `unregisterClickTarget(t)` | `WidgetButton` registers itself so clicks on the bar strip while a popup is open are forwarded |
| `requestPopout(owner)`, `releasePopout(owner)` | one popup per bar; requesting closes the previous owner (`closeForPopoutSwitch()` preferred, else `close()`; Bar.qml L556-567) |
| `switchPanelFrom(owner, direction)` | Tab/Shift-Tab cycling between panel widgets of the same section |
| `targetBelongsToWindow(target, window)` | used by `KeyboardPanel` |
| `moduleWidgets(id)` | live copies of **this** widget (one per monitor); other ids return `[]` |
| `run(command)` | `Util.execDetached(command)` = `Quickshell.execDetached(["bash","-lc",command])` (Bar.qml L855-859) |
| `shell` | scoped `PluginShellApi` (below) |

Not on the facade (README lists them for the first-party Bar only): `shellQuote` → use `Util.shellQuote`;
accent → use `Commons.Color.accent`.

`bar.shell` (`services/PluginShellApi.qml`, created by `createScopedPluginShell`, shell.qml L572-680):
`pluginId`; `bar` (scalar `PluginBarStateApi`: `barHidden`, `barSize`, `fontFamily`, `position`);
`barConfig` (detached); `serviceFor(id)` / `firstPartyServiceFor(id)` (own id only → own `service` instance);
`summon(id, payloadJson)` / `hide(id)` / `toggle(id, payloadJson)` / `isPluginOpen(id)` (own id only);
`updateEntryInline(id, settings)` (own id → rewrites this widget's layout entry in `shell.json`;
used by power `togglePercentage`, clock `cycleFormat`, tailscale `persistRecentMullvad`);
`mutateShellConfig()` returns `false` (bar plugins only). `appLibrary` is `null` unless the plugin is a `menu`.

Security note from the README: facades scope capabilities but are **not** a sandbox — plugin QML shares the
host scene graph and runs unsandboxed in the shell process.

### 4.3 Theme, fonts, spacing (import `qs.Commons`)

- Colours: `bar.foreground` / `bar.urgent` (live) or `Commons.Color.{foreground, background, accent, urgent,
  muted}`; surface roles `Commons.Color.popups.{background,text,border}`, `.tooltip.*`, `.menu.*`, `.bar.*`
  (Commons/Color.qml). Dim text convention: `Qt.darker(foreground, 1.4)` (PanelSectionHeader) or `1.55`
  (tailscale). Fills: `Style.hoverFillFor(fg, accent)`, `Style.selectedFillFor(fg, accent)`.
  Theme switches arrive via shell IPC `applyTheme` → `Color.loadColors/loadShell` → bindings update.
- Fonts: `bar.fontFamily` / `Style.font.family`; sizes `Style.font.caption` 10, `bodySmall` 11, `body` 12,
  `subtitle` 13, `title` 14, `heading` 16, `display` 24, `displayLarge` 28, `iconSmall`, `icon`, `iconLarge`
  (Style.qml L322-340; all scale with `[font] base-size` in `~/.config/omarchy/shell.toml`).
- Spacing: `Style.space(px)` (scaled), `Style.spacing.{xxs 2, xs 3, sm 4, md 6, lg 8, xl 10, xxl 12, xxxl 14,
  huge 18, controlGap 8, controlPaddingX 10, controlPaddingY 6, controlHeight 28, popupRowHeight 28,
  rowGap 8, rowPaddingX 12, labelGap 4, panelGap 14, panelPadding 18, popupPadding 14}`;
  `Style.cornerRadius` (Hyprland rounding), `Style.gapsOut`.
- Text from outside (league names, errors) should use `textFormat: Text.PlainText` (first-party convention;
  avoids rich-text promotion).

### 4.4 UI kit (`import qs.Ui`, Ui/qmldir)

| Component | Use |
|---|---|
| `BarWidget` | minimal widget root: `bar`, `moduleName`, `settings`, `vertical`, `barSize`, `setting(name, fallback)`, `broadcast(method)` |
| `Panel` | widget root **with a popup lifecycle**: `bar`, `moduleName`, `settings`, `ipcTarget`, `manageIpc`, `opened`, `open()`, `close()`, `toggle()`, `closeForPopoutSwitch()`, `popoutSwitchClosing`, `switchPanel(dir)`, `setting()`, built-in `IpcHandler` (open/close/show/hide/toggle) when `manageIpc && ipcTarget` (Ui/Panel.qml) |
| `WidgetButton` | text button in the bar: `bar`, `text`, `fontSize`, `active`, `activeColor`, `useActiveColor`, `dimmed` (opacity .45), `concealed`, `interactive`, `tooltipText`, `fixedWidth/Height`, `horizontalMargin`, `labelWidth`; signals `pressed(int button)` (Left/Right/Middle), `wheelMoved(int delta)` |
| `BarIconButton` | icon-sized `WidgetButton`: `text` glyph or `iconComponent`, `slotSize` (27), `opticalSize` (16); optical centring; `glyphPaintedWidth` |
| `BarIndicator` | status-indicator variant (used by `omarchy.indicators`) |
| `KeyboardPanel` | **the popup** (see 4.5) |
| `PopupCard` | older xdg-popup variant: `PopupWindow` + `HyprlandFocusGrab`, `triggerMode` = `"click"` or `"hover"`, no keyboard-focus prime. No current panel uses it. |
| `PanelKeyCatcher` | key dispatcher for panel content: signals `moveRequested(dx,dy)` (arrows, h/j/k/l), `activateRequested()` (Enter/Space), `returnRequested()`, `closeRequested()` (Esc), `deleteRequested()` (x), `tabRequested(dir)`, `textKey(text)`; `blocked` to let an inner editor have keys |
| `PanelHero` | header row: `iconComponent`, `title`, `meta` (upper-cased, dim), `detail` (pill), `trailingControl`, `iconOpacity` |
| `PanelSectionHeader`, `PanelSeparator` | section caption, 1 px divider (`foreground`, `strength`) |
| `CursorSurface` | keyboard/mouse row chrome: `hasCursor`, `current`, `bordered`, `foreground`, `fill`, `currentFill` |
| `Button` | general button: `text`, `iconText`, `selected`, `active`, `hasCursor`, `bordered`, `leftAlign`, `tooltipText`; signals `clicked()`, `rightClicked()`, `hovered(bool)` |
| `PanelActionButton` | 22 px inline icon button (`iconText`, `hoverColor` = urgent for destructive) |
| `Toggle`, `ToggleSwitch`, `Dropdown`, `SearchableDropdown`, `MultiSelect`, `NumberField`, `TextField`, `PanelSlider`, `ButtonGroup`, `ConfirmDialog`, `PanelToolTip`, `OpticalGlyph`, `BorderSurface` | form/feedback pieces; live reference: `omarchy-shell shell summon omarchy.dev-gallery '{}'` |

### 4.5 Opening a popup anchored to the widget: `KeyboardPanel`

`Ui/KeyboardPanel.qml` is a full-screen `PanelWindow` on `WlrLayer.Overlay`, namespace
`omarchy-keyboard-panel` (L86-87), with the card drawn at `cardOrigin` next to `anchorItem`:

- Required: `anchorItem` (the bar button), `bar`. Usual: `owner: root` (so `close()` goes through the
  widget and popout switching works), `open: root.opened`, `focusTarget: keyCatcher`,
  `contentWidth: panel.fittedContentWidth(Style.space(300))`,
  `contentHeight: panel.fittedContentHeight(column.implicitHeight[, cap])` (both clamp to the screen and add
  padding + border insets). Optional: `padding`, `margin`, `gap`, `borderSpec`, `centerOnBar`.
- Placement: top bar → centred under the anchor, `barH + gap` from the top; bottom/left/right mirrored;
  clamped to `margin` from screen edges.
- Keyboard: while `open`, `WlrKeyboardFocus.Exclusive` for 75 ms then `OnDemand` (L99-100, L256-262), so the
  popup gets keys even when summoned by a hotkey; `focusTarget.forceActiveFocus()` is called via
  `Qt.callLater`. Closing releases focus immediately (fade-out 140 ms continues without input).
- Dismissal: click anywhere outside the card closes it; clicks on the bar strip are forwarded to the bar
  button under the pointer (switching popups in one click); every other monitor gets a transparent
  `omarchy-keyboard-panel-dismiss` overlay that closes on press (L336-375).
- Coordination: on open → `bar.requestPopout(owner)` (closes any other popup on that bar); on close →
  `releasePopout`. The bar draws the accent underline under the owning slot.
- Content: children go into the card (`default property alias contentItem`).

Pattern used by `omarchy.power` (plugins/panels/power/Panel.qml L10-16, L293-330), `omarchy.tailscale`,
`ultra.agents` and Omastorm's `RadarBar.qml`:

```qml
Panel {                       // or BarWidget + own opened/open()/close()/closeForPopoutSwitch()
  id: root
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  BarIconButton { id: button; anchors.fill: parent; bar: root.bar; text: "…"
                  onPressed: function(b) { root.toggle() } }
  KeyboardPanel {
    id: panel; anchorItem: button; owner: root; bar: root.bar; open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)
    PanelKeyCatcher { id: keyCatcher; anchors.fill: parent; onCloseRequested: root.close()
      Column { id: column; anchors.left: parent.left; anchors.right: parent.right; … } }
  }
}
```

Omastorm uses a plain `BarWidget` root and implements the owner contract by hand
(`ui/RadarBar.qml` L5-21: `opened`, `popoutSwitchClosing`, `open()`, `close()`, `closeForPopoutSwitch()`).

### 4.6 Summoning the widget from outside (hotkey, backend, scripts)

`omarchy-shell shell toggle omaexiled` (also `summon` / `hide`) works for a plugin whose kinds are
bar-widget-only **if the widget root exposes `open()`, `close()` and `opened`** (`Panel` does):
shell.qml `summon` (L1155-1193) → `bar.summonBarWidget(id)` → `findPanelWidget` (Bar.qml L740-756) picks
the copy that is already open, else the copy on Hyprland's focused monitor (`BarModel.pickPanelSlot`). The
payload JSON is dropped on this path. `omarchy-shell shell togglePanelAt right 3` addresses "the 3rd visible
panel widget of the right section". `omarchy-shell shell call <id> …` does **not** reach bar widgets (only
panel/overlay/menu Loaders, `callIfLoaded`, shell.qml L1282-1295).

### 4.7 Visibility vs. a fullscreen game

The bar surfaces are `WlrLayer.Top`, namespace `omarchy-bar` (Bar.qml L1282-1283), so a fullscreen PoE2 covers
the bar on that monitor and the widget cannot be clicked there. The popup itself is on `Overlay`, so
`omarchy-shell shell toggle omaexiled` from a Hyprland bind does show the menu above the game (anchored to the
hidden bar's geometry) — at the cost of taking keyboard focus from the game while it is open. EE2 had no
hotkey for the tray menu; adding one is optional.

## 5. Running commands and talking to a long-running external process

All types below are from the installed Quickshell (`/usr/lib/qt6/qml/Quickshell/Io/quickshell-io.qmltypes`,
`/usr/lib/qt6/qml/Quickshell/quickshell-core.qmltypes`).

### 5.1 Fire-and-forget

| API | Behaviour | When |
|---|---|---|
| `Quickshell.execDetached(["prog","arg",…])` | starts a detached process; it **outlives** the widget, plugin reloads and shell restarts | xdg-open, starting the backend |
| `Quickshell.execDetached({ command, environment, clearEnvironment, workingDirectory })` | same, with process context (overload in quickshell-core.qmltypes L1060-1069) | |
| `Util.execArgv(argv)` (`qs.Commons`) | `bash -lc 'exec "$@"' bash argv…` — login-shell PATH, args never re-tokenised (Util.qml L62-64) | argv built from data |
| `Util.execDetached(cmd)` / `bar.run(cmd)` | `bash -lc cmd` (string!) — quote with `Util.shellQuote` | user-configured command strings |

Omastorm prefixes its argv with `env -C $HOME` because Quickshell's own cwd is `qrc:/qs-blackhole`
(`ui/PluginSession.qml` L536-551: "bash will not start in Quickshell's cwd (qrc:/qs-blackhole), so env -C
moves it home"). First-party code calls `bash -lc` without it and works, but `env -C $HOME` is cheap and
gives children a real cwd; the skeleton uses it.

### 5.2 `Process` (child bound to the QML object)

Properties: `command` (list), `running` (set `true` to start), `workingDirectory`, `environment` (object),
`clearEnvironment`, `stdout`, `stderr` (a parser), `stdinEnabled`, `processId`. Methods: `write(string)`
(stdin), `signal(int)`, `startDetached()`, `exec(list|context)`. Signals: `started()`,
`exited(exitCode, exitStatus)`. Parsers: `StdioCollector { waitForEnd: true; onStreamFinished: … text … }`
(whole output) or `SplitParser { splitMarker: "\n"; onRead: function(line) {…} }` (streaming).

```qml
Process {                                   // plugins/panels/power/Panel.qml L209-213
  id: batteryProc
  command: ["omarchy-battery-status", "--shell"]
  stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateKeyValue(text, "battery") }
}
// start: if (!batteryProc.running) batteryProc.running = true
```

A `Process` dies with its QML object. Bar widgets are destroyed on **every** plugin reload, which happens on
any file write anywhere under `~/.config/omarchy/plugins/` (§7.3). Therefore: short-lived queries only; never
host the backend in a `Process`.

### 5.3 `Socket` (Unix stream socket client)

`Socket { path; connected: true; parser: SplitParser { onRead: … } }`, `write(string)`, `flush()`,
signal `error(QLocalSocket::LocalSocketError)`, `connectedChanged`. Behaviour verified here and documented in
Omastorm `ui/Engine.qml` L103-131:
- A `Socket` whose first connect failed stays allocated; toggling `connected` does not retry. Create a new
  `Socket` object (Component + `createObject`) and destroy the old one.
- Every failed connect logs `WARN quickshell.io.socket: Socket error for Socket(0x…) QLocalSocket::ServerNotFoundError`
  to the shell journal — back off while the server is down.
- `sun_path` limit: a socket path longer than ~107 bytes silently fails the same way (observed with a long
  scratch path). `/run/user/1000/omaexiled/shell.sock` is 35 bytes.

### 5.4 `FileView` (watch / read / write files)

`FileView { path; watchChanges: true; printErrors: false; onFileChanged: reload(); onLoaded: … text() …;
onLoadFailed: function(error) {…} }`, plus `preload`, `blockLoading`, `blockAllReads`, `blockWrites`,
`atomicWrites`, `adapter: JsonAdapter {…}`, `setText()`, `setData()`, `writeAdapter()`, `waitForJob()`,
signals `saved`, `saveFailed`. `watchChanges` reports creation of a file that did not exist when watching
started (shell.qml `userShellFile` relies on it; verified with the skeleton's `shell.ready` kick, §9).
Used by: shell.json (shell.qml L123-146), Omastorm manifest/bootstrap-log watchers, ultra.agents usage records.

### 5.5 `XMLHttpRequest` (HTTP from QML)

Built into the QML engine (no extra package). No first-party plugin uses it, but GET and POST with a JSON
body against a `Bun.serve` on `127.0.0.1` both returned 200 in a standalone `qs -p` probe on this machine
(Quickshell 0.3.2). Requires knowing the port (EE2's server listens on port 0 = random,
`main/src/server.ts` L131-147, and passes it to the tray as `tray.serverPort`, `main/src/main.ts` L133).
`WebSocket` (QML type) is **not** available: `qt6-websockets` is not installed.

### 5.6 `SocketServer`, `IpcHandler`

`SocketServer { path; active; handler: Component { Socket {…} } }` lets the shell side listen (not needed).
`IpcHandler` — §6.

### 5.7 How Omastorm starts and talks to its engine (case study)

Files: `~/.config/omarchy/plugins/com.omastorm.radar/{run.sh, ui/PluginSession.qml, ui/Engine.qml, ui/RadarBar.qml, scripts/link-plugin.sh, docs/protocol.md, engine/README.md}`.

1. **Shared session singleton.** `ui/qmldir` declares `singleton PluginSession 1.0 PluginSession.qml`. The bar
   widget (`RadarBar.qml` L8: `property var session: PluginSession`) and the panel window both use it, so all
   monitors' bar copies share one engine connection ("One non-map connection keeps the bar current, including
   on multiple outputs", PluginSession.qml L9-11).
2. **Bootstrap** (PluginSession.qml L536-551): on completion and then every 20 s while there is no engine
   state, `Quickshell.execDetached(["env","-C",$HOME,"OMASTORM_BOOTSTRAP_LOG=$XDG_RUNTIME_DIR/omastorm/bootstrap.log","bash",root+"/run.sh","--ensure"])`.
   `run.sh --ensure` redirects stderr to that log and `exec`s `omastorm-engine ensure` (debug build if present,
   else a pinned release fetched and sha256-verified into `$XDG_DATA_HOME/omastorm/bin`). `ensure` starts a
   background daemon (or replaces one whose build/protocol differ) and waits up to 10 s for its hello
   (engine/README.md L21-28). The daemon outlives windows, plugin reloads and shell restarts; `stop` ends it.
   Detached on purpose: "a plugin reload mid-install cannot kill it: `omarchy plugin add` clones many files
   and the registry reloads the plugin on each one."
3. **Transport** (docs/protocol.md): `$XDG_RUNTIME_DIR/omastorm/engine.sock`, newline-delimited JSON,
   multiple clients, every client gets every broadcast; engine messages carry `"v": 2`; `hello` once on
   connect then a full `state`; `state` is re-sent whole on every change and clients replace, not merge;
   commands are `{ "type": … }` objects; per-client `error` replies.
4. **Client** (`ui/Engine.qml`): `Socket` built from a `Component` (L103-118), `SplitParser` → `receive()`
   (JSON parse, version check → `incompatible`, dispatch by `type`), `send(cmd)` = `socket.write(JSON.stringify(cmd)+"\n")`;
   on disconnect clear state and show "Reconnecting…"; a 1 s repeating `Timer` replaces the socket object while
   disconnected (L119-131).
5. **Status in the UI**: last line of `bootstrap.log` shown while there is no engine (FileView, PluginSession.qml L578-583);
   red dot on the bar icon when offline, accent dot when an update is pending (RadarBar.qml L38-40).
6. **Update detection**: FileView on its own `manifest.json`; a `version` different from the one loaded means
   "UPDATED TO x · RESTART THE SHELL" (PluginSession.qml L552-576), because a rescan keeps the singleton and its compiled QML.
7. **Expand to a window**: `Quickshell.execDetached(["omarchy","shell","shell", windowOpen ? "summon" : "toggle", "com.omastorm.radar", "{}"])`
   (RadarBar.qml L18-21) — the `panel` kind of the same plugin is a `FloatingWindow`.
8. **Dev link** (`scripts/link-plugin.sh`): symlinks the checkout to `~/.config/omarchy/plugins/com.omastorm.radar`
   (moving an installed clone aside to `.com.omastorm.radar.unlinked`), then `omarchy restart shell` because
   "inotify and rescanPlugins do not follow the symlink", polls `omarchy-shell shell listPlugins | jq` until the
   id is known, then `omarchy-shell shell enablePlugin <id> '{}'` (expects `ok`).

What OmaExiled takes from this: detached long-lived daemon with a fixed runtime socket, full-state push,
versioned NDJSON, socket-object replacement on reconnect, "ready" signalling, never spawning the daemon from a
`Process`. What it does differently: no singleton (one socket per bar copy keeps hot-reload working, §9.3), and
the backend is normally started by its systemd user unit (DESIGN.md "Processes"), not by the widget.

---

## 6. IPC targets from a plugin

- **Yes**, any plugin QML can declare `IpcHandler { target: "…"; function f(arg: string): string {…} }` and it
  becomes callable on the running shell. Evidence: `qs ipc -n -p "$OMARCHY_PATH/shell" show` lists `theme`
  (Omastorm `ui/Theme.qml` L64-67, third-party) and `omarchy.agents` (the third-party clone `ultra.agents`,
  `Panel.qml` L328-338, `ipcTarget: "omarchy.agents"`).
- Functions need type annotations; arguments `string` (also `int`, `bool`, `real` are accepted — Omastorm uses
  `delta: int`, `open: bool`), return `void`/`string`/…. The shell README recommends string arguments
  ("QML's string-only IPC arguments") — use strings.
- Call it: `omarchy-shell omaexiled status` (wrapper: `/usr/share/omarchy/bin/omarchy-shell`), or
  `qs ipc -n -p "$OMARCHY_PATH/shell" call -- omaexiled status`. The wrapper times out after
  `OMARCHY_SHELL_IPC_TIMEOUT` (default 2 s) → "omarchy-shell is not responding"; exits 1 with the message for
  `Target not found.`, `Function not found.`, `Too few/many arguments provided`, `Not ready to accept queries yet`;
  `-q` = quiet best-effort; `shell summon|toggle <id>` without a payload gets `{}` appended.
- One target, one handler: a bar widget exists once per monitor, so N copies register the same target and only
  one receives calls (first-party comment in Ui/BarWidget.qml L23-28; that is why `BarWidget.broadcast()`
  exists and why `shell summon/toggle` route through the bar instead). For OmaExiled only put idempotent,
  read-only functions (e.g. `status()`) in the widget's handler; open/close go through `shell toggle`.
- `Panel` with `manageIpc: true` and `ipcTarget: "x"` auto-registers `open/close/show/hide/toggle` (Ui/Panel.qml
  L49-57). Power/tailscale set `manageIpc: false` to own the target with extra methods.
- Names: avoid existing targets (`shell`, `image-selector`, `lock`, `idle`, `notifications`, `nightlight`,
  `media`, `osd`, `background`, `omarchy.<widget>`, `theme`, `keys`, `picker`, `location`); use `omaexiled`.
- A handler in a QML **singleton** stays registered until the shell restarts (singletons survive reloads);
  in a widget it unregisters when the widget is destroyed.
- The `shell` target (shell.qml L1588-1747): `ping`, `applyTheme(colorsB64, shellB64)`, `rescanPlugins`,
  `reloadConfig`, `toggleBarTransparency`, `setPluginEnabled(id, "true"|other)`, `enablePlugin(id, placementJson)`,
  `putBarWidget(id, placementJson)`, `moveBarWidget(id, placementJson)`,
  `setBarWidget(id, key, valueJson, selectorJson)`, `listPlugins`, `listShellConfig`, `debugBarGeometry`,
  `summon(id, payloadJson)` → `ok`/`unknown`, `hide(id)`, `toggle(id, payloadJson)`,
  `togglePanelAt(section, index)`, `call(id, method, arg)`.

---

## 7. Install, enable, place, configure, reload, debug

### 7.1 Install

By hand / from the OmaExiled repo (recommended):

```bash
# from the OmaExiled checkout; plain copy — no symlinks inside, no symlinked dir (see 7.4)
omarchy plugin validate omarchy-plugin            # exit 0 = what the shell will accept
mkdir -p ~/.config/omarchy/plugins/omaexiled
rsync -a --delete omarchy-plugin/ ~/.config/omarchy/plugins/omaexiled/
omarchy-shell shell rescanPlugins                 # optional: the inotify watcher already reloads
omarchy plugin enable omaexiled --section right --after omarchy.tray   # or just: omarchy plugin enable omaexiled
```

From git (needs `manifest.json` at the **repository root**): `omarchy plugin add <git-url> [--enable] [--yes]`
clones into `~/.config/omarchy/plugins/.add.tmp.<pid>`, validates, moves to `~/.config/omarchy/plugins/<id>`,
runs `rescanPlugins`, optionally enables (`/usr/share/omarchy/bin/omarchy-plugin-add` L114-172). Update:
`omarchy plugin update <id>` (fetch, show diff, fast-forward). Remove: `omarchy plugin remove <id>`.
Cloning the whole OmaExiled repo this way would put backend/host/renderer sources (and anything built inside
them) under the inotify-watched plugins dir — see Open questions.

### 7.2 Enable / place / settings

| Command | Effect on `~/.config/omarchy/shell.json` |
|---|---|
| `omarchy plugin enable omaexiled [SECTION] [--section S] [--index N] [--before ID]` (or `--after ID`; SECTION = left, center, right) | inserts `{ "id": "omaexiled" }` into `bar.layout.<section>` (default `barWidget.defaultSection`, else `center`), via IPC `enablePlugin`; prints `Enabled omaexiled` (`omarchy-plugin-enable`) |
| `omarchy bar put omaexiled [placement]` | like enable, but leaves an already-placed widget alone; unknown `--before/--after` target falls back to the default spot (IPC `putBarWidget`) — good for install scripts |
| `omarchy bar move omaexiled --section right --before omarchy.tailscale` | moves the entry (IPC `moveBarWidget`); also `--index`, `--from-section`, `--from-index` |
| `omarchy bar set omaexiled hideWhenStopped true --json` | sets an inline setting on the entry (IPC `setBarWidget`); without `--json` the value is a string |
| `omarchy plugin disable omaexiled` | removes the layout entry — **inline settings are lost** (IPC `setPluginEnabled id false`) |
| `omarchy plugin list` / `--json` | state: `enabled` for a widget means "on the bar" |

Resulting entry: `"right": [ { "id": "omarchy.tray" }, { "id": "omaexiled", "hideWhenStopped": true }, … ]`.
Users can also drag the icon on the bar to reorder (writes shell.json).

### 7.3 Hot reload

- `PluginRegistry.localPluginWatcher` runs `inotifywait -m -r -q -e close_write,create,delete,move --format %w%f ~/.config/omarchy/plugins`
  (L663-676; restarted 1 s after it exits). Paths under hidden top-level dirs and `.git` are ignored
  (`localPluginIdForPath`, L728-741). Any other event → `Local plugin changed, reloading: <dir>` in the log →
  150 ms debounce → full `reloadPlugins()` of **all** plugins: panels unloaded, non-`keepLoaded` services
  destroyed, widget components unregistered, `Qt.clearComponentCache()`, rescan, re-register (shell.qml
  L1455-1500).
- Consequences: (1) saving `OmaExiledWidget.qml` in the installed dir reloads it within ~0.2 s;
  (2) **nothing may write into the plugin dir at runtime** (logs, caches, built files) or every write reloads
  every widget of every plugin; (3) QML singletons and `keepLoaded` services are not recreated — their code
  changes need `omarchy restart shell`; (4) widgets lose all in-memory state on every reload, so the backend
  must be the source of truth and accept reconnect storms.
- `omarchy-shell shell rescanPlugins` forces the same reload.

### 7.4 Symlinked dev checkout

The directory scan follows a symlinked plugin dir, but `inotifywait -r` does not descend into it, so edits do not
hot-reload, and Omastorm reports that `rescanPlugins` kept the old QML for a symlinked plugin (its
`link-plugin.sh` restarts the shell instead). For development either rsync on save
(`rsync -a --delete omarchy-plugin/ ~/.config/omarchy/plugins/omaexiled/`, which triggers the watcher) or
symlink + `omarchy restart shell` per change. Do not run `omarchy restart shell` while the session is locked
(the script refuses).

### 7.5 Logs and debugging

| What | Command |
|---|---|
| Shell log (journal; `omarchy-launch-shell` pipes through `systemd-cat -t omarchy-shell`) | `journalctl --user -t omarchy-shell -f` |
| Same, via Quickshell (instance log in `$XDG_RUNTIME_DIR/quickshell/by-id/<id>/log.qslog`) | `qs log -f -p "$OMARCHY_PATH/shell"` (`-t N` tail) |
| QML `console.log("omaexiled:", …)` / `console.warn` | appear as `DEBUG qml: …` / `WARN qml: …` lines |
| Load errors | `Plugin widget omaexiled failed: <qml error with file:line>`; manifest rejects: `PluginRegistry: …`; reloads: `Local plugin changed, reloading: omaexiled` |
| Is it discovered / on the bar? | `omarchy plugin list \| grep omaexiled`; `omarchy-shell shell listPlugins \| jq '.[] \| select(.id=="omaexiled")'`; `omarchy-shell shell listShellConfig \| jq .bar.layout` |
| IPC targets | `qs ipc -n -p "$OMARCHY_PATH/shell" show` |
| Widget state | `omarchy-shell omaexiled status \| jq` (skeleton) |
| Open the menu | `omarchy-shell shell toggle omaexiled` |
| Backend stream | `socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/omaexiled/shell.sock` |
| Bar geometry / icon bounds | `omarchy-shell shell debugBarGeometry`; `OMARCHY_DEBUG_BAR_ICONS=1` (env of the shell process) draws optical bounds |
| UI kit gallery | `omarchy-shell shell summon omarchy.dev-gallery '{}'` |
| Restart the shell | `omarchy restart shell` (= `omarchy-restart-shell`; kills every instance, relaunches via `hyprctl dispatch 'hl.dsp.exec_cmd("omarchy-launch-shell")'`, waits up to 60 s for `ping`) |

Standalone harness (used to verify the skeleton without touching the live shell): a scratch dir with symlinks
`Ui -> /usr/share/omarchy/shell/Ui`, `Commons -> /usr/share/omarchy/shell/Commons`, a copy of the plugin dir,
and a `shell.qml` that instantiates the widget with a `PluginBarApi { pluginId: "omaexiled"; moduleName: "omaexiled"; barSize: 26 }`
as `bar` — run with `qs -p <dir>`. `qs.Ui`/`qs.Commons` resolve because the harness dir is the `qs` module root.

## 8. Backend contract for the widget (proposal) and EE2 tray parity

### 8.1 EE2 tray → OmaExiled widget

EE2 `main/src/AppTray.ts` (tray created in `main.ts` L66; `serverPort` set at L133 after `startServer`;
`overlayKey` refreshed on `CLIENT->MAIN::update-host-config`, L123):

| EE2 (AppTray.ts) | EE2 behaviour | OmaExiled widget |
|---|---|---|
| L26 tooltip | `Exiled Exchange 2 v${app.getVersion()}` | bar tooltip `OmaExiled · <league>` / `OmaExiled is not running`; version shown from `hello.version` if wanted |
| L38-46 "Settings/League" | message box: `Open Path of Exile 2 and press "${overlayKey}". Click on the button with cog icon there.` | `{"type":"open-settings"}` → backend asks the Qt host for the settings window (DESIGN.md: settings is a normal toplevel). Right click on the icon does the same. |
| L47-52 "Open in Browser" | `shell.openExternal("http://localhost:" + serverPort)` | `xdg-open state.url` (disabled while `url` is empty) |
| L53 separator | | `PanelSeparator` before "Open config folder" |
| L54-58 "Open config folder" | `shell.openPath(<userData>/apt-data)` | `xdg-open state.configDir` (fallback while stopped: setting `configDir` or `~/.config/omaexiled`) |
| L60-64 "Quit" | `app.quit()` | `{"type":"quit"}` |
| L29-33 | renderer event `CLIENT->MAIN::user-action {action:"quit"}` also quits | stays a backend concern (renderer → WS) |
| — | — | extra while stopped: "Start OmaExiled" (runs setting `startCommand`, default `systemctl --user start omaexiled.service`) |
| — | — | status: running / "Path of Exile 2 detected" vs "Waiting for Path of Exile 2" / league pill; accent dot on the icon when the game is detected; icon dimmed when not running |

### 8.2 Transport

- Path: `$XDG_RUNTIME_DIR/omaexiled/shell.sock` (dir mode 0700). Overridable with the widget setting
  `socketPath`. Readiness marker: `shell.ready` in the same directory, written (content: pid) **after** the
  socket listens; the widget watches it to reconnect immediately instead of waiting for its back-off.
- Unix stream socket, UTF-8, one JSON object per line, no pretty printing, every message carries `"v": 1`
  and `"type"`. Multiple clients (one per monitor's bar copy, plus `socat` while debugging); every client gets
  every broadcast.
- On connect the backend sends `hello` then `state`; it re-sends the **complete** `state` whenever any field
  changes. Clients replace, never merge.
- On clean shutdown remove `shell.sock` and `shell.ready`; on start unlink a stale `shell.sock` before
  listening.

Backend → widget:

```json
{"type":"hello","v":1,"app":"OmaExiled","version":"0.1.0","pid":12345}
{"type":"state","v":1,"running":true,"gameDetected":true,"gameFocused":false,
 "league":"Standard","leagueId":"Standard","overlayKey":"Shift + Space",
 "url":"http://127.0.0.1:8584","configDir":"/home/ultra/.config/omaexiled","hostRunning":true}
{"type":"error","v":1,"message":"Settings window failed to open"}
```

| `state` field | Meaning / source |
|---|---|
| `running` | always `true` (a reachable backend is running) |
| `gameDetected` | a PoE2 client exists in Hyprland (EE2 config `windowTitle`, default `"Path of Exile 2"`, renderer `web/Config.ts` L142/L202) |
| `gameFocused` | PoE2 is Hyprland's active window (the same signal that arms the binds) |
| `league` | display text for the pill; EE2 config key `leagueId` (`web/Config.ts` L129) or a resolved name |
| `leagueId` | raw `leagueId` (may be `null` before first setup) |
| `overlayKey` | EE2 `overlayKey` (default `"Shift + Space"`, `web/Config.ts` L130/L161) |
| `url` | renderer URL the backend serves (EE2 tray: `http://localhost:${serverPort}`) |
| `configDir` | absolute path opened by "Open config folder" (EE2: `<userData>/apt-data`) |
| `hostRunning` | Qt host process up (optional, for diagnostics) |

Widget → backend: `{"v":1,"type":"open-settings"}`, `{"v":1,"type":"quit"}`. Unknown types → reply
`{"type":"error","v":1,"message":"unknown command <type>"}` to that client only.

`quit` and systemd: if `omaexiled.service` uses `Restart=always`, quitting from the menu restarts it. Exit
with status 0 under `Restart=on-failure`, or have the backend run `systemctl --user stop omaexiled.service`.

### 8.3 Bun side (run on Bun 1.4.3 with stubbed `VERSION`/`currentState`/`handleShellCommand`: hello+state sent, a command split across two writes reassembled, files removed on exit)

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "bun";

const dir = `${process.env.XDG_RUNTIME_DIR}/omaexiled`;
const sockPath = `${dir}/shell.sock`;
const readyPath = `${dir}/shell.ready`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
rmSync(sockPath, { force: true });

type Client = { buf: string };
const clients = new Set<Socket<Client>>();
const line = (m: object) => JSON.stringify({ v: 1, ...m }) + "\n";

Bun.listen<Client>({
  unix: sockPath,
  socket: {
    open(s) {
      s.data = { buf: "" };
      clients.add(s);
      s.write(line({ type: "hello", app: "OmaExiled", version: VERSION, pid: process.pid }));
      s.write(line({ type: "state", ...currentState() }));
    },
    data(s, chunk) {                       // chunks are not line-aligned
      s.data.buf += chunk.toString();
      let i: number;
      while ((i = s.data.buf.indexOf("\n")) >= 0) {
        const raw = s.data.buf.slice(0, i); s.data.buf = s.data.buf.slice(i + 1);
        if (!raw.trim()) continue;
        try { handleShellCommand(s, JSON.parse(raw)); }   // open-settings | quit
        catch { s.write(line({ type: "error", message: "bad json" })); }
      }
    },
    close(s) { clients.delete(s); },
    error(s) { clients.delete(s); },
  },
});
writeFileSync(readyPath, String(process.pid));

export function broadcastState() {
  const msg = line({ type: "state", ...currentState() });
  for (const c of clients) c.write(msg);
}
process.on("exit", () => { rmSync(sockPath, { force: true }); rmSync(readyPath, { force: true }); });
// "exit" does not fire on signals; systemctl stop sends SIGTERM.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
```

### 8.4 If DESIGN.md's HTTP shape (`GET /api/status`, `POST /api/action`) is kept instead

Works from QML (`XMLHttpRequest`, verified GET + POST JSON), but: the port must be discoverable (EE2 binds
port 0; write `$XDG_RUNTIME_DIR/omaexiled/endpoint.json` and watch it with `FileView`, or use a fixed
configurable port), state changes need polling (e.g. every 2 s while the popup is open, 10–15 s otherwise,
per monitor copy), liveness = request errors, and every poll goes through the full HTTP stack. The socket gives
push, liveness for free and no port discovery; the `omaexiled ctl` CLI can keep using HTTP independently.

---

## 9. Skeleton (verified)

Layout in the repo: `omarchy-plugin/{manifest.json, OmaExiledWidget.qml, ExiledBackend.qml}` → installed as
`~/.config/omarchy/plugins/omaexiled/`. File names avoid `qs.Ui` type names (`BarWidget`, `Panel`, …) because
the plugin dir is implicitly imported next to `qs.Ui`.

Verification done on this machine (scratch harness, no change to the live shell):
- `omarchy plugin validate` on the folder → exit 0.
- Loaded in a standalone `qs -p` harness (Ui/Commons symlinked, `PluginBarApi` as `bar`): no QML warnings;
  stopped state → rows `start, config`, size 27×26; a Bun `Bun.listen({unix})` server started 1 s late →
  widget reconnected, parsed `hello`/`state` (`running=true`, "Path of Exile 2 detected", configDir from state,
  rows `settings, browser, config, quit` all enabled); `activate("settings")` → server received
  `{"v":1,"type":"open-settings"}`.
- With the server appearing at ~3.4 s and back-off due at 7 s, the `shell.ready` FileView kick connected at
  3.36 s.
- Not exercised in the harness: opening the `KeyboardPanel` (needs a real bar window); it is the same
  composition as `omarchy.power`, `omarchy.tailscale`, `ultra.agents` and Omastorm.

### 9.1 `manifest.json`

```json
{
  "schemaVersion": 1,
  "id": "omaexiled",
  "name": "OmaExiled",
  "version": "0.1.0",
  "author": "OmaExiled",
  "license": "MIT",
  "description": "Path of Exile 2 price checker: status, settings, browser, config folder, quit.",
  "kinds": ["bar-widget"],
  "entryPoints": {
    "barWidget": "OmaExiledWidget.qml"
  },
  "barWidget": {
    "displayName": "OmaExiled",
    "description": "PoE2 price-check status and menu (replaces the EE2 tray icon).",
    "category": "Games",
    "allowMultiple": false,
    "defaultSection": "right",
    "defaults": {
      "hideWhenStopped": false,
      "startCommand": "systemctl --user start omaexiled.service",
      "socketPath": "",
      "configDir": ""
    },
    "schema": [
      { "key": "hideWhenStopped", "type": "boolean", "label": "Hide when stopped", "defaultValue": false,
        "description": "Remove the icon from the bar while the OmaExiled backend is not running." },
      { "key": "startCommand", "type": "string", "label": "Start command",
        "defaultValue": "systemctl --user start omaexiled.service",
        "description": "Run by the Start item (bash -lc) when the backend is not running." },
      { "key": "socketPath", "type": "path", "label": "Backend socket", "defaultValue": "",
        "description": "Empty means $XDG_RUNTIME_DIR/omaexiled/shell.sock." },
      { "key": "configDir", "type": "path", "label": "Config folder", "defaultValue": "",
        "description": "Opened by 'Open config folder' while the backend is not running. Empty means ~/.config/omaexiled." }
    ]
  }
}
```

### 9.2 `ExiledBackend.qml`

```qml
import QtQuick
import Quickshell
import Quickshell.Io

// One connection from a bar-widget instance to the OmaExiled backend.
// Transport: Unix stream socket, newline-delimited JSON (see
// docs/port-notes/09-omarchy-shell-plugin.md, "Backend contract").
QtObject {
  id: backend

  property string socketPath: ""
  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
  readonly property string path: socketPath !== "" ? socketPath : runtimeDir + "/omaexiled/shell.sock"
  // Touched by the backend once the socket listens (same directory as the socket).
  readonly property string readyPath: path.substring(0, path.lastIndexOf("/")) + "/shell.ready"

  property var hello: null
  property var state: null
  property string error: ""

  // A state message has arrived on a live connection: the backend is up.
  readonly property bool connected: state !== null
  readonly property bool gameDetected: !!state && state.gameDetected === true
  readonly property bool gameFocused: !!state && state.gameFocused === true
  readonly property string league: state && state.league ? String(state.league) : ""
  readonly property string url: state && state.url ? String(state.url) : ""
  readonly property string configDir: state && state.configDir ? String(state.configDir) : ""
  readonly property string version: hello && hello.version ? String(hello.version) : ""

  function receive(line) {
    var message
    try {
      message = JSON.parse(line)
    } catch (e) {
      error = "Unreadable message from OmaExiled"
      return
    }
    if (message.v !== 1) {
      error = "OmaExiled speaks protocol " + message.v + "; this widget speaks 1"
      return
    }
    if (message.type === "hello") hello = message
    else if (message.type === "state") {
      state = message
      error = ""
    } else if (message.type === "error") error = String(message.message || "")
  }

  function send(command) {
    if (!socket || !socket.connected) return false
    socket.write(JSON.stringify(Object.assign({ v: 1 }, command)) + "\n")
    socket.flush()
    return true
  }

  function reconnectNow() {
    var previous = socket
    socket = socketFactory.createObject(backend)
    if (previous) previous.destroy()
  }

  property Component socketFactory: Component {
    Socket {
      path: backend.path
      connected: true
      parser: SplitParser {
        onRead: function(line) { backend.receive(line) }
      }
      onConnectedChanged: {
        if (connected) {
          backend.retryDelay = 1000
        } else {
          backend.state = null
          backend.hello = null
        }
      }
    }
  }

  // A Socket whose connect failed cannot be retried by toggling `connected`
  // (omastorm ui/Engine.qml); a fresh object is created instead.
  property var socket: socketFactory.createObject(backend)

  // Back off while the backend is down: every failed connect logs a
  // "quickshell.io.socket ... ServerNotFoundError" warning to the shell log.
  property int retryDelay: 1000
  property Timer reconnect: Timer {
    interval: backend.retryDelay
    repeat: true
    running: !backend.socket || !backend.socket.connected
    onTriggered: {
      backend.retryDelay = Math.min(30000, backend.retryDelay * 2)
      backend.reconnectNow()
    }
  }

  // The backend touches shell.ready once its socket listens; react at once
  // instead of waiting out the back-off. FileView reports creation of a file
  // that did not exist when it started watching.
  property FileView readyFile: FileView {
    path: backend.readyPath
    watchChanges: true
    printErrors: false
    onFileChanged: {
      reload()
      if (!backend.socket || !backend.socket.connected) {
        backend.retryDelay = 1000
        backend.reconnectNow()
      }
    }
  }
}
```

### 9.3 `OmaExiledWidget.qml`

```qml
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// OmaExiled bar widget: the Electron tray icon of Exiled Exchange 2, as an
// omarchy-shell bar widget. Left click opens the menu; right click opens the
// settings window (or starts OmaExiled when it is not running).
//
// Root is qs.Ui Panel (like omarchy.power / omarchy.tailscale): it supplies
// bar/moduleName/settings, setting(), opened/open()/close()/toggle(), and the
// popout-switch hooks KeyboardPanel and the bar expect. Exposing
// open/close/opened on the root is also what lets
// `omarchy-shell shell toggle omaexiled` reach this widget.
Panel {
  id: root
  moduleName: "omaexiled"
  // Panel's built-in IpcHandler would expose only open/close/toggle; this
  // widget registers its own target below.
  manageIpc: false

  readonly property string home: Quickshell.env("HOME")
  readonly property color fg: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgentColor: bar ? bar.urgent : Commons.Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Inline settings from this widget's shell.json entry. The host does not
  // merge the manifest's `defaults`, so every read carries its own fallback.
  readonly property bool hideWhenStopped: setting("hideWhenStopped", false) === true
  readonly property string startCommand: String(setting("startCommand", "systemctl --user start omaexiled.service"))
  readonly property string fallbackConfigDir: String(setting("configDir", "")) || (home + "/.config/omaexiled")

  readonly property bool running: backend.connected
  readonly property bool shown: !(hideWhenStopped && !running)
  readonly property string configDir: backend.configDir || fallbackConfigDir
  readonly property string statusText: !running ? "Not running"
    : (backend.gameDetected ? "Path of Exile 2 detected" : "Waiting for Path of Exile 2")

  // Same items as EE2 main/src/AppTray.ts, plus Start while stopped.
  // Glyphs are Font Awesome codepoints from the bar's Nerd Font.
  readonly property var rows: running ? [
    { id: "settings", icon: "", label: "Settings / League", enabled: true, separatorBefore: false },
    { id: "browser", icon: "", label: "Open in Browser", enabled: backend.url !== "", separatorBefore: false },
    { id: "config", icon: "", label: "Open config folder", enabled: true, separatorBefore: true },
    { id: "quit", icon: "", label: "Quit", enabled: true, separatorBefore: false }
  ] : [
    { id: "start", icon: "", label: "Start OmaExiled", enabled: true, separatorBefore: false },
    { id: "config", icon: "", label: "Open config folder", enabled: true, separatorBefore: true }
  ]

  property int cursorIndex: 0
  property bool cursorActive: false

  // Detached: survives plugin hot-reload and shell restarts. `env -C` gives
  // the child a real cwd (Quickshell's own is qrc:/qs-blackhole).
  function launch(argv) {
    Quickshell.execDetached(["env", "-C", root.home].concat(argv))
  }

  function activate(id) {
    if (id === "settings") backend.send({ type: "open-settings" })
    else if (id === "browser") { if (backend.url !== "") launch(["xdg-open", backend.url]) }
    else if (id === "config") launch(["xdg-open", root.configDir])
    else if (id === "quit") backend.send({ type: "quit" })
    else if (id === "start") launch(["bash", "-lc", root.startCommand])
    root.close()
  }

  function rowIndex(id) {
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return i
    return -1
  }

  function moveCursor(delta) {
    if (!cursorActive) {
      cursorActive = true
      return
    }
    var i = cursorIndex
    for (var tries = 0; tries < rows.length; tries++) {
      i = Math.max(0, Math.min(rows.length - 1, i + delta))
      if (rows[i].enabled) break
    }
    cursorIndex = i
  }

  function activateCursor() {
    var row = rows[cursorIndex]
    if (cursorActive && row && row.enabled) activate(row.id)
  }

  onOpenedChanged: if (opened) {
    cursorActive = false
    cursorIndex = 0
  }
  onRowsChanged: if (cursorIndex >= rows.length) cursorIndex = 0

  visible: shown
  implicitWidth: shown ? button.implicitWidth : 0
  implicitHeight: shown ? button.implicitHeight : 0

  ExiledBackend {
    id: backend
    socketPath: String(root.setting("socketPath", ""))
  }

  // `omarchy-shell omaexiled status`. One bar copy per monitor registers the
  // same target and only one of them receives calls; every copy reads the
  // same backend, so the answer does not depend on which one it is.
  IpcHandler {
    target: "omaexiled"

    function status(): string {
      return JSON.stringify({ running: root.running, error: backend.error, state: backend.state })
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    useActiveColor: false
    active: root.opened
    dimmed: !root.running
    tooltipText: root.running
      ? "OmaExiled" + (backend.league !== "" ? " · " + backend.league : "")
      : "OmaExiled is not running"
    onPressed: function(b) {
      if (b === Qt.RightButton) root.activate(root.running ? "settings" : "start")
      else root.toggle()
    }
  }

  // Game-detected dot in the icon's corner.
  Rectangle {
    visible: root.running && backend.gameDetected
    width: Style.space(5)
    height: width
    radius: width / 2
    color: Commons.Color.accent
    anchors.right: button.right
    anchors.bottom: button.bottom
    anchors.rightMargin: Style.space(5)
    anchors.bottomMargin: Style.space(5)
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { root.moveCursor(dy !== 0 ? dy : dx) }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var keys = { s: "settings", b: "browser", c: "config", q: "quit" }
        var index = root.rowIndex(keys[String(t).toLowerCase()] || "")
        if (index >= 0 && root.rows[index].enabled) root.activate(root.rows[index].id)
      }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: "OmaExiled"
          meta: root.statusText
          detail: backend.league
          foreground: root.fg
          fontFamily: root.fontFamily
          iconOpacity: root.running ? 1.0 : 0.5
          iconComponent: Component {
            Text {
              textFormat: Text.PlainText
              text: ""
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
        }

        Text {
          visible: backend.error !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: backend.error
          color: root.urgentColor
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        PanelSeparator {
          foreground: root.fg
        }

        Column {
          width: parent.width
          spacing: Style.space(4)

          Repeater {
            model: root.rows
            delegate: MenuRow { }
          }
        }
      }
    }
  }

  component MenuRow: Column {
    id: menuRow
    required property var modelData
    required property int index

    width: parent ? parent.width : 0
    spacing: Style.space(4)

    PanelSeparator {
      visible: menuRow.modelData.separatorBefore === true
      foreground: root.fg
    }

    CursorSurface {
      width: parent.width
      implicitHeight: label.implicitHeight + Style.spacing.xl
      foreground: root.fg
      hasCursor: root.cursorActive && root.cursorIndex === menuRow.index
      opacity: menuRow.modelData.enabled ? 1.0 : 0.45

      Row {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(6)
        anchors.rightMargin: Style.space(6)
        spacing: Style.space(8)

        Text {
          textFormat: Text.PlainText
          text: menuRow.modelData.icon
          width: Style.space(22)
          horizontalAlignment: Text.AlignHCenter
          color: menuRow.modelData.id === "quit" ? root.urgentColor : root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          anchors.verticalCenter: parent.verticalCenter
        }

        Text {
          id: label
          textFormat: Text.PlainText
          text: menuRow.modelData.label
          color: root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          anchors.verticalCenter: parent.verticalCenter
        }
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        enabled: menuRow.modelData.enabled
        cursorShape: Qt.PointingHandCursor
        onEntered: {
          root.cursorActive = true
          root.cursorIndex = menuRow.index
        }
        onClicked: root.activate(menuRow.modelData.id)
      }
    }
  }
}
```

Design notes on the skeleton:
- One `ExiledBackend` (one socket) per bar copy, i.e. per monitor. A QML singleton (Omastorm's choice) would
  share one connection but survives plugin reloads with its old code; per-instance keeps hot reload honest.
- Glyphs are Font Awesome codepoints present in Nerd Fonts (`` money, `` cog, `` globe,
  `` folder-open, `` power-off, `` play). Swap the bar icon for a drawn `iconComponent`
  (as Omastorm's `RadarMark` / tailscale's `TailscaleIcon`) if a PoE-specific mark is wanted.
- Keys inside the popup: j/k/arrows move, Enter/Space activate, Esc closes, Tab moves to the neighbouring panel
  widget, `s`/`b`/`c`/`q` trigger Settings/Browser/Config/Quit directly.
- Right click = Settings (or Start). Middle click is unused.
- `hideWhenStopped` removes the icon from the bar while the backend is down; `shell toggle` then has no drawn
  copy and opens on a zero-size placeholder — keep it `false` unless wanted.

### 9.4 Install / try

```bash
omarchy plugin validate omarchy-plugin
rsync -a --delete omarchy-plugin/ ~/.config/omarchy/plugins/omaexiled/
omarchy plugin enable omaexiled --section right --after omarchy.tray
omarchy-shell shell toggle omaexiled          # open the menu
omarchy-shell omaexiled status | jq           # what the widget sees
journalctl --user -t omarchy-shell -f | grep -Ei 'omaexiled|Plugin widget|PluginRegistry'
```

---

## 10. Edge cases, risks, open questions

Edge cases the implementation must handle:
- Backend down at shell start, up later → back-off reconnect (1 s → 30 s) + `shell.ready` kick.
- Backend restarts → socket closes → `state = null` ("Not running", icon dimmed) → reconnect → fresh
  `hello`/`state`.
- Protocol version mismatch → error text in the popup, state ignored.
- Several monitors → several sockets; the backend must not assume a single client.
- Plugin reload storms (any file write under `~/.config/omarchy/plugins`, `omarchy plugin add` cloning) →
  connect/disconnect bursts; keep `open` cheap.
- `quit` while systemd restarts the service (8.2).
- `xdg-open` targets: `url` empty before the HTTP server is up (row disabled); `configDir` may not exist yet
  (backend should create it before advertising it).
- League names and errors are untrusted text → `Text.PlainText`.
- Fullscreen PoE2 hides the bar (Top layer); popup via `shell toggle` takes keyboard focus from the game while
  open. Hyprland binds remain active (they are compositor binds), so a price-check hotkey still fires while the
  menu is open.
- `omarchy plugin disable omaexiled` drops the widget's inline settings with its layout entry.
- `shell.json` missing → defaults file is used; first `omarchy plugin enable` writes a full user `shell.json`.

Risks:
- The plugin API is from an Omarchy **alpha** (`4.0.0.alpha`); facades (`PluginBarApi`, `PluginShellApi`)
  and Ui component properties may change. Pin against the files cited here and re-check after Omarchy updates.
- Plugins run unsandboxed in the shell process; a QML error can break the widget but not the shell, while a
  busy loop or blocking call would freeze the whole desktop shell. Keep work in the backend.

Open questions:
1. Transport: Unix socket push (recommended) vs DESIGN.md's `GET /api/status` + `POST /api/action` (needs port
   discovery + polling)?
2. Distribution: copy `omarchy-plugin/` via an install script (recommended), or publish a separate small repo
   (or `git subtree split`) so `omarchy plugin add <url>` works with `manifest.json` at its root? Cloning the
   whole OmaExiled repo into the plugins dir would put node_modules/build output under the inotify watcher.
3. Plugin id: `omaexiled` (used here; also the IPC target and widget `moduleName`) — confirm before release
   (cannot start with `omarchy.`).
4. Who starts the backend: systemd user unit (DESIGN.md) with the widget only offering "Start", or should the
   widget bootstrap it automatically like Omastorm (`execDetached` + retry)?
5. Should "Settings / League" focus/raise the settings window on the PoE2 workspace (host/backend concern)?
6. Should a Hyprland bind (`omarchy-shell shell toggle omaexiled`) be shipped for the menu? EE2 had none.
