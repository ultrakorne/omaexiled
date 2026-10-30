# 07: Item check, stash search, chat commands, settings UI

Source: `/home/ultra/Developer/Exiled-Exchange-2` (branch `master`). All paths below are
relative to that repo unless they start with `/`. Line numbers refer to `master` at the time of
writing.

Target architecture (decided): Bun backend replaces Electron main. A Qt6 host
(QtWebEngine + layer-shell-qt) shows renderer panels in layer-shell OVERLAY surfaces and the
settings UI in a normal window. Hyprland binds are active only while PoE2 is focused.
Keystrokes go to the game through Hyprland `sendshortcut`/`send_key_state`. Clipboard goes
through `wl-copy`/`wl-paste`. An Omarchy bar plugin (QML) replaces the tray.

---

## 0. Summary

* **Item check** (`renderer/src/web/item-check/`) is a small panel: item name, buttons
  `wiki` / `poedb` / `CoE` / `Find in Stash` / `$`, and a DPS block for weapons. It also
  registers 5 hotkey-only actions (`open-wiki`, `open-poedb`, `open-craft-of-exile`,
  `search-similar`, `search-same-priced`). **All of them need the renderer**: the item parser runs
  in the renderer, and the renderer calls `window.open`. **Map-like items render `MapCheck`
  (from `map-check/`) instead of `ItemInfo`.** Because map check is DROPPED, the port must decide
  what map-like items show (see 1.9).
* **Stash search** is a multi-instance overlay widget with groups of `{name,text,hotkey}`
  entries. Its editor is reachable **only** through the widget's "edit" button. It is not in the
  default settings menu. The overlay widgets go away in the port, so **the port needs a new
  "Stash search" settings tab**, and the bar plugin may need click-to-search buttons. Host action:
  `CLIENT->MAIN::user-action {action:"stash-search", text}` or the hotkey action
  `{type:"stash-search", text}`. Main-side typing: write clipboard, then `Ctrl+F`, `Ctrl+V`,
  `Enter`, then restore the clipboard after 120 ms.
* **Chat commands** live in `config.commands[] = {text, hotkey, send}`. `@last` is handled only by
  the game's own **Ctrl+Enter reply-to-last-whisper** plus key tricks. There is **no client-log
  dependency**. `send:true` means press Enter, then Enter, Up, Up, Esc. `send:false` leaves the
  text in the open chat box.
* **Settings** is an overlay widget (`wmType:"settings"`, exclusive). It clones the config on
  show, and Save writes the clone back. **Quirk:** in EE2 the Save button's `saveConfig()` is a
  no-op, because an exclusive widget is shown at that moment. The config reaches disk later, on
  overlay `blur`. The standalone window must send `save-config` directly.
* **HotkeyInput** produces strings like `"Ctrl + Shift + Alt + D"` built from
  `KeyboardEvent.code` (physical key) on **keyup**. Section 5.7 has a full table that maps these
  to Hyprland key names and `code:` values.
* **Client log**: neither item check nor chat `@last` depends on it. All of `client-log/` can be
  dropped.

### 0.1 System packages for this area (checked on this machine, 2026-10-30)

| Need | Package / binary | Status here |
|---|---|---|
| Clipboard read/write (`wl-copy`, `wl-paste`) | `wl-clipboard` | installed (2.3.0) |
| Send keys to the game (`hyprctl dispatch sendshortcut`, Lua `hl.dsp.send_key_state`) | Hyprland | installed (0.56.2, Lua config + `hyprctl eval`) |
| Open wiki/poe2db/CoE/GitHub links in the browser | `xdg-utils` (`xdg-open`) | installed; default browser `omarchy-browser.desktop` |
| Build the Qt host | `cmake` (+ `ninja`, optional) | **NOT installed**: `sudo pacman -S cmake ninja` (LayerShellQt ships only CMake config files, so qmake is not practical) |
| Qt host runtime/dev | `qt6-base 6.12.0`, `qt6-webengine 6.11.2-2` (built against 6.12), `qt6-wayland`, `layer-shell-qt 6.8.1` | installed. Smoke-test QtWebEngine first, because the package version label lags qt6-base |
| Backend | `bun 1.4.3` | installed |
| Only if wl-copy does not reach the XWayland game on Ctrl+V | `xclip` (or `xsel`) to write the X11 CLIPBOARD directly | **NOT installed**. Install only if the validation in 2.7 fails |
| Not needed | `ydotool`, `wtype`, `xdotool`, uiohook | Earlier experiments rejected them (see omarchy branches' `LINUX.md`) |

---

## 1. Item check

### 1.1 Files

| File | Role |
|---|---|
| `renderer/src/web/item-check/WidgetItemCheck.vue` (126 lines) | Widget spec + container. Listens for `MAIN->CLIENT::item-text` with `target==="item-check"`, parses, chooses `MapCheck` vs `ItemInfo`, positions itself. **Calls `registerActions()` (line 80)**, which wires up the hotkey-only actions. |
| `renderer/src/web/item-check/ItemInfo.vue` (83 lines) | The visible panel for non-map items. |
| `renderer/src/web/item-check/hotkeyable-actions.ts` (197 lines) | URL builders and stash-search text builders, plus `registerActions()`. |
| `renderer/src/web/item-check/settings-item-check.vue` (73 lines) | Settings tab "Item info" (`name: "item.info"`). |
| `renderer/src/web/item-check/widget.ts` (13 lines) | `ItemCheckWidget` type. |
| `renderer/specs/web/item-check.test.ts` | Vitest for `encodePoe2dbUri` (exported via `__testExports`, line 195). Keep it. |

### 1.2 Config schema (`ItemCheckWidget`, `widget.ts:3-12`)

```ts
interface ItemCheckWidget extends Widget {   // wmType: "item-check", single instance
  hotkey: string | null;          // open item-check panel
  wikiKey: string | null;         // hotkey: open poe2wiki
  poedbKey: string | null;        // hotkey: open poe2db
  craftOfExileKey: string | null; // hotkey: open Craft of Exile
  stashSearchKey: string | null;  // hotkey: stash-search by item name
  samePricedKey: string | null;   // hotkey: stash-search by price note (+name)
  samePricedType: "price" | "both";
  maps: MapCheckConfig;           // { profile: 1|2|3, showNewStats: boolean, selectedStats: {matcher, decision}[] }
}
```

Defaults are at `WidgetItemCheck.vue:23-55`. All keys are `null` (**including `hotkey`**, so EE2 has
no default item-check key). `samePricedType:"both"`. `wmZorder:"exclusive"`,
`wmFlags:["hide-on-blur","menu::skip"]`, `wmWants:"hide"`. `maps.selectedStats` defaults to 4
entries with decisions `"w--"`, `"d--"`, `"d--"`, `"g--"` (one character per profile I/II/III:
`d` deadly, `w` warning, `g` good, `s` seen, `-` unset; see `map-check/common.ts:25-34`).

The task brief says item check is **Alt+D**. EE2 has no such default, so the port must set
`hotkey: "Alt + D"` in its own defaults. Check for clashes: the price-check defaults are
`hotkey:"D"` + `hotkeyHold:"Ctrl"`, giving `"Ctrl + D"`, and `hotkeyLocked:"Ctrl + Alt + D"`
(`price-check/PriceCheckWindow.vue:193-195`). The user's own Hyprland config already binds
`CTRL + ALT + D` to the old `poe_price_checker` script (`~/.config/hypr/bindings.lua`), so that
bind must be removed or it will conflict.

Config migrations that touch item-check (`renderer/src/web/Config.ts`): v7 (299-308) renamed
`map-check` to `item-check`; v14 (410-419) added `wikiKey/poedbKey/craftOfExileKey/stashSearchKey`;
v16 (459-469) moved `itemCheckKey` to `hotkey`; v27 (584-593) added `samePricedKey`; v28 (594-603)
added `samePricedType`.

### 1.3 Event flow (EE2)

1. The host config is built in the renderer by `getConfigForHost()` (`Config.ts:692-843`). For
   item check (`Config.ts:714-750`) it creates:
   * `wikiKey` → `{shortcut, action:{type:"copy-item", target:"open-wiki"}}`
   * `craftOfExileKey` → `target:"open-craft-of-exile"`
   * `poedbKey` → `target:"open-poedb"`
   * `stashSearchKey` → `target:"search-similar"`
   * `samePricedKey` → `target:"search-same-priced"`
   * `hotkey` → `{type:"copy-item", target:"item-check", focusOverlay:true}`
   * None of these set `keepModKeys`, so **all keys of the hotkey are released** before the copy
     (`main/src/shortcuts/Shortcuts.ts:189-201`).
2. The main process, on the global shortcut (`Shortcuts.ts:215-244`):
   1. records `pressPosition = screen.getCursorScreenPoint()`,
   2. starts `HostClipboard.readItemText()`. This blanks the clipboard (or writes
      `__EE2_FORCE_EMPTY_<ts>` on Linux), then polls every 48 ms for up to 500 ms for text that
      starts with an item header (`HostClipboard.ts:31-83`, languages at 117-173),
   3. presses the copy chord: `mergeTwoHotkeys("Ctrl + C", gameConfig.showModsKey)`. With the
      default `showModsKey` `"Alt"` this is `Ctrl+Alt+C` (`Shortcuts.ts:293-324`,
      `GameConfig.ts:50-52`),
   4. on success sends `MAIN->CLIENT::item-text` to the **last-active** WS client:
      `{target, clipboard, position:{x,y}, focusOverlay}` (`ipc/types.ts:183-192`),
   5. if `focusOverlay && overlay.wasUsedRecently`, focuses the overlay.
3. In the renderer:
   * `WidgetItemCheck.vue:82-90` handles `target==="item-check"`. It sets `checkPosition`, sets
     `item = parseClipboard(clipboard).unwrapOr(null)`, and if the parse succeeded calls
     `wm.show(wmId)`. **If the parse fails, nothing is shown** (no error UI, unlike price check).
   * `hotkeyable-actions.ts:85-113` (`registerActions`) handles the other 5 targets. It parses and
     silently returns if the parse fails, then dispatches to the functions in 1.5.

**Port implications**

* The hotkey-only actions still go backend → renderer (parse) → `window.open` or
  `user-action stash-search` → backend. So **a renderer instance with `registerActions()`
  mounted must always be alive**, even when no panel is visible. In EE2 it lives inside the
  always-mounted `WidgetItemCheck`. Mount it in the always-alive panel renderer, or in a
  dedicated hidden view.
* `item-text` routing: EE2 sends to `lastActiveClient` (`main/src/server.ts:58-70`, 97-112). This
  is the most recently connected socket, or the last socket that sent `CLIENT->MAIN::used-recently`.
  **Problem:** when the settings window or the bar plugin opens a WS connection, it becomes
  last-active and steals `item-text`. The port must route `item-text` to the panel renderer by
  role, for example `ws://…/events?role=panel|settings|bar`.
* `focusOverlay:true` has no meaning in the port, because the game keeps keyboard focus. Keep
  the field for payload compatibility.

### 1.4 Visible feature checklist (ItemInfo, non-map items)

From `ItemInfo.vue`:

* [ ] Container `bg-gray-800 text-gray-200 border-gray-900 border-4`,
      `min-width: 20rem; max-width: min(100vw - var(--game-panel), 30rem)` (line 4).
      `--game-panel` is set by `OverlayWindow.vue:5`; in the port, set it to 0 or remove it.
* [ ] Header: `item.info.name` (line 6, computed at line 82). This is the **localized** name. For
      uniques it is the unique name; otherwise the base type.
* [ ] Button row (lines 7-22):
  * [ ] `wiki`, which calls `openWiki` (always shown).
  * [ ] `poedb`, which calls `openPoedb` (always shown).
  * [ ] `CoE`, which calls `openCoE`, **only if** `item.info.craftable && itemIsModifiable(item)`
        (lines 67-70). `itemIsModifiable` is at `parser/ParsedItem.ts:152-159`:
        `info.craftable && !isCorrupted && !isMirrored && !isSanctified`.
  * [ ] Separator icon `fa-solid fa-ellipsis-vertical`.
  * [ ] `t("item.find_in_stash")` ("Find in Stash"), which calls `findSimilarItems`.
  * [ ] `$` button (`fas fa-dollar`), which calls `findSamePricedItems`, **only if** `item.note`
        is truthy (line 72). `note` comes from the item's `Note: ` line
        (`parser/Parser.ts:1525`, `PRICE_NOTE: 'Note: '`).
* [ ] Weapon DPS grid (lines 23-34), shown when `item.weaponAS` is truthy (lines 74-80):
  * `phys = round(weaponAS * (weaponPHYSICAL ?? 0))`
  * `elem = round(weaponAS * (weaponELEMENTAL ?? 0))`
  * `total = phys + elem`
  * Labels: `item.physical_dps`, `item.elemental_dps`, `item.total_dps`. The i18n strings
    contain `{0}` (for example `"Physical DPS: {0}"`), but ItemInfo calls them without an
    argument and puts the number in the next grid cell. vue-i18n v9 renders a missing list
    argument as an empty string, so you get "Physical DPS: " followed by the value. Check this
    visually, and keep the behaviour or pass the value.
* [ ] **No close button**, no title bar, no move handles (`Widget` props: `move-handles="none"`,
      `:removable="false"`, `:inline-edit="false"`, `WidgetItemCheck.vue:2-7`). In EE2 the
      generic widget hover panel still offers "edit", which opens Settings in item-check mode. In
      EE2 the panel is dismissed by blur (the `hide-on-blur` flag) after focus returns to the
      game: Esc, clicking the overlay background, or `Ctrl+W` in the overlay window
      (`main/src/windowing/OverlayWindow.ts:155-161`). **The port needs a dismissal design** (see
      open questions).

### 1.5 Hotkeyable actions: exact behaviour and URL templates (`hotkeyable-actions.ts`)

| Action | Function | Exact output | Opened by |
|---|---|---|---|
| Wiki | `openWiki` (115-117) | `https://www.poe2wiki.net/wiki/${item.info.refName}` with the **raw** refName (English); spaces and quotes are not encoded by the code | `window.open(url)` |
| PoE2DB | `openPoedb` (118-121) | `https://poe2db.tw/${POEDB_LANGS[AppConfig().language]}/${getPoe2dbPath(item)}` | `window.open(url)` |
| Craft of Exile | `openCoE` (122-127) | `https://craftofexile.com/?game=poe2&eimport=${encodeURIComponent(item.rawText)}`, i.e. the full clipboard text, URL-encoded (can be several KB) | `window.open(url)` |
| Find in stash | `findSimilarItems` (129-135) | `text = JSON.stringify(item.info.name)` (a quoted, JSON-escaped localized name) | `Host.sendEvent({name:"CLIENT->MAIN::user-action", payload:{action:"stash-search", text}})` |
| Same priced | `findSamePricedItems` (137-151) | Returns early if there is no `item.note`. `note = JSON.stringify(item.note)` and `name = JSON.stringify(item.info.name)`. If `AppConfig("item-check").samePricedType === "both"` and `note.length + name.length < 51`, then `text = note + name` (two quoted strings, **no space**). Otherwise `text = note`. Lengths include the quote characters. | same `user-action stash-search` |

`POEDB_LANGS` (7-17): `en→us, ru→ru, cmn-Hant→tw, ko→kr, ja→jp, de→de, es→sp, pt→pt, fr→fr`.
There is no `th` entry, but `th` is not a selectable language anyway.

**How `window.open` reaches the browser in EE2:** `main/src/windowing/OverlayWindow.ts:71-74`
uses `setWindowOpenHandler` to call `shell.openExternal(url)` and returns `{action:"deny"}`. The
same path handles `<a target="_blank">` in `settings/about.vue`.

**Port:** route this through the backend. Either:
(a) the host handles `QWebEnginePage::newWindowRequested` (Qt6) by calling
`QDesktopServices::openUrl` / `xdg-open` and never creating a window, or
(b) better, replace `window.open` in the renderer with an explicit event such as
`CLIENT->MAIN::open-external {url}` and have the backend run `xdg-open <url>`.

Implement (b) **and** keep (a) as a safety net for `target=_blank` links. Watch out: these opens
are triggered from a WebSocket message, not a user gesture, so make sure popup blocking does not
apply (`QWebEngineSettings::JavascriptCanOpenWindows`).

### 1.6 poe2db path algorithm (`getPoe2dbPath`, 157-191). Port it verbatim.

1. If `item.category` is falsy, return `undefined`. The URL then becomes
   `…/us/undefined`. This is an existing bug; keep it or guard it.
2. If `rarity === Unique`, return `encodePoe2dbUri(refName)`, where `encodePoe2dbUri` replaces
   spaces with `_` and deletes `'` (153-155).
3. If `POE2DB_CONVERSIONS.has(refName)`, return `CONV[refName] + "#ModifiersCalc"`. This covers
   refName keys such as `"Ruby"`, `"Life Flask"`, `"Charm"`, the relics, the tablets and
   `"Waystones(Low|Mid|Top)"`.
4. If `!POE2DB_CONVERSIONS.has(category)`, return `encodePoe2dbUri(refName)`.
5. Otherwise `path = CONV[category]`. If `ARMOUR.has(category)` and the category is not
   `Buckler` or `Focus`, append `_str` if `armourAR`, `_dex` if `armourEV`, and `_int` if
   `armourES`, in that order. Return `path + "#ModifiersCalc"`.

The `POE2DB_CONVERSIONS` table is at lines 19-83: 37 categories plus refName keys. Copy it as-is.
`ARMOUR` is in `parser/meta.ts:109`.

### 1.7 Placement and visibility (EE2) and how they map to a layer surface

`WidgetItemCheck.vue:94-109`:

* `side = checkPosition.x > window.screenX + width/2 ? "inventory" : "stash"`. Here
  `width` is the overlay width and `checkPosition` is the cursor position at hotkey press, in
  screen coordinates.
* `poePanelWidth = height * 986/1600` (`OverlayWindow.vue:328-333`). It returns **0 when
  `!Host.isElectron`**. QtWebEngine's UA does not contain "Electron", so the port must replace
  the `isElectron` checks with its own flag.
* Anchor: `{pos: side==="stash" ? "cl" : "cr", y: 50, x: side==="stash" ? poePanelWidth/width*100 : (width-poePanelWidth)/width*100}`.
  So the panel is vertically centred. On the stash side its left edge touches the right edge of
  the game's left panel. On the inventory side its right edge touches the left edge of the
  game's right panel.

**Port:** the backend reads the cursor with `hyprctl cursorpos -j` and the game window geometry
with `hyprctl clients -j` or `activewindow -j`, computes the side, and tells the host to anchor
the item-check layer surface:
* stash side: `left` anchor, margin = `poePanelWidth`;
* inventory side: `right` anchor, margin = `poePanelWidth`;
* vertically centred: anchor neither top nor bottom, or compute a top margin.

Size the surface to its content. The width is 20–30rem, and rem = `config.fontSize` px.

Window-manager flags:
* `wmZorder:"exclusive"`: showing item check hides any other shown exclusive widget (price
  check), and the other way round (`OverlayWindow.vue:194-201`). Keep "one exclusive panel at a
  time" between the price panel and the item-check panel.
* `hide-on-blur`: hidden when the overlay loses focus (`OverlayWindow.vue:133-150`).
* `menu::skip`: not in the widget menu.
* Line 92 forces `wmWants = "hide"` on mount.

### 1.8 Settings tab for item check (`settings-item-check.vue`)

Component name `"item.info"`, label "Item info". Rows:

* `item.open_on_wiki`: `HotkeyInput v-model=wikiKey`
* `item.open_on_poedb`: `poedbKey`
* "Open base item on Craft of Exile" (hard-coded English label, **only rendered when
  `config.language === "en"`**, lines 11-14): `craftOfExileKey`. The action and the CoE button
  work in every language; only the settings row is hidden.
* `item.find_in_stash`: `stashSearchKey`
* `item.find_same_price` ("Filter by"): `<select v-model=samePricedType>` with options
  `price` ("Price Only") and `both` ("Price and Item"), plus `HotkeyInput v-model=samePricedKey`.

All rows use `configModelValue(() => findWidget("item-check", props.config)!, key)`, so they
operate on the settings **clone**. The item-check **open** hotkey (`hotkey`) is **not** on this
tab. It is on the Hotkeys tab, and it appears twice there, as "Map check" and as "Item info"
(see 5.6).

### 1.9 Dependency on map-check (decision needed)

`WidgetItemCheck.vue:9-10` and `111-125`: `MapCheck` is rendered **instead of** `ItemInfo` when
`isMapLike`:
* `category === Map && rarity !== Unique`, or
* `HeistContract`, `HeistBlueprint`, `Invitation`, or
* `refName === "Expedition Logbook"`.

`MapCheck` (`map-check/MapCheck.vue`) contains:
* map name;
* profile selector I/II/III, which **mutates the live config** `config.maps.profile`;
* screenshot (`FullscreenImage`, shown unless unique and unidentified);
* one `MapStatButton` per stat. Clicking cycles d→w→g→s→d and mutates
  `config.maps.selectedStats`. An eye-slash "seen" toggle appears when `showNewStats`;
* unrecognized modifiers listed with "Not recognized modifier —";
* an outdated-translation notice.

Map check imports outside `item-check/`:
* `map-check/MapCheck.vue`, `MapStatButton.vue`, `common.ts`, `prepare-map-stats.ts`;
* `@/web/ui/FullscreenImage.vue`, `@/web/ui/ItemModifierText.vue`;
* `@/assets/data` (`STAT_BY_MATCH_STR`, plus `STATS_ITERATOR("AreaMods")` in settings);
* `@/parser/modifiers` (`statSourcesTotal`, `translateStatWithRoll`);
* `../price-check/filters/util` (`roundRoll`).

Settings for maps: `map-check/settings-maps.vue` (name `"map_check.name"`) with
`SettingsMatcherEntry.vue`, `UiToggle`, `VirtualScroll`. In `SettingsWindow.vue:345` it is in
the item-check widget menu `[SettingsItemcheck, SettingsMaps]`, and in the default menu group 3.

Options:
* **A (matches the brief):** drop map check. Make `isMapLike` always false (or delete the
  branch) so waystones, tablets and contracts show `ItemInfo`. `getPoe2dbPath` already handles
  waystones. Keep `maps` in the schema (ignored) so imported EE2 configs round-trip, or delete
  it. Remove `settings-maps.vue` from the settings menus. Drop the help tips `tip_15` and
  `tip_22`.
* **B:** keep map check. It is only six files with no host dependencies, but it brings the
  `VirtualScroll` settings page and mutable profile state.

### 1.10 Imports outside `item-check/` (dependencies to carry)

* `@/web/background/IPC` (`MainProcess`/`Host`: `onEvent`, `sendEvent`)
* `@/parser`: `parseClipboard`, `ParsedItem`, `ItemCategory`, `ItemRarity`, `itemIsModifiable`;
  `@/parser/meta`: `ARMOUR`, `ItemCategory`
* `@/web/Config` (`AppConfig()`, `AppConfig("item-check")`), which needs `language` and
  `samePricedType`
* `../overlay/Widget.vue`, `../overlay/interfaces` (`WidgetManager`: `show`, `size`,
  `poePanelWidth`). **Replace these in the port** with the host panel mechanism.
* `../map-check/MapCheck.vue` and `../map-check/common.js` (types), see 1.9
* `../settings/HotkeyInput.vue`, `../settings/utils.js` (`configProp`, `configModelValue`,
  `findWidget`)
* `vue-i18n` keys: `item.find_in_stash`, `item.physical_dps`, `item.elemental_dps`,
  `item.total_dps`, `item.open_on_wiki`, `item.open_on_poedb`, `item.find_same_price`,
  `item.price`, `item.price_and_item`, `item.info`

---

## 2. Stash search

### 2.1 Files

* `renderer/src/web/stash-search/WidgetStashSearch.vue` (176 lines): overlay widget, DROP as an
  overlay widget.
* `renderer/src/web/stash-search/stash-search-editor.vue` (90 lines): editor, KEEP.
* `renderer/src/web/stash-search/widget.ts` (12 lines): type, KEEP.

### 2.2 Config schema

```ts
interface StashSearchWidget extends Widget {   // wmType "stash-search", instances: "multi"
  anchor: Anchor;            // {pos, x, y} overlay placement (irrelevant in port; keep for compat)
  enableHotkeys: boolean;    // gate for ALL entry hotkeys of this instance
  entries: Array<{ id: number; name: string; text: string; hotkey: string | null }>;
}
// wmTitle = the group's title (e.g. "Map rolling"); trNameKey "stash_search.name"
```

Default instances (`WidgetStashSearch.vue:41-91`), created by `defaultConfig()` through the
registry (`Config.ts:210-228`):

1. `wmTitle:"Map rolling"`, `wmFlags:["invisible-on-blur"]`, `anchor:{pos:"tl",x:35,y:46}`,
   `enableHotkeys:true`, entries: `'"Increased Pack Size"'`, `'"Additional Packs"'`,
   `'"Burning Ground"'`, `'"Less Recovery Rate"'` (ids 1-4, name `""`, hotkey `null`).
2. `wmTitle:"Dump sorting"`, `anchor:{pos:"tl",x:34,y:56}`, `enableHotkeys:true`, entries:
   `Currency`, `'"Martial Weapon"'`, `Jewel`, `'"Waystone Tier"'`, `'"Rarity: Normal"'`,
   `Trials:` (ids 1-6).

The quotes are part of the text: the game's stash search treats `"…"` as an exact phrase.

Creating a group in EE2: widget menu "add widget…" popover → `wm.create("stash-search")`
(`OverlayWindow.vue:238-247`). This pushes
`{wmId:max+1, wmType, wmTitle:"", wmWants:"hide", wmZorder:null, wmFlags:["uninitialized"]}`.
On mount (`WidgetStashSearch.vue:112-129`) the widget sets
`wmFlags=["invisible-on-blur"]`, a random anchor between 20 and 40%, `enableHotkeys=true`,
`entries=[{id:1,text:"Currency",name:"",hotkey:null}]`, and shows itself.

Deleting a group: the widget's "delete" button (press and hold, `useRemovable`), then
`wm.remove`.

Upgrade: `Config.ts:506-510` runs `enableHotkeys ??= true` for every stash-search widget.

### 2.3 UI

**Overlay widget (DROPPED):**
* title (or "Untitled");
* a `UiToggle` bound to `config.enableHotkeys`, labelled `stash_search.enable_keys` ("Keys"),
  shown only if some entry has a hotkey. **Toggling calls `pushHostConfig()` immediately without
  saving** (142-147);
* one button per entry showing `entry.name || entry.text`, plus a hotkey badge when
  `entry.hotkey && enableHotkeys`. Click runs `stashSearch(entry.text)`.

In the port this click-to-search list can move to the Omarchy bar plugin (a popup per group). The
bar plugin can be a WS client sending `CLIENT->MAIN::user-action {action:"stash-search", text}`,
or call a backend CLI. The "Keys" toggle becomes a toggle in settings and/or the bar.

**Editor (`stash-search-editor.vue`, KEEP):**
* Props: `configProp<StashSearchWidget>()`, i.e. `{config, configWidget}`. It edits
  **`configWidget`**, the selected instance in the settings clone.
* `title` input bound to `wmTitle` (placeholder `widget.title`).
* `vuedraggable` (`DndContainer`, `item-key="id"`, `handle="[data-qa=drag-handle]"`,
  `animation=200`, `force-fallback`) to reorder `entries`.
* Each row is a 4-column grid: drag handle, a `text` input (placeholder
  `stash_search.search_text` "search text or regex", **red background when
  `text.length > 250`** as a visual warning only), a remove button (filters by id), a `name`
  input (placeholder `stash_search.friendly_name`), and a `HotkeyInput v-model=entry.hotkey`.
* "Add" button pushes `{id: max(0,...ids)+1, text:"", name:"", hotkey:null}`.
* **In EE2 the editor is reachable only from the widget's "edit" button.** `Widget.vue:317-332`
  sets the flag `settings::widget=<wmId>` and shows Settings, and `menuByType("stash-search")`
  is `[[SettingsStashSearch]]`. It is **not** in the default settings menu
  (`SettingsWindow.vue:352-359`).

**Port: new settings tab "Stash search".** List every `config.widgets` entry with
`wmType==="stash-search"`. For each: the title, the `enableHotkeys` toggle, and the existing
`stash-search-editor` with `configWidget=thatInstance`. Add buttons for "Add group" (push a new
instance with the defaults from `WidgetStashSearch.vue:112-128`: `wmId = max+1`, `wmTitle:""`,
`wmFlags:["invisible-on-blur"]`, `wmZorder:null`, `wmWants:"hide"`, `enableHotkeys:true`, one
`Currency` entry) and "Delete group".

### 2.4 Hotkey registration

`Config.ts:780-792`. For each stash-search widget with `enableHotkeys`, every entry with a
`hotkey` becomes `{shortcut: entry.hotkey, action:{type:"stash-search", text: entry.text}}`
without `keepModKeys`. Entries with an empty `text` are still registered; skip them in the port.

### 2.5 Host action messages

| Origin | Message |
|---|---|
| Hotkey (main) | `ShortcutAction.action = {type:"stash-search", text}` (`ipc/types.ts:35-38`), handled at `Shortcuts.ts:213-214` |
| Renderer (widget button, ItemInfo "Find in Stash", `$`, `search-similar`/`search-same-priced` hotkeys) | WS `{"name":"CLIENT->MAIN::user-action","payload":{"action":"stash-search","text":"…"}}` (`ipc/types.ts:217-226`), handled at `Shortcuts.ts:73-77` |

### 2.6 Main-side typing sequence (exact, `main/src/shortcuts/text-box.ts:57-72`)

```
stashSearch(text):
  clipboard.restoreShortly(cb)              // HostClipboard.ts:87-103
    if !isRestored: return                   // THROTTLE: drop the whole action if another typing action ran < 120 ms ago
    isRestored = false
    saved = clipboard.readText()
    cb():
      overlay.assertGameActive()             // give focus back to the game if the overlay was interactive
      clipboard.writeText(text)
      keyTap(F, [Ctrl])                      // open/focus stash search box (game selects existing text)
      keyTap(V, [Ctrl])                      // Meta on macOS
      keyTap(Enter)
    setTimeout(120 ms):                      // RESTORE_AFTER, HostClipboard.ts:11
      if restoreClipboard: clipboard.writeText(saved)
      isRestored = true
```

Before calling `stashSearch`, the shortcut handler releases every key of the triggering hotkey
with synthetic key-up events in reverse order (`Shortcuts.ts:195-201`), so a physically held
modifier does not combine with the injected keys.

### 2.7 Port mapping (Hyprland)

The game is raw XWayland (class `steam_app_2694490`, see `~/Developer/poe_price_checker/SETUP.md`).
That project confirmed that `hyprctl dispatch sendshortcut "CTRL, C, class:^steam_app_2694490$"`
reaches the game. **Pasting (Wayland selection written by `wl-copy`, then read by the XWayland
game on Ctrl+V) has NOT been validated.** Validate it before building on it.

Suggested backend sequence:

1. Throttle the same way (a single "typing busy" flag; drop the action if busy).
2. `saved = wl-paste --no-newline --type text/plain`. A non-zero exit means "Nothing is copied";
   treat it as empty.
3. `wl-copy --type text/plain -- "<text>"`. Do not use `--paste-once`, because the XWayland
   bridge may read the selection more than once.
4. Send to the game window:
   `sendshortcut CTRL, F, <win>`, then `sendshortcut CTRL, V, <win>`, then
   `sendshortcut , Return, <win>`.
   `<win>` is `address:0x…` taken from `hyprctl clients -j` or `activewindow -j`, or
   `class:^steam_app_2694490$`.
   * Send them in one `hyprctl --batch "dispatch sendshortcut CTRL, F, …; dispatch …"` call, or
     through the Hyprland socket directly, to avoid three process spawns.
   * Omarchy's own config notes that `send_shortcut` **can leave synthetic key state stuck or
     repeating** and works around it with `send_key_state` down, then up 50 ms later
     (`/usr/share/omarchy/default/hypr/bindings/clipboard.lua`). Consider the same down/up
     pattern with ~20-50 ms gaps. The game may also drop events that arrive too fast; the user's
     ydotool experiment used a 25 ms key delay.
5. Restore the clipboard if `restoreClipboard`. **120 ms is probably too short** for
   wl-copy → XWayland → Wine reading the clipboard after `Ctrl+V`. Make it configurable and
   start at about 300-500 ms. The EE2 comment at `HostClipboard.ts:7-11` warns that restoring too
   early pastes the old clipboard, which could be a password.
6. If the X11 CLIPBOARD does not follow `wl-copy` reliably (Hyprland's XWM sync between X11 and
   Wayland was shown to be focus-gated in the X11→Wayland direction; see the omarchy_2 branch's
   `LINUX_OVERLAY_REPORT.md` "Root causes" #2), fall back to also writing X11 with
   `DISPLAY=:0 xclip -selection clipboard`. That requires `xclip`.

Reserved and duplicate rules apply too (section 4).

---

## 3. Chat commands

### 3.1 Config

`Config.commands: Array<{ text: string; hotkey: string | null; send: boolean }>`
(`Config.ts:135-139`). Defaults (`Config.ts:168-199`):

| text | hotkey | send |
|---|---|---|
| `/hideout` | `F5` | true |
| `/exit` | `F9` | true |
| `@last ty` | null | true |
| `/invite @last` | null | true |
| `/tradewith @last` | null | true |
| `/hideout @last` | null | true |

Migration v5 (`Config.ts:282-288`) set `send = true` on all existing commands. The user's current
EE2 config (`~/.config/exiled-exchange-2/apt-data/config.json`, configVersion 34) has exactly
these defaults.

### 3.2 Settings UI (`renderer/src/web/settings/chat.vue`, name `"settings.chat"`, label "Chat")

* For each `config.commands[idx]`:
  * `<input v-model.trim="command.text">`, full width, `font-poe`. `.trim` strips surrounding
    whitespace, which matters for `@last` handling.
  * `UiToggle v-model="command.send"` labelled `settings.chat_cmd_send` ("press Enter").
  * "Remove" button, which does `commands.splice(idx,1)`.
  * `HotkeyInput v-model="command.hotkey"` (w-48).
* Button `settings.chat_cmd_add` ("Add command") pushes `{text:"", hotkey:null, send:true}`
  (lines 50-56).
* It edits `props.config.commands`, which is the clone.

### 3.3 Registration

`Config.ts:768-779`: each command with a truthy `hotkey` becomes
`{shortcut: hotkey, action:{type:"paste-in-chat", text, send}}` without `keepModKeys`. Commands
with an empty `text` and a hotkey are registered and type nothing useful; the port should skip
them. Commands without a hotkey are **unusable in EE2** (there is no UI to trigger them). The bar
plugin could offer them as click actions.

### 3.4 Exact typing algorithm (`text-box.ts:16-55`)

`modifiers = [Ctrl]` (Meta on macOS). The whole function runs under the same
`restoreShortly` throttle and clipboard restore as stash search (2.6), and the hotkey's keys are
released first.

```
PLACEHOLDER_LAST = "@last"
AUTO_CLEAR = ["#", "%", "@", "$", "&", "/"]      // channel/command prefixes

if text.startsWith("@last"):                      // e.g. "@last ty"
    text = text.slice("@last ".length)            // removes 6 chars ("@last" + one char, assumed space) -> "ty"
    clipboard = text
    tap Ctrl+Enter                                // game: open chat pre-filled "@<last whisperer> "
elif text.endsWith("@last"):                      // e.g. "/invite @last"
    text = text.slice(0, -5)                      // -> "/invite " (keeps trailing space)
    clipboard = text
    tap Ctrl+Enter                                // chat = "@name "
    tap Home; tap Home                            // twice: "press twice to focus input when using controller"
    tap Delete                                    // remove "@"  -> "name ", cursor at start
else:                                             // e.g. "/hideout"
    clipboard = text
    tap Enter                                     // open chat
    if text[0] not in AUTO_CLEAR: tap Ctrl+A      // select existing draft so paste replaces it
tap Ctrl+V                                        // paste (cursor at end, or at start in the endsWith case -> "/invite name ")
if send:
    tap Enter                                     // send
    tap Enter                                     // re-open chat
    tap ArrowUp; tap ArrowUp                      // "restore the last chat" (history navigation)
    tap Escape                                    // close chat
# send == false: chat stays open with the pasted text for the user to edit/confirm
```

Resulting chat lines with the defaults:
* `@last ty` gives `@<name> ty`
* `/invite @last` gives `/invite <name> `
* `/tradewith @last` gives `/tradewith <name> `
* `/hideout @last` gives `/hideout <name> `
* `/hideout` gives `/hideout`
* `/exit` gives `/exit`

### 3.5 `@last` and client log

`@last` uses **only** the game's Ctrl+Enter "reply to last whisper" feature. The client-log
parser does **not** track whispers: `renderer/src/web/client-log/client-log-parser.ts:211-212`
contains `else if (text[0] === "@") { // some whisper }`, a no-op. `useClientLog` is used only by
`overlay/OverlayWindow.vue:92` (`MAIN->CLIENT::game-log` lines) and
`leveling/WidgetXpTracker.vue`. **Item check, stash search and chat commands do not need
client-log.** Drop `client-log/`, `GameLogWatcher`, `readClientLog`, `clientLog`, and the
`MAIN->CLIENT::game-log` / `CLIENT->MAIN::re-parse-log` / `write-data:client-log-event` messages.

### 3.6 Port mapping (Hyprland keys for `sendshortcut`, target = game window)

| EE2 tap | Hyprland `sendshortcut` args |
|---|---|
| Ctrl+Enter | `CTRL, Return, <win>` |
| Enter | `, Return, <win>` |
| Home | `, Home, <win>` |
| Delete | `, Delete, <win>` |
| Ctrl+A | `CTRL, A, <win>` |
| Ctrl+V | `CTRL, V, <win>` |
| ArrowUp | `, Up, <win>` |
| Escape | `, Escape, <win>` |
| Ctrl+F | `CTRL, F, <win>` |
| item copy | `CTRL ALT, C, <win>` (from `mergeTwoHotkeys("Ctrl + C", showModsKey)`) |

Order and timing matter: the game must open the chat box before the paste arrives. Put small
delays (around 20-40 ms) between taps, and test `send:true` with the five-key tail.

### 3.7 Edge cases to preserve or fix

* `"@last"` alone: the `startsWith` branch runs, `slice(6)` gives `""`, so Ctrl+Enter then paste
  of an empty string.
* `"@lastfoo"`: `slice(6)` gives `"oo"`. This is an existing bug, because the code assumes a
  space after `@last`.
* `@last` in the middle (`"/kick @last now"`): neither branch matches, so the literal text
  `@last` is typed.
* `send:false` with `@last`: the chat is left open with the name filled in.
* The `.trim` in chat.vue means a stored `"/invite @last"` never has trailing spaces.
* The throttle drops a second macro pressed within 120 ms. Pressing F5 twice quickly sends one
  `/hideout`.

---

## 4. Shortcut registration semantics the port must replicate (`Shortcuts.ts:110-176`)

* `updateActions(actions, stashScroll, logKeys, restoreClipboard, language)` is called on every
  `CLIENT->MAIN::update-host-config` (`main/src/main.ts:104-126`).
* **Reserved shortcuts are never registered**, and an error is logged (lines 133-158):
  `Ctrl + C`, `Ctrl + V`, `Ctrl + A`, `Ctrl + F`, `Ctrl + Enter`, `Home`, `Delete`, `Enter`,
  `ArrowUp`, `ArrowRight`, `ArrowLeft`, plus the copy chord (`Ctrl + Alt + C` by default).
  Log text: `error [Shortcuts] Hotkey "<s>" reserved by the game will not be registered.`
* **Duplicates** (lines 160-175): if two actions share a shortcut, **all** actions with that
  shortcut are dropped, except `toggle-overlay`. Log text:
  `error [Shortcuts] It is not possible to use the same hotkey "<s>" for multiple actions.`
* `test-only`: registers and immediately unregisters the copy chord, to probe for conflicts.
  DROP.
* Registration happens only while the game window is active (`poeWindow.on("active-change")`,
  lines 61-71). `unregister()` removes everything. This is equivalent to the planned Hyprland
  focus-gated binds.
* On fire (lines 182-201): if `logKeys`, log `debug [Shortcuts] Action type: <type>`. Then
  release keys: with `keepModKeys`, only the non-mod key is released; otherwise all keys are
  released in reverse order. With Hyprland, binds fire on key press and the physical modifiers
  stay down. `sendshortcut` sends explicit modifiers, which avoids the "held Ctrl merges into the
  injected chord" problem. Omarchy uses it for exactly that reason. Consider `release=true` binds
  for macros if problems appear.
* Electron `globalShortcut` fires on **keydown**. Hyprland `bind` also fires on press by default.
* **Stash scroll** (lines 93-103): when `stashScroll` is set, Ctrl+wheel while the game is
  active and the cursor is **outside** `isStashArea` taps ArrowRight (rotation > 0) or
  ArrowLeft (rotation < 0). `isStashArea` (326-337) is `x <= bounds.x + uiSidebarWidth` and
  `y` between 154/1600 and 1192/1600 of the window height. This is classified DROP for v1. If it
  is wanted later, it needs Hyprland `CTRL, mouse_down/mouse_up` binds (non-consuming) plus a
  cursor/geometry check.

---

## 5. Settings window

### 5.1 Files and components (all of `renderer/src/web/settings/`)

| File | Role | Port |
|---|---|---|
| `SettingsWindow.vue` (541 lines) | Shell: widget spec, patrons strip/podium, title bar, left menu, content, Save/Cancel, Quit | KEEP, but rework into a standalone page (5.8) |
| `HotkeyInput.vue` (68 lines) | Key-capture input | KEEP (5.7) |
| `HotkeysGeneric.vue` (32 lines) | Renders a list of `HotkeySchema` items or groups | KEEP |
| `SettingsHotkey.vue` (100 lines) | One hotkey row; either a single `HotkeyInput` or the split "Ctrl/Alt + key" UI used by price-check `hotkeyHold`+`hotkey` | KEEP |
| `hotkeys.vue` (99 lines) | Tab "Hotkeys" | KEEP, trimmed (5.6) |
| `chat.vue` (63 lines) | Tab "Chat" | KEEP as-is |
| `general.vue` (238 lines) | Tab "General" | KEEP, trimmed |
| `help.vue` (102 lines) | Tab "Help": tips frequency and a tip carousel | optional KEEP (tips appear in price check) |
| `debug.vue` (33 lines) | Tab "Debug": `logKeys` checkbox and the `Host.logs` pane | KEEP the logs pane, DROP the checkbox |
| `about.vue` (154 lines) | Tab "About": version, links, updater state | KEEP, trimmed and rebranded |
| `utils.ts` (60 lines) | `configProp`, `configModelValue`, `_configModelValue`, `findWidget`, `disableWidget`, `enableWidget` | KEEP (drop `disable/enableWidget` if unused) |

Tab components that live outside `settings/`:
* `price-check/settings-price-check.vue`: KEEP (owned by the price-check notes).
* `item-check/settings-item-check.vue`: KEEP.
* `map-check/settings-maps.vue`: DROP under option 1.9-A.
* `stash-search/stash-search-editor.vue`: KEEP, inside the new tab.
* `stopwatch/settings-stopwatch.vue`, `item-search/settings-item-search.vue`,
  `leveling/settings-leveling.vue`, `library/settings-library.vue`: DROP.

### 5.2 Menu structure (`SettingsWindow.vue:338-361`)

`menuByType(type)`:
* `stash-search` → `[[SettingsStashSearch]]`
* `timer` → `[[SettingsStopwatch]]`
* `item-check` → `[[SettingsItemcheck, SettingsMaps]]`
* `price-check` → `[[SettingsPricecheck]]`
* `item-search` → `[[SettingsItemSearch]]`
* `library` → `[[SettingsLibrary]]`
* default:

```
[SettingsHotkeys "Hotkeys", SettingsChat "Chat"]
---
[SettingsGeneral "General"]
---
[SettingsPricecheck "Price check", SettingsMaps "Map check", SettingsItemcheck "Item info"]
---
[SettingsLeveling "Leveling"]
---
[SettingsHelp "Help", SettingsDebug "Debug", SettingsAbout "About"]
```

Labels come from `t(component.name)`. The menu is flattened with separators (`flatJoin`,
363-370). The **Quit** button appears when `menuItems.length >= 4`, which in practice means the
default (non-widget) menu. It sends `CLIENT->MAIN::user-action {action:"quit"}`, and
`main/src/AppTray.ts:29-33` calls `app.quit()`.

Proposed port menu:

```
[Hotkeys, Chat, Stash search(NEW)]
---
[General]
---
[Price check, Item info]
---
[Help?, Debug, About]
+ Quit
```

Quit should stop the backend and the host. The bar plugin also offers it.

### 5.3 Open/close lifecycle in EE2 (exact)

* **Widget spec** (`SettingsWindow.vue:167-181`): `type:"settings"`, single instance,
  `wmTitle:"{icon=fa-cog}"`, `wmZorder:"exclusive"`,
  `wmFlags:["invisible-on-blur","ignore-ui-visibility"]`. On setup it forces
  `wmWants="hide"` on the next tick (193-195).
* **Ways to open it:**
  1. The overlay hotkey (`overlayKey`, default `Shift + Space`) makes the overlay interactive.
     The widget menu (`overlay/WidgetMenu.vue`) shows a cog button (from `wmTitle`
     `{icon=fa-cog}`). `toggle()` then calls `wm.show(settingsId)`.
  2. Any widget's "edit" button when `inline-edit=false` (`overlay/Widget.vue:317-332`). It runs
     `wm.setFlag(settingsId, "settings::widget=<wmId>", true)` and `wm.show(settingsId)`.
  3. The price-check league link `openLeagueSelection` (`price-check/PriceCheckWindow.vue:22`,
     `407-411`). Same flag mechanism, so it opens the price-check-only menu.
  4. The tray "Settings/League" item only shows a dialog: *Open Path of Exile 2 and press
     "<overlayKey>". Click on the button with cog icon there.* (`main/src/AppTray.ts:38-46`).
* **Per-widget mode** (227-242): a deep watcher on `wmFlags` looks for `settings::widget=<id>`.
  It sets `selectedWmId` and `selectedComponent = menuByType(widget.wmType)[0][0]`, then clears
  the flag. `configWidget` is that widget **inside the clone** (223-225) and is passed as the
  `configWidget` prop.
* **On show** (203-220, watching `wmWants`):
  `configClone = reactive(JSON.parse(JSON.stringify(AppConfig())))`, and the patrons are
  shuffled.
* **On hide**: `configClone=null`; `selectedWmId` and `selectedComponent` reset to Hotkeys; the
  podium is hidden.
* **Save** (299-305): `updateConfig(clone)` replaces the whole live config and sets
  `document.documentElement.style.fontSize`. Then `saveConfig()`, `pushHostConfig()` and
  `wm.hide`.
  * **Quirk:** `saveConfig()` (`Config.ts:30-50`) returns early if any widget has
    `wmZorder==="exclusive" && wmWants==="show"`. The clone was taken while Settings itself was
    `show`, so **the save is skipped**. The data reaches disk later through
    `window.addEventListener("blur", … saveConfig())` (`OverlayWindow.vue:115-119`) when focus
    returns to the game, or when another exclusive widget closes
    (`OverlayWindow.vue:312-326`). Hotkeys apply immediately through `pushHostConfig`.
* **Cancel / title-bar close** (`AppTitleBar @close`): `wm.hide` only, so edits are discarded.
* **External config change**: `MAIN->CLIENT::config-changed` while Settings is the
  topmost/exclusive widget hides Settings (`OverlayWindow.vue:126-131`), discarding the edits.
  `ConfigStore` broadcasts `config-changed` to **all** clients after every `save-config`
  (`main/src/host-files/ConfigStore.ts:15-21`).
* **Visibility**: `invisible-on-blur` hides the settings UI while the overlay is not active, but
  `wmWants` stays `show`. `OverlayWindow.vue:35-49` then shows "Press {overlayKey} to continue
  editing" (`reopen_settings`).
* **Live mutations that bypass the clone**: `general.vue` writes `AppConfig().language`
  (174) and `AppConfig().preferredTradeSite` (210) **immediately**. This makes `main.ts:13-19`
  reload the data and i18n right away, and **Cancel does not revert it**. The next blur-save
  then persists it.
* **Decoration**: patrons strip and podium (`APP_PATRONS`, 1-34, 199-220, 315-333, CSS 421-540):
  DROP. Window CSS `.window`: absolute, centred, `max-width:50rem; max-height:38rem`, `rounded-b`,
  `slideInDown` 1s animation (374-391).

### 5.4 Setting-by-setting classification

Top-level `Config` (`Config.ts:127-157`, defaults 159-233):

| Key | Default | UI location | Decision | Notes |
|---|---|---|---|---|
| `configVersion` | 35 | none | KEEP | Run `upgradeConfig()` and then **filter `widgets` to the registered types** when importing EE2 configs. |
| `leagueId` | undefined | Price check tab | KEEP | |
| `overlayKey` | `"Shift + Space"` | Hotkeys tab "Overlay" (`required`) | DROP or REPURPOSE | There is no fullscreen overlay. Could become "hide all panels" or "focus panel keyboard"; open question. Remove `required`. |
| `overlayBackground` | `"rgba(129, 139, 149, 0.15)"` | General | DROP | fullscreen overlay only |
| `overlayBackgroundClose` | true | General | DROP | |
| `overlayAlwaysClose` | false | General | DROP | |
| `hideOverlayOnBlur` | false | General | DROP | |
| `showAttachNotification` | true | General | DROP | or REPURPOSE as a "game detected" notify-send |
| `restoreClipboard` | false | General "Restore clipboard" | KEEP | applies to item copy, stash search and chat |
| `commands[]` | 6 defaults | Chat tab | KEEP | |
| `clientLog` | null | General "PoE log file" and Leveling | DROP | client log is not needed |
| `gameConfig` | null | General "PoE config file" | KEEP | Read `ACTION_KEYS.show_advanced_item_descriptions` to build the copy chord (`main/src/host-files/GameConfig.ts:87-89`). Auto-guess paths include the Proton prefix `~/.local/share/Steam/steamapps/compatdata/2694490/pfx/drive_c/users/steamuser/Documents/My Games/Path of Exile 2/poe2_production_Config.ini` (`GameConfig.ts:18-28`). Update the placeholder text. |
| `windowTitle` | `"Path of Exile 2"` | General "PoE window title" (Restart required) | REPURPOSE | Use it as the Hyprland window match (title), or replace it with a class match `steam_app_2694490`. |
| `logKeys` | false | Debug "Record all key presses" | DROP | relies on uiohook; at most, repurpose to "log hotkey actions" |
| `accountName` | `""` | Price check tab | KEEP | |
| `stashScroll` | true | Hotkeys "Stash tab scrolling" | DROP (v1) | see section 4 |
| `language` | `"en"` | General | KEEP | options `en, ru, cmn-Hant, ko, ja, de, es, pt, fr`. Setting a language other than cmn-Hant forces `realm="pc-ggg"`. |
| `preferredTradeSite` | `"default"` | General (only when language ≠ en) | KEEP | options `default` (label = localized host from `tradeUrl`) and `www` |
| `realm` | `"pc-ggg"` | General (only when language = cmn-Hant) | KEEP | `pc-ggg` "International" / `pc-garena` "Hotcool" |
| `fontSize` | 16 | General "Font size" (`v-model.number`, px) | KEEP | Applied as root font-size in `updateConfig`. **The host must re-measure panel surfaces** when it changes. |
| `widgets[]` | registry | n/a | KEEP subset | only the registered port widgets |
| `enableAlphas` | false | General | DROP | |
| `alphas[]` | [] | General `libraryAlpha` | DROP | |
| `tipsFrequency` | 3 (Normal) | Help tab | KEEP if price-check tips stay | `TipsFrequency` 1 Always … 6 Never (`Config.ts:118-125`). `TIP_FREQUENCY_MAP` (`help/tips.ts`): 1, 7, 20, 50, 100, -1. |
| `readClientLog` | false | General and Leveling | DROP | |

Widget-level settings:

| Widget.key | UI | Decision |
|---|---|---|
| `price-check.hotkey` + `hotkeyHold` | Hotkeys (split Ctrl/Alt + key) | KEEP. Hold-mode release detection is a price-check concern. |
| `price-check.hotkeyLocked` | Hotkeys | KEEP |
| other `price-check.*` (`showSeller`, `searchStatRange`, `coreCurrency`, `rememberCurrency`, `rememberListingType`, `activateStockFilter`, `currencyVolume`, `requestPricePrediction`, `showCursor`, `itemHoverTooltip`, `defaultAllSelected`, `alwaysShowTier`, `collapseListings`, `smartInitialSearch`, `lockedInitialSearch`, `apiLatencySeconds`, `initialDelay`) | Price check tab | KEEP (see price-check notes). `builtinBrowser` (Electron `<webview>`/iframe) is likely DROP. `showCursor` draws a circle at the cursor position inside a fullscreen overlay, so it is likely DROP or a no-op in a panel-sized surface. |
| `item-check.hotkey` | Hotkeys ("Map check" **and** "Item info" rows, same key) | KEEP (one row). Default `"Alt + D"` in the port. |
| `item-check.wikiKey/poedbKey/craftOfExileKey/stashSearchKey/samePricedKey/samePricedType` | Item info tab | KEEP |
| `item-check.maps.*` | Map check tab and MapCheck panel | DROP (option A) or KEEP (option B) |
| `stash-search[*].wmTitle/enableHotkeys/entries` | new Stash search tab | KEEP |
| `delve-grid.toggleKey` | Hotkeys "Grid for Delve Chart" | DROP |
| `timer.*`, `item-search.ocrGemsKey`, `experience-tracker.showExp`, `library.*` | their own tabs | DROP |
| `menu.alwaysShow` | widget menu | DROP |

### 5.5 Settings components that reference dropped widgets, and how to trim them

* `SettingsWindow.vue`:
  * remove imports `SettingsMaps` (139), `SettingsStopwatch` (141), `SettingsItemSearch` (142),
    `SettingsLeveling` (143), `SettingsLibrary` (144), and `APP_PATRONS` (123);
  * remove the `readClientLog` → `experience-tracker` watcher (244-262) and the alphas/library
    watcher (264-279);
  * remove the `timer`, `item-search` and `library` cases from `menuByType`, and `SettingsMaps`
    from the item-check and default groups;
  * add the "Stash search" tab;
  * remove `inject("wm")` (see 5.8).
* `hotkeys.vue`:
  * the **`delve-grid` row (55-58, 89-92) will throw** once the widget no longer exists:
    `findWidget(...)!` returns undefined, and `_configModelValue(undefined, "toggleKey").value`
    throws. Remove it;
  * remove the duplicate `map_check.name` row (81-84);
  * remove or repurpose the `settings.overlay` row (76-80, `required:true`);
  * remove the `stashScroll` radio (9-19, 96);
  * `PriceCheckWidget`/`DelveGridWidget` type imports (38): drop `DelveGridWidget`.
* `general.vue`:
  * remove `clientLog` (48-55), `overlayBackground`/`overlayBackgroundClose` (64-82),
    `showAttachNotification` (83-85), `overlayAlwaysClose` (86-88), `hideOverlayOnBlur` + hint
    (89-94), `readClientLog` + explain (107-112), and the `enableAlphas`/`libraryAlpha` block
    (113-120). Also remove the **`libraryAlpha` watcher with `immediate:true` (138-153), which
    mutates `config.alphas` on mount**;
  * keep language, trade site, realm, font size, restore clipboard, `gameConfig`, and
    `windowTitle` (repurposed).
* `debug.vue`: drop the `logKeys` checkbox and keep the `<pre>{{ Host.logs }}</pre>`
  (`MAIN->CLIENT::log-entry`; on connect the backend sends the full history,
  `main/src/server.ts:113-116`).
* `about.vue`:
  * drop the updater box (`Host.updateInfo`, the `check-for-update` / `update-and-restart`
    user-actions, 22-30 and 68-145) and `luxon`;
  * rebrand the name, the icon `/images/jeweler.png`, the GitHub links (8-19) and the Discord
    contact (31-58);
  * keep `Host.version` (from `GET /config` → `HostState.version`).
* `help.vue` / `help/tips.ts` / `help/Tip.vue`: `TIP_COUNT = 29`, and `randomTip()` picks
  `1..29`, each mapped to `tips.tip_<n>` i18n. Tips about dropped features: `tip_1` (cheat-sheet
  image strip), `tip_15` and `tip_22` (map check), `tip_19` (stopwatch), `tip_21` (stash search
  *widget*), `tip_23` (stash scrolling). `tip_27` (Debug tab) is fine. Replace `TIP_COUNT` with
  an explicit allow-list, e.g. `TIPS = [2,3,4,…]`. Also used by
  `price-check/CheckedItem.vue:85,94,290-320`.
* `price-check/settings-price-check.vue`: `builtinBrowser` row (171-177), owned by the
  price-check notes.
* `Config.ts` `getConfigForHost()` (692-843): **crashes if `library` or `delve-grid` are
  missing**: `library.logItemKey` at 752 and `library.libraryOutputPath` at 839, and
  `delveGrid.toggleKey` at 761. Also drop `timer`/`item-search` loops, `toggle-overlay`,
  `libraryAlpha`, `readClientLog`, `clientLog`, `hideOverlayOnBlur`, `logKeys`, `stashScroll`.
  Better still, compute the host bindings in the Bun backend from the saved JSON (single source
  of truth) and stop relying on the renderer's `update-host-config`.
* `Config.ts` `upgradeConfig()`: the migrations for versions < 30 reference `image-strip`,
  `delve-grid`, `menu`, `item-search`, `experience-tracker`, `library` with non-null assertions.
  They are harmless for v34/v35 configs; the user's config is v34, so only the `<35` step runs
  (`savedAugments`, `hideOverlayOnBlur`). Keep the code but filter unknown widget types after
  the upgrade.

### 5.6 Hotkeys tab contents (EE2 → port)

`hotkeys.vue:46-94` builds:
1. Group `price_check.name`:
   * `price_check.hotkey`, split UI: mod `hotkeyHold` (`Ctrl`/`Alt` buttons) + key `hotkey`
     (`no-mod-keys`);
   * `price_check.hotkey_locked`: `hotkeyLocked`.
2. `settings.overlay`: `config.overlayKey` (required). Port: drop or repurpose.
3. `map_check.name`: `itemCheckWidget.hotkey`. Port: drop (duplicate).
4. `item.info`: `itemCheckWidget.hotkey`. Port: keep, perhaps relabelled "Item check".
5. `settings.delve_grid`: `delveGridWidget.toggleKey`. Port: drop.

Then the info banner `settings.clear_hotkey` ("You can clear hotkey by pressing Backspace") and
the stash scroll radio (drop).

### 5.7 HotkeyInput: key capture and string format

`HotkeyInput.vue`:
* `<input @keyup="handleKeyup" @keydown.prevent>`. The placeholder is the current value or
  `settings.no_key` ("Not Set", red when unset). The input never holds typed text.
* Props: `modelValue: string|null`, `noModKeys: boolean`, `required: boolean`.
* `handleKeyup(e)` (37-64):
  1. `preventDefault`, `stopPropagation`.
  2. If `e.code === "Backspace"` and not `required`, emit `null` (clear). Return either way, so
     **Backspace can never be bound**.
  3. Take `code = e.code` and the modifiers `e.ctrlKey`, `e.shiftKey`, `e.altKey` **at keyup**:
     the user must release the main key while still holding the modifiers. **`metaKey` (Super)
     is ignored**: Super+K records `"K"`. The port should reject events with `metaKey`.
  4. Normalize: `"KeyX"` becomes `"X"`, `"DigitN"` becomes `"N"`. If `e.key === "Cancel"` and
     `code === "Pause"`, use `"Cancel"`. That value is then rejected, because `Cancel` is
     commented out in `KeyToCode`, so Ctrl+Break cannot be bound.
  5. Accept only if `KeyToCode[code]` is truthy (`ipc/KeyToCode.ts:1-109`). Modifier-only
     presses produce `ShiftLeft` / `ControlLeft` / `AltLeft`, which are not in the table, so
     they are ignored.
  6. `str = hotkeyToString([code], ctrl, shift, alt)` (`KeyToCode.ts:227-245`). The modifier
     prefix is one of these, chosen by precedence:
     `Ctrl + Shift + Alt`, `Shift + Alt`, `Ctrl + Shift`, `Ctrl + Alt`, `Alt`, `Ctrl`, `Shift`.
     It is joined to the key with `" + "` (space, plus, space). Examples: `"F5"`,
     `"Ctrl + Alt + D"`, `"Shift + Space"`, `"Alt + 1"`, `"Ctrl + Shift + Alt + Numpad5"`.
  7. If `str` contains `"F12"`, ignore it.
  8. If `noModKeys` and `str` contains `"+"`, ignore it.
  9. Otherwise `emit("update:modelValue", str)`.

Accepted key names (the `KeyToCode` keys, `e.code` after normalization):
* `Tab`, `Enter`, `CapsLock`, `Escape`, `Space`, `PageUp`, `PageDown`, `End`, `Home`,
  `ArrowLeft`, `ArrowUp`, `ArrowRight`, `ArrowDown`, `Insert`, `Delete`;
* `0`-`9`, `A`-`Z`;
* `Numpad0`-`Numpad9`, `NumpadMultiply`, `NumpadAdd`, `NumpadSubtract`, `NumpadDecimal`,
  `NumpadDivide`;
* `F1`-`F24` (F12 rejected);
* `Semicolon`, `Equal`, `Comma`, `Minus`, `Period`, `Slash`, `Backquote`, `BracketLeft`,
  `Backslash`, `BracketRight`, `Quote`.

`Shift`, `Ctrl` and `Alt` also appear in the table but never as an `e.code`.

Not capturable: `NumpadEnter`, `IntlBackslash`, `ContextMenu`, `PrintScreen`, `ScrollLock`,
`Pause`, `NumLock`, and Meta/Super.

The split mod-key UI (`SettingsHotkey.vue:13-40`, used only for price check) gives `hotkeyHold`
∈ {`"Ctrl"`, `"Alt"`}. The registered shortcut is `` `${hotkeyHold} + ${hotkey}` ``
(`Config.ts:697-703`, `keepModKeys:true`).

**Conversion to Hyprland.** Split on `" + "`. The modifiers `Ctrl`, `Shift`, `Alt` become `CTRL`,
`SHIFT`, `ALT`. That gives the legacy `bind = CTRL ALT, <key>, …` or the 0.56 Lua form
`hl.bind("CTRL + ALT + <KEY>", dispatcher, opts)`; this system uses the Lua config
(`~/.config/hypr/hyprland.lua`, `hl.bind` returns an `HL.Keybind` with
`set_enabled`/`remove`). For the key, the most faithful choice is the physical key, because
`e.code` is layout-independent. Use `code:<xkb keycode>`, where xkb = evdev + 8. Keysym names
work for US-like layouts.

| EE2 key | evdev | `code:` (xkb) | keysym |
|---|---|---|---|
| Escape | 1 | code:9 | Escape |
| 1..9 | 2..10 | code:10..18 | 1..9 |
| 0 | 11 | code:19 | 0 |
| Minus | 12 | code:20 | minus |
| Equal | 13 | code:21 | equal |
| Tab | 15 | code:23 | Tab |
| Q W E R T Y U I O P | 16..25 | code:24..33 | q..p |
| BracketLeft | 26 | code:34 | bracketleft |
| BracketRight | 27 | code:35 | bracketright |
| Enter | 28 | code:36 | Return |
| A S D F G H J K L | 30..38 | code:38..46 | a..l |
| Semicolon | 39 | code:47 | semicolon |
| Quote | 40 | code:48 | apostrophe |
| Backquote | 41 | code:49 | grave |
| Backslash | 43 | code:51 | backslash |
| Z X C V B N M | 44..50 | code:52..58 | z..m |
| Comma | 51 | code:59 | comma |
| Period | 52 | code:60 | period |
| Slash | 53 | code:61 | slash |
| NumpadMultiply | 55 | code:63 | KP_Multiply |
| Space | 57 | code:65 | space |
| CapsLock | 58 | code:66 | Caps_Lock |
| F1..F10 | 59..68 | code:67..76 | F1..F10 |
| Numpad7 8 9 | 71 72 73 | code:79 80 81 | KP_7 KP_8 KP_9 (NumLock on; otherwise KP_Home etc., so prefer code:) |
| NumpadSubtract | 74 | code:82 | KP_Subtract |
| Numpad4 5 6 | 75 76 77 | code:83 84 85 | KP_4 KP_5 KP_6 |
| NumpadAdd | 78 | code:86 | KP_Add |
| Numpad1 2 3 | 79 80 81 | code:87 88 89 | KP_1 KP_2 KP_3 |
| Numpad0 | 82 | code:90 | KP_0 |
| NumpadDecimal | 83 | code:91 | KP_Decimal |
| F11 F12 | 87 88 | code:95 96 | F11 F12 |
| NumpadDivide | 98 | code:106 | KP_Divide |
| Home | 102 | code:110 | Home |
| ArrowUp | 103 | code:111 | Up |
| PageUp | 104 | code:112 | Prior |
| ArrowLeft | 105 | code:113 | Left |
| ArrowRight | 106 | code:114 | Right |
| End | 107 | code:115 | End |
| ArrowDown | 108 | code:116 | Down |
| PageDown | 109 | code:117 | Next |
| Insert | 110 | code:118 | Insert |
| Delete | 111 | code:119 | Delete |
| F13..F24 | 183..194 | code:191..202 | F13..F24 |

Hotkey capture in the **settings window** works because the game binds are inactive while the
settings window, not PoE2, is focused. Global Omarchy SUPER binds are consumed by Hyprland, but
Super is not supported anyway.

### 5.8 Requirements for a standalone settings window

What `SettingsWindow.vue` depends on today, and the replacement for each:

| Dependency | Replacement |
|---|---|
| `inject<WidgetManager>("wm")` for `wm.hide`, `wm.widgets`, `wm.setFlag` | Remove. Close means "ask the backend to hide the window". The page receives the initial tab or widget from the URL or an event. |
| `props.config.wmWants` watcher used to clone on show | Clone on page load (`initConfig()` then a deep clone), **and** on a new "settings-shown" event if the host keeps the page alive between shows. Simplest is to reload or recreate the view on each open. |
| `settings::widget=<id>` flag | URL parameter, e.g. `index.html?view=settings&tab=price-check` or `&widget=<wmId>`, or an event `MAIN->CLIENT::settings-open {tab?, wmId?}` |
| Save: `updateConfig` + `saveConfig` (blocked by the exclusive check) + `pushHostConfig` | Send `CLIENT->MAIN::save-config {contents: JSON.stringify(clone), isTemporary:false}` **directly**, skipping the exclusive guard. The backend persists, broadcasts `MAIN->CLIENT::config-changed` to the panel renderers (they call `updateConfig`, the language watch reloads data/i18n, the font size applies), and **recomputes the Hyprland binds**. Optionally keep sending `update-host-config`. Then close the window, or keep it open as a normal app would. |
| Cancel / AppTitleBar close | Ask the backend to close the window. Treat a WM close (e.g. SUPER+W) the same way, discarding changes. The custom `AppTitleBar` can go, because the window has server-side decorations, or it can stay as an in-page header. |
| Quit button | `CLIENT->MAIN::user-action {action:"quit"}`. The backend shuts down the host and itself. |
| Live mutations of `AppConfig().language` / `preferredTradeSite` in `general.vue` | In a separate page they only affect the settings page, which gives a nice live preview. The panels change on save via `config-changed`. Keep or remove as desired. |
| `.window` CSS (absolute, centred, 50rem×38rem max, slideInDown) | Fill the viewport (`position:static; width:100%; height:100vh`) and drop the animation. Suggested window size: about 800×608 px at a 16px font size, with a minimum size. Make it a floating window via a window rule matching the host's class, e.g. `omaexiled-settings`. |
| Data needed by tabs | `initConfig()`, `I18n.init(language)`, `Data.init(language)` (price-check settings use `getAugmentNameByRef` / `usePoeninja`), `useLeagues()` (league list via `/proxy/`), `Host.init()` (WS `/events` for `log-entry`) |
| `Host.isElectron` checks | Not Electron. Make sure any `MAIN->OVERLAY::*` events the page needs are not filtered (`IPC.ts:51-53`). |
| Item-text routing | The settings page must **not** become the `item-text` target (see 1.3). |

Ways to open it in the port:
* Omarchy bar plugin "Settings" (replaces the tray item);
* the price panel's league link (`openLeagueSelection`) sends a request like
  `CLIENT->MAIN::open-settings {tab:"price-check"}` (new event);
* item check "edit" with `{tab:"item-check"}`;
* optionally a CLI (`omaexiled settings`).

The backend relays these to the host over stdio, e.g. `{"cmd":"settings.show","tab":…}` and
`{"cmd":"settings.hide"}`.

Tray parity for the bar plugin (`main/src/AppTray.ts:36-69`): "Settings/League" (now opens the
window directly), "Open in Browser" (`http://localhost:<port>`), "Open config folder"
(`<userData>/apt-data`; EE2 on Linux is `~/.config/exiled-exchange-2/apt-data/config.json`; offer
an import), "Quit".

---

## 6. Event and contract summary (this area)

| Direction | Name | Payload | Used by |
|---|---|---|---|
| backend → renderer (panel role only) | `MAIN->CLIENT::item-text` | `{target:"item-check"\|"open-wiki"\|"open-poedb"\|"open-craft-of-exile"\|"search-similar"\|"search-same-priced", clipboard, position:{x,y}, focusOverlay}` | item check, hotkeyable actions |
| renderer/bar → backend | `CLIENT->MAIN::user-action` | `{action:"stash-search", text}` / `{action:"quit"}` (`check-for-update`, `update-and-restart` dropped) | stash search, item check, settings Quit |
| renderer → backend | `CLIENT->MAIN::save-config` | `{contents:string, isTemporary:boolean}` | settings Save, autosaves |
| backend → all | `MAIN->CLIENT::config-changed` | `{contents:string}` | sync between settings and panels |
| renderer → backend | `CLIENT->MAIN::update-host-config` | `HostConfig` (`ipc/types.ts:1-16`) | optional if the backend computes binds itself |
| backend → renderer | `MAIN->CLIENT::log-entry` | `{message}` (full history on connect) | Debug tab |
| HTTP | `GET /config` | `HostState {contents, version, updater}` (`ipc/types.ts:70-74`) | initConfig in each page |
| new (proposed) | `CLIENT->MAIN::open-external {url}`, `CLIENT->MAIN::open-settings {tab?, wmId?}`, `CLIENT->MAIN::close-settings` | n/a | replaces `window.open`, the `wm` widget calls and the overlay-hosted settings |

Host shortcut action types kept: `copy-item` (targets above plus `price-check`),
`stash-search {text}`, and `paste-in-chat {text, send}`. Dropped: `toggle-overlay`,
`trigger-event` (delve-grid, stopwatch), `ocr-text` (heist gems), and `test-only`.

---

## 7. Risks and open questions (detail)

1. **Paste path is unvalidated.** The game reads the X11 CLIPBOARD (XWayland), while `wl-copy`
   writes the Wayland selection. Test `wl-copy` followed by `sendshortcut CTRL, V` into the
   in-game chat and the stash search box. If it fails, write the X11 clipboard (`xclip`) as
   well.
2. **`sendshortcut` reliability.** Omarchy documents stuck or repeating synthetic keys and uses
   `send_key_state` down/up with 50 ms. Multi-key macros (up to 8 taps for chat with send) need
   pacing and testing in game.
3. **Clipboard restore timing.** 120 ms (EE2) is probably too short with hyprctl round-trips.
   Make it configurable. Restoring too early pastes stale content.
4. **`item-text` routing** to the last-active WS client would break as soon as the settings
   window or the bar connects. Route by role.
5. **Hotkey-only item actions need a live renderer.** `registerActions()` must always be mounted.
6. **Map-like items**: drop `MapCheck` (decided "map check" DROP) and show `ItemInfo`, or keep it?
7. **Item-check dismissal** with the game keeping focus: no close button exists. Options: Esc
   bound only while the panel is visible (non-consuming?), pressing the hotkey again, a click
   outside, a cursor-leave timeout, or adding a close button.
8. **`overlayKey`**: drop it, or repurpose it as "toggle keyboard focus to the panel" (to type in
   price-panel inputs) or "close panels"?
9. **Stash search groups without overlay widgets**: put click-to-search in the bar plugin? Where
   does the `enableHotkeys` toggle live: settings only, or also the bar?
10. **Config autosave races** between the panel renderer (blur/exclusive-close saves, live
    mutations like map profile, `savedAugments`, `rememberCurrency`) and the settings window.
    The backend should be the single writer, and renderers should send full configs only on
    explicit actions. `saveConfig()`'s "exclusive widget shown" guard will also block autosaves
    whenever the price panel is shown in the port.
11. **Item check default hotkey**: EE2's default is `null`. Set `"Alt + D"` in port defaults, and
    remove the user's existing Hyprland `CTRL + ALT + D` bind for the old checker, because it
    clashes with price-check `hotkeyLocked`.
12. **Build tooling missing**: `cmake` (and `ninja`) are not installed and are needed for the
    Qt/LayerShellQt host.
