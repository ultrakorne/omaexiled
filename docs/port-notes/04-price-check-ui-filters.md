# 04 — Price-check UI, filters, item editor, extras

Source: `/home/ultra/Developer/Exiled-Exchange-2` @ `master` (cca30662). All paths below are relative to
`renderer/src/` unless they start with `main/`, `ipc/` or `renderer/`. Line numbers are for `master`.
The `omarchy*` branches change **nothing** under `renderer/src/web/price-check/**`; the only renderer
change there is `web/overlay/OverlayWindow.vue` (only hide `hide-on-blur` widgets on a real
active→inactive transition, so a read-only panel shown while the game keeps focus is not closed by
spurious `focus-change {overlay:false}` events). Keep that lesson: **never close the panel on a
"blur" that was not preceded by the panel actually having focus.**

Scope of this file: everything in `web/price-check/**` except the trade API internals
(`trade/*.ts`, covered elsewhere), plus the `web/ui/**` components they use. Trade `.vue` components are
covered here.

---------------------------------------------------------------------------------------------------

## 0. File inventory (role, keep/drop)

| File | LOC | Role | Port |
|---|---|---|---|
| `web/price-check/PriceCheckWindow.vue` | 451 | Widget root: receives `MAIN->CLIENT::item-text`, parses, layout (spacer / panel / related column), title bar, exchange-rate popover, builtin `<webview>` browser, close logic, `provide("builtin-browser")` | KEEP, adapt (§5) |
| `CheckedItem.vue` | 361 | Per-item body: presets, filter block, trend, trade listing/bulk, Search button, Trade link, stack value, tips/support | KEEP |
| `BackgroundInfo.vue` | 61 | Updater notice, leagues loading/error box with Retry + "Browser" (captcha) | KEEP (updater part becomes inert) |
| `CheckPositionCircle.vue` | 43 | Circle drawn at the cursor position where the check was triggered | needs fullscreen coords → drop or separate surface (§5) |
| `filters/interfaces.ts` | 231 | `ItemFilters`, `StatFilter`, `StatFilterRoll`, `FilterNumeric`, `INTERNAL_TRADE_IDS`, `FilterTag`, enums | KEEP verbatim |
| `filters/common.ts` | 73 | `maxUsefulItemLevel`, `likelyFinishedItem`, `hasCraftingValue`, `explicitModifierCount` | KEEP |
| `filters/util.ts` | 37 | `roundRoll`, `percentRoll`, `percentRollDelta` | KEEP (also used by `web/ui/StatRollSlider.vue:43`, `web/map-check/prepare-map-stats.ts:3`) |
| `filters/create-presets.ts` | 114 | Preset selection (pseudo / base item / exact / logbook roman / unique presets) | KEEP |
| `filters/create-item-filters.ts` | 708 | Item-level filters (name/base/category, ilvl, quality, sockets, rarity, corrupted, …) incl. gem/uncut gem/trials | KEEP |
| `filters/create-stat-filters.ts` | 974 | Stat filters (exact + "UI/pseudo" modes), roll ranges, hiding rules, empty-affix pseudo | KEEP |
| `filters/create-unique-filters.ts` | 156 | `PRESET_UNIQUES` (`Mageblood`) special preset | KEEP |
| `filters/fill-augments.ts` | 168 | Old "augment fill" (apply/remove) — **dead** except `getAugmentNameByRef` (imported but unused by settings) | KEEP or delete dead code |
| `filters/pseudo/index.ts` | 640 | Pseudo rules (resists/attrs/life/mana/ES/MS/uses remaining) | KEEP |
| `filters/pseudo/item-property.ts` | 723 | Armour/weapon/map property filters (Q20 values, DPS, APS, crit, reload, spirit, map props) | KEEP |
| `filters/pseudo/anointments.ts` | 66 | Oil decoding + anointment hide rule | KEEP |
| `filters/pseudo/atzoatl-rules.ts` | 197 | Chronicle of Atzoatl (all rules commented out → just disables all) | KEEP |
| `filters/pseudo/reflection-rules.ts` | 50 | Mirrored Tablet rules (rules commented → drop difficulty<8, hide rest) | KEEP |
| `filters/pseudo/missing-fractured-rules.ts` | 11 | Fractured-without-fractured-mods fallback | KEEP |
| `filters/FiltersBlock.vue` | 517 | Filter chips row, item-editor button, preset tabs, stat list form, collapse/hidden/mods toggles, unknown mods, fractured warning | KEEP |
| `filters/FilterModifier.vue` | 607 | One stat filter row (checkbox, text, min/max inputs, slider, tag, tiers, hidden reason, sources, special option rows) | KEEP |
| `filters/FilterBtnNumeric.vue` | 159 | Numeric chip (toggle + min [+ max]) | KEEP |
| `filters/FilterBtnLogical.vue` | 58 | Boolean chip (toggle / readonly / collapse chevron) | KEEP |
| `filters/FilterBtnDropdown.vue` | 88 | Dropdown chip — **registered in FiltersBlock but never used in template** | dead |
| `filters/FilterName.vue` | 111 | Name/base/category accuracy toggle + corrupted toggle | KEEP |
| `filters/FilterModifierAnointment.vue` | 69 | Oils icons + summed poe.ninja price for anoint | KEEP |
| `filters/FilterModifierItemHasEmpty.vue` | 79 | "Empty affix / prefix / suffix" option buttons | KEEP |
| `filters/FilterModifierItemIsElemental.vue` | 124 | Elemental DPS any/fire/cold/lightning buttons (left/right click) | KEEP |
| `filters/FilterModifierTiers.vue` | 98 | T1/T2/Tn chips | KEEP |
| `filters/SourceInfo.vue` | 105 | Hover dropdown showing the source mods of a filter | KEEP |
| `filters/UnknownModifier.vue` | 52 | Unrecognized mod row + reload fallback data button | KEEP |
| `filters/ItemEditorButton.vue` | 61 | **Not imported anywhere** | dead |
| `item-editor/ItemEditorV2.vue` | 47 | Picks AugmentEditor vs QualityEditor | KEEP |
| `item-editor/AugmentEditor.vue` | 336 | Rune/soul-core/idol socket editor + saved augments | KEEP |
| `item-editor/QualityEditor.vue` | 206 | Catalyst quality editor (rings/amulets/jewels) | KEEP |
| `item-editor/AugmentsList.vue`, `ItemEditorItem.vue` | 34/42 | Lists | KEEP |
| `item-editor/item-editor.ts` | 88 | `getItemEditorType`, `applyCatalyst`, `AugmentSaveType` | KEEP |
| `item-editor/augment.ts` | 83 | `getCategoryGroups`, `useAugment` (also imported by `parser/Parser.ts:46` → circular parser↔web dep) | KEEP |
| `trends/PriceTrend.vue` | 307 | poe.ninja price, volume, 7d trend sparkline | KEEP |
| `trends/getDetailsId.ts` | 347 | poe.ninja lookup key for an item (also used by trade `.ts`) | KEEP |
| `related-items/RelatedItems.vue` | 169 | Related drops/prices side box | KEEP (layout adapt) |
| `stack-value/StackValue.vue` | 78 | "You have ×N → price / Stack ×max → price" | KEEP |
| `unidentified-resolver/UnidentifiedResolver.vue` | 89 | Choose unique for unid unique base | KEEP |
| `price-prediction/*` (PricePrediction.vue, FeedbackOption.vue, poeprices.ts) | 166/99/146 | poeprices.info — **disabled**: `<price-prediction>` commented out in `CheckedItem.vue:4` | DROP (also drop setting `requestPricePrediction` UI) |
| `fallback/ReloadTradeData.vue` | 101 | "Reload fallback data" (re-download trade stats/items) + "Retry Item" | KEEP |
| `settings-price-check.vue` | 379 | Settings page for price check | KEEP (in settings window) |
| `trade/TradeListing.vue` | 353 | Search results table (trade API) | KEEP |
| `trade/TradeItem.vue` | 254 | One result row + hover item tooltip (tippy) | KEEP |
| `trade/TooltipItem.vue` | 419 | In-game-style item card tooltip for a listing | KEEP |
| `trade/TradeBulk.vue` | 301 | Bulk exchange results table | KEEP |
| `trade/OnlineFilter.vue` | 195 | Listing type / listed time / league / currency popover | KEEP |
| `trade/TradeLinks.vue` | 67 | "Trade" link button(s) | KEEP, adapt |
| `trade/RateLimiterState.vue` | 116 | "Rate limiting" tab + policy popup | KEEP (layout adapt) |
| `trade/ExtractionValue.vue` | 116 | "Σ augments − extraction orb = profit" notice | KEEP |
| `web/ui/*` used: AppTitlebar, Popover, UiErrorBox, UiToggle, UiCheckbox, UiRadio, UiTabs, ItemQuickPrice, ItemSumPrice, StatRollSlider, ItemModifierText, UiItemImg, CoreCurrencyImg, UiDetailedItemImg | | | KEEP |
| `web/ui/*` NOT used by price-check: FullscreenImage (map-check, image strip), UiTimeout (item-search), VirtualScroll (map-check settings) | | | drop unless item-check needs |

Tests to port with the code: `renderer/specs/web/price-check/filters/{create-item-filters,create-stat-filters,missing-fracture-rules}.test.ts`, `filters/pseudo/index.test.ts`, `trade/pathofexile-trade.test.ts` (vitest; setup `renderer/specs/vitest.setup.ts`, helper `renderer/specs/helper.ts`).

---------------------------------------------------------------------------------------------------

## 1. Runtime flow (exact semantics)

### 1.1 Item intake — `PriceCheckWindow.vue:261-305`
1. `MainProcess.onEvent("MAIN->CLIENT::item-text", e)`; ignore unless `e.target === "price-check"`.
   Payload type (`ipc/types.ts:184-192`): `{ target: string; clipboard: string; item?: unknown; position: {x,y}; focusOverlay: boolean }`.
   Main sends it to `"last-active"` client (`main/src/shortcuts/Shortcuts.ts:224-232`); `position` = `screen.getCursorScreenPoint()` at hotkey press (DIP, screen coords).
2. If `Host.isElectron && !e.focusOverlay` → send `OVERLAY->MAIN::track-area` (see §5.3) with
   `width = 28.75 * fontSize`, area x = right-side or left-side depending on press position vs window centre,
   `closeThreshold = 2.5 * fontSize`, `holdKey = config.hotkeyHold`, `dpr = window.devicePixelRatio`.
3. `closeBrowser()` (drop `has-browser` flag), `wm.show(wmId)`, `checkPosition = e.position`,
   `advancedCheck = e.focusOverlay`.
4. `item = handleItemPaste(...)`: uses `e.item` if supplied (never supplied by EE2 main; allows a backend to pre-parse) else `parseClipboard(e.clipboard)` (neverthrow `Result`).
   Rejects (`err("item.unknown")`) `HeistContract` and `Sentinel` that are not Unique (`:308-316`).
   Error mapping (`:317-333`): `"item.wrong_language|<gameLang>|<eeLang>"` → `{name:"item.wrong_language", message:"item.wrong_language_help", format:[gameLang, eeLang], rawText}`; other errors `{name: err, message: err+"_help", rawText}`.
5. If OK → `usePoeninja().queuePricesFetch()` (refreshes poe.ninja DB if stale).
6. `MAIN->OVERLAY::hide-exclusive-widget` → `wm.hide(wmId)` (`:342-344`).
7. When `wmWants` becomes `"hide"` → `closeBrowser()` (`:346-353`).
8. On mount (`nextTick`, `:252-255`) the widget forces `wmWants="hide"`, `wmFlags=["hide-on-blur","menu::skip"]` (panel never starts open, never appears in widget menu).
9. `leagueId` watch (immediate) → `loadUltraLateItems()` (`assets/data/index.ts:326`: rebuilds `AUGMENT_DATA_BY_AUGMENT`, `AUGMENT_DATA_BY_TRADE_ID`, `GROUPED_AUGMENTS`, `CATALYST_TYPES`, `CATALYST_TO_TAG`).

### 1.2 Presets & search orchestration — `CheckedItem.vue`
- Rendered only if `isLeagueSelected` (`PriceCheckWindow.vue:89`) and body only if `noUniqueSelection`
  (not "Unique && unidentified && info.unique == null", `CheckedItem.vue:266-272`).
- Watch `props.item` **deep + immediate** (`:148-210`). NOTE: deep watch ⇒ the item editor mutating
  the ParsedItem in place (`useAugment`, `applyCatalyst`) re-runs this ⇒ presets are rebuilt and all manual
  filter edits are lost; currency is kept because namespace+refName are equal.
  - `prevCurrency = itemFilters.trade.currency`, `prevListingType = itemFilters.trade.listingType`.
  - `presets = createPresets(item, { league: leagues.selectedId, collapseListings, activateStockFilter,
    searchStatRange, useEn: (language==="cmn-Hant" && realm==="pc-ggg") || preferredTradeSite==="www",
    currency: rememberCurrency || (prevItem && same info.namespace && same info.refName) ? prevCurrency : undefined,
    listingType: rememberListingType ? prevListingType : undefined, defaultAllSelected })`.
  - `doSearch` (auto-search): `false` if `(!advancedCheck && !smartInitialSearch) || (advancedCheck && !lockedInitialSearch)`;
    otherwise `true` only if item is Unique || HeistBlueprint || SanctumRelic || Charm || category not in
    `CATEGORY_TO_TRADE_ID` (currency, cards, …) || unidentified || veiled. (Rares/magic with mods ⇒ user presses Search.)
  - `tradeAPI = apiToSatisfySearch(item, stats, filters)` (`trade/common.ts:26-45`: any enabled stat ⇒ `"trade"`;
    DivinationCard/Map with stackSize filter ⇒ `bulk` iff stock filter enabled; else `tradeTag(item)!=null ? "bulk":"trade"`).
    If `bulk` ⇒ force `filters.trade.listingType = "online"` (overrides remembered listing type).
- Watch `[item, doSearch]` immediate (`:212-231`): when `doSearch` → recompute `tradeAPI`, `nextTick` → `tradeService.execSearch()`
  (`TradeListing.execSearch` → `useTradeApi().search(filters, stats, item)`; `TradeBulk.execSearch` → `useBulkApi().search(item, filters)`).
- Watch `[item, doSearch, itemStats, itemFilters]` deep (`:233-247`): same item, search already done, any filter
  change ⇒ `doSearch=false` (results hidden, Search button + Trade link shown again).
- Watch `[item, JSON.stringify(filters.trade)]` (`:249-264`): same item, trade options changed (listing type, league,
  currency, listed) ⇒ `nextTick(doSearch=true)` ⇒ automatic re-search.
- Preset switch (`selectPreset`) changes `presets.active` → `itemFilters`/`itemStats` computed switch (`:128-139`, `:352-354`).
- `itemFilters.itemEditorSelection` deep watch emits `item-editor-selection` (`:324-330`) — no listener (dead).

### 1.3 Search button "hover-through" trick — `CheckedItem.vue:29-34, 274-286`
The Search button sits in a `w-40` div with `@mouseenter`. If the pointer enters that div **coming from inside
the FiltersBlock element** (`e.relatedTarget` contained in `filtersComponent.$el`) ⇒ `doSearch = true` and
`document.activeElement.blur()`. I.e. sweeping the mouse down from the filters onto the Search button searches
without clicking.

---------------------------------------------------------------------------------------------------

## 2. FEATURE PARITY CHECKLIST

IDs are stable for later verification. "→" = effect. Text keys are vue-i18n keys from
`renderer/public/data/<lang>/app_i18n.json` (keep the whole file; `useI18nNs(ns)` maps `":key"` → `"ns.key"`).

### A. Panel shell, layout, title bar
- [ ] **PC-A01** Panel width `28.75rem` (`#price-window`, `PriceCheckWindow.vue:15-19`), full monitor height, `bg-gray-800`, text `gray-200`. Root font-size = `config.fontSize` px (`Config.ts:27`), so width scales with fontSize (default 16 ⇒ 460 px).
- [ ] **PC-A02** Side selection: `clickPosition = "inventory"` if `checkPosition.x > window.screenX + innerWidth/2` else `"stash"` (`:370-379`); forced `"inventory"` when builtin browser is shown. Stash ⇒ panel placed right of the stash panel (left spacer = `var(--game-panel)`); inventory ⇒ flex-row-reverse, panel left of the inventory panel. `--game-panel` = `poePanelWidth = window.innerHeight * 986/1600` px (Electron only; 0 otherwise) (`overlay/OverlayWindow.vue:328-333`).
- [ ] **PC-A03** Related-items box + rate-limiter tab live in the remaining column on the **screen-centre side** of the panel, adjacent to it (`:110-126`, inner flex also reversed for inventory).
- [ ] **PC-A04** Title bar (`ui/AppTitlebar.vue`): height 1.5rem, `bg-gray-900 text-gray-600`; left slot = exchange-rate widget; centre = title button (truncate); right = close button (`fas fa-window-close`, `tabindex=-1`, red hover, `title="Close"`, click uses `.stop`).
- [ ] **PC-A05** Title text = selected league id, or `"Exiled Exchange 2"` when none (`:356-358`).
- [ ] **PC-A06** Clicking the title opens Settings focused on the price-check page (`openLeagueSelection`, `:407-411`: sets flag `settings::widget=<wmId>` on the settings widget and shows it; `settings/SettingsWindow.vue:227-242` picks `menuByType("price-check") = [[SettingsPricecheck]]`).
- [ ] **PC-A07** Exchange-rate button (only if `stableOrbCost && xchgRateCurrency.id`): `<i class="fas fa-exchange-alt"/> {round(xchgRate)}`; click → tippy popover (boundary `#price-window`) with ItemQuickPrice "1 divine → N core" (img `/images/divine.png`) and 9 lines `"{i/10} div ⇒ {round(rate*i/10)} {abbrev}"` for i=1..9 (`:25-52`).
- [ ] **PC-A08** While poe.ninja initial load in progress (`initialLoading()` = loading && DB empty) show `fas fa-dna fa-spin` instead; else an empty `w-8` placeholder (`:53-54`).
- [ ] **PC-A09** Close button (`closePriceCheck`, `:391-405`): if `overlayAlwaysClose` → `OVERLAY->MAIN::focus-game`; else if builtin browser shown or not Electron → `wm.hide`; else `OVERLAY->MAIN::focus-game` (which, via `focus-change` + `hide-on-blur`, hides the panel). Port: close ⇒ hide panel (no focus juggling needed).
- [ ] **PC-A10** Panel is an "exclusive" widget (`wmZorder:"exclusive"`): showing it hides any other exclusive widget; config saving is suppressed while it is shown (`Config.ts:30-38`) and happens when it hides (`OverlayWindow.vue:314-326`) or on window blur. Port: persist config when the panel closes (item-editor "Save" and rate-limit toggle write config while open).
- [ ] **PC-A11** `hide-on-blur` flag: panel hides when the overlay loses focus (`OverlayWindow.vue:133-152`); with builtin browser open the flags flip to `invisible-on-blur` (stays alive but invisible) (`PriceCheckWindow.vue:381-389`). See §5.4 for the port's close rules.
- [ ] **PC-A12** Escape / Ctrl+W while overlay focused → focus game → panel hides (`main/src/windowing/OverlayWindow.ts:155-161`). Overlay key (default `Shift + Space`) toggles overlay focus.
- [ ] **PC-A13** Check-position circle (`CheckPositionCircle.vue`): 5rem translucent white circle + 1.25rem inner dot centred at the press position, `z-index:-1`, only when `wm.active && config.showCursor` (`PriceCheckWindow.vue:58-62, 366-368`). Coordinates relative to `window.screenX/screenY` (fullscreen overlay assumption).
- [ ] **PC-A14** Builtin-browser hint bar when browser shown: `app.toggle_browser_hint` with the overlay key in a chip (`:94-100`).

### B. Item intake, errors, unidentified uniques
- [ ] **PC-B01** New hotkey press replaces panel content immediately (item, position, advancedCheck).
- [ ] **PC-B02** Parse error box (`UiErrorBox`, red border): name `t(err.name)`, message `t(err.message)` or `t(err.message, format)` for wrong-language; actions slot = `ReloadTradeData` (with `item-text` and `pos`); below it a `<pre>` with the raw clipboard text (`:63-82`).
- [ ] **PC-B03** Heist contracts and Sentinels that are not unique ⇒ `item.unknown` error.
- [ ] **PC-B04** Unidentified unique without resolved unique (`UnidentifiedResolver.vue`): header `t("item.identification",[base name])`; 2-column grid of all uniques whose `unique.base === info.refName` (dedup by refName, variants ignored), each a button with icon (`/images/404.png` if `%NOT_FOUND%` or empty) and name; click ⇒ emits `identify` with `{...item, info: chosenUnique}` ⇒ panel re-renders as identified. **If exactly one candidate it auto-selects** (side effect inside computed, `:53-55`).
- [ ] **PC-B05** `ReloadTradeData` (`fallback/ReloadTradeData.vue`): button `t("Reload fallback data")` (`my-2` if `button-margin`) → `useTradeData().load(true)` (re-download `www.pathofexile.com/api/trade2/data/stats` and `/items`); while loading `t("Loading...")`; result: if found counts → `t("poe2_new.found_data",[items, stats])` + button `t("Retry Item")`; zero counts → `t("poe2_new.no_data")`; failure → `t("poe2_new.failed_to_load")`.
- [ ] **PC-B06** "Retry Item" → `Host.selfDispatch({name:"MAIN->CLIENT::item-text", payload:{target:"price-check", clipboard:itemText, position: pos, focusOverlay:true}})` — local re-dispatch, no backend round-trip (`:78-89`).

### C. Presets — `filters/create-presets.ts`
- [ ] **PC-C01** Logbook branch (`refName === "logbook here"` — effectively dead): presets I..V per area.
- [ ] **PC-C02** Single preset `filters.preset_exact` (exact item filters + `createExactStatFilters(statsByType)`) when: unidentified; Normal rarity; not craftable and not Unique; non-unique Flask/Relic/Tincture/MemoryLine/Invitation/HeistContract/HeistBlueprint/Sentinel/Tablet/Wombgift; Currency with `trials.numberOfTrials` (`:45-72`).
- [ ] **PC-C03** `PRESET_UNIQUES` (`Mageblood`) ⇒ `createUniquePresets` (single `filters.preset_exact` with Mageblood rules: all non-legacy stats + "Duplicates: #" pseudo (`item.duplicates`, bounds 0..3, min = 4 − #legacies) + each "Legacy of X" stat without roll; all visible filters enabled).
- [ ] **PC-C04** Otherwise `filters.preset_pseudo` (non-exact item filters + `initUiModFilters`). If `likelyFinishedItem(item) || !hasCraftingValue(item)` that is the only preset; else add `filters.preset_base_item` (exact item filters + exact stat filters) and show preset tabs (pseudo active).
  - `likelyFinishedItem` (`common.ts:23-30`): Unique, or has Crafted mods, or quality===20 with no qualityType, or not modifiable.
  - `hasCraftingValue` (`common.ts:32-51`): modifiable AND (synthesised || fractured || influences || ClusterJewel || magic Jewel || ilvl ≥ maxUsefulItemLevel−15 || augmentSockets.current > normal || quality > 20).
  - `maxUsefulItemLevel` (`common.ts:9-21`): Wand/Staff 81, Relic 80, Tablet/Jewel/Map 1, default 82.

### D. Item-level filter generation — `filters/create-item-filters.ts` (`createFilters`, line 40)
Defaults: `trade = { offline:false, onlineInLeague:false, listingType: opts.listingType ?? "securable", listed: undefined, currency: opts.currency, league, collapseListings }`. Name translation helper `t(opts, info)` = `useEn ? refName : name` (`:682-684`).
- [ ] **PC-D01** Gems (GEM category, no trade tag) → `createGemFilters` (`:489`): baseType (transfigured → normal variant base + `discriminator.trade = info.tradeDisc`); `corrupted={value}`; awakened: gemLevel (disabled if <5), quality if corrupted (disabled <20); SPECIAL_SUPPORT_GEM (Empower/Enlighten/Enhance): gemLevel (disabled <3), quality if corrupted (disabled); others: socketNumber (disabled <3), quality (disabled <16), gemLevel (disabled <19).
- [ ] **PC-D02** Uncut gems (`createUncutGemFilters`, `:568`): gemLevel = level−1..level+1 range if level<18 and not "Uncut Support Gem"; else exact.
- [ ] **PC-D03** Currency with trials (`createTrialsFilters`, `:592`): awardedAscendancyPoints (from area level via table: Inscribed Ultimatum {1:1,2:60,3:75}, Djinn Barya {1:1,2:45,3:60,4:75}), areaLevel, ultimatumHint (Inscribed Ultimatum, disabled by default).
- [ ] **PC-D04** CapturedBeast: baseType + `baseTypeTrade = refName` (always English), nothing else.
- [ ] **PC-D05** stackSize filter when item has stack or trade tag: value = stack (≥1), enabled only if stack>1 && `activateStockFilter`.
- [ ] **PC-D06** Invitation / MetamorphSample (+itemLevel enabled) / DivinationCard / Currency / "Charged Compass": baseType only (+ Chronicle of Atzoatl areaLevel floored to [1,68,73,75,78,80]; Mirrored Tablet & Forbidden Tome areaLevel; Filled Coffin itemLevel).
- [ ] **PC-D07** Map (waystone): unique ⇒ name + unique base; else baseType + `searchRelaxed {category, disabled:false}` (i.e. **category search on by default** for non-unique maps); `mapBlighted` readonly chip; `mapTier` enabled.
- [ ] **PC-D08** Expedition Logbook: baseType + areaLevel (exact). HeistBlueprint: searchRelaxed disabled, baseType, areaLevel, heistWingsRevealed.
- [ ] **PC-D09** Unique: name + nameTrade + unique base trade type.
- [ ] **PC-D10** Everything else: baseType; if category in `CATEGORY_TO_TRADE_ID` ⇒ `searchRelaxed {category}` disabled when exact (base-item preset), **enabled in pseudo preset** (category search by default), ClusterJewel always disabled, SanctumRelic/Charm always enabled.
- [ ] **PC-D11** sentinelCharge (enabled) if present.
- [ ] **PC-D12** Quality: Flask q≥20 shown, enabled only if >20; q>20 on Flask/Charm/Tincture/weapon/armour shown, disabled for Rare; Charm: enabled if ≥10.
- [ ] **PC-D13** linkedSockets / whiteSockets (enabled) from `gemSockets`.
- [ ] **PC-D14** augmentSockets (if current>0): disabled when `current <= normal && !corrupted`.
- [ ] **PC-D15** `itemEditorSelection = {disabled:true, editing:false, value:"None"}` always present (vestigial).
- [ ] **PC-D16** `requires.level` (disabled) for Rare, non-exact, when req level ≤75 and ilvl ≤75.
- [ ] **PC-D17** corrupted `{value: isCorrupted, exact: forAdornedJewel}` for modifiable Normal/Magic/Rare/Unique non-Map; forAdornedJewel = Magic Jewel/AbyssJewel.
- [ ] **PC-D18** rarity: magic jewel ⇒ "magic"; Normal (not "Idol of Estazunti") exact ⇒ "normal"; Magic exact (not Tablet) ⇒ "magic"; other N/M/R ⇒ "nonunique" (no chip for nonunique).
- [ ] **PC-D19** mirrored `{disabled:false}` if mirrored; sanctified `{disabled:false}` if sanctified; `fractured {value:false}` if not fractured and exact; foil `{disabled:true}` if foil.
- [ ] **PC-D20** influences (≤2): chips, enabled only in exact mode.
- [ ] **PC-D21** itemLevel (non-unique, not Map/HeistBlueprint/HeistContract/MemoryLine/Expedition Logbook, maxUseful≠1): ClusterJewel floor [1,50,68,75,84] + max ceil [100,74,67,49], enabled iff exact; else `min(ilvl, maxUseful)`, enabled iff exact and not Flask/Charm. Unique: unid Watcher's Eye ⇒ ilvl enabled; Agnerod* ilvl≥75 normalized to 75/78/80/82 enabled.
- [ ] **PC-D22** Unidentified: `unidentifiedTier` (enabled iff tier ≥5) or `unidentified` chip (enabled only for Unique).
- [ ] **PC-D23** Veiled: `veiled {statRefs, veiledCount, disabled: !Unique}`; non-unique veiled ⇒ itemLevel forced enabled.
- [ ] **PC-D24** `tempAugmentStorage = []` when any augment socket is empty (vestigial).

### E. Stat filter generation — `filters/create-stat-filters.ts`
- [ ] **PC-E01** Range % = `searchStatRange` (default 10). Exact mode uses `min(2, searchStatRange)` (Tablet ⇒ 0). Normal rarity in UI mode ⇒ 100.
- [ ] **PC-E02** `createExactStatFilters` (`:38-220`): blighted maps/Invitations ⇒ none; unid unique (not synth) ⇒ implicits enabled; keep types Pseudo/Fractured/Desecrated/Crafted/Enchant/Necropolis/Sanctum/Skill (+Implicit if no influences/fractured and not Tincture; +Explicit for Magic or Rare with <5 explicit mods excluding Cluster/Map/HeistContract/HeistBlueprint/Sentinel; +Crafted for Flask). Tablet: pseudo first. Chronicle of Atzoatl / Mirrored Tablet special rules. All shown (hidden cleared); Explicit enabled only if some source tier ≤2; non-Property enabled; fractured items skip explicit; Tablets skip implicit; "# uses remaining" min/default pinned to value. Missing-fractured fallback. "# Empty Modifier" pseudo (enabled). Cluster/Flask rules; MemoryLine/SanctumRelic/Charm/Relic enable all; `defaultAllSelected` enables all non-hidden.
- [ ] **PC-E03** `initUiModFilters` (`:222-312`): fractured/desecrated/crafted with an explicit trade id are treated as Explicit; `filterItemProp` (armour/weapon/map properties) and `filterPseudo` (skipped for uniques with sockets via `getMaxSockets`), Emperor's Vigilance base percentile; "Split Personality" skips all; modifiable items re-add fractured/desecrated/crafted with own-type sources; veiled mods removed and **all filters disabled** for veiled items; `finalFilterTweaks`; `defaultAllSelected`.
- [ ] **PC-E04** `calculatedStatToFilter` (`:352-571`): option stats (`stat.trade.option`) ⇒ tag Variant/Enchant, `option.value`, enabled; tag adjustments: implicit → Eldritch / Synthesised / Variant (Runemastered fixedStats); explicit → Mutated (unique mutated), Variant (not in unique fixedStats), Delve, Incursion; enchant corrupted → Corrupted. Roll: goodness; percent 0 for unmodifiable magic or "Has # Charm Slot"; perfect rolls on uniques / magic jewels+tablets / T1 fractured ⇒ percent 0; `dp`; bounds (uniques with variable comparable roll); default min/max (unique uses delta of range); `filterFillMinMax` (Positive ⇒ min, Negative ⇒ max, NotComparable ⇒ both; `item.reload_time` treated as Negative); negated translations flip sign and `tradeInvert`. `hideNotVariableStat` hides constant rolls on uniques (`filters.hide_const_roll`).
- [ ] **PC-E05** `finalFilterTweaks` (`:633-775`): cluster/flask rules; uniques (except Morior Invictus, Darkness Enthroned) disable+hide augment stats (`hide_const_roll`) except "Destroys all Augment Sockets…"; "# Empty Modifier" pseudo **disabled + hidden** (`filters.hide_empty_mod`); rings/amulets anointment rule; fractured/desecrated/crafted with explicit equivalent hidden (`filters.hide_for_crafting`); Skill filters disabled+hidden if level<19 (`filters.hide_not_max_level`); Map: everything except Property/Desecrated disabled+hidden (`filters.hide_for_map`); Tablet "# uses remaining" never hidden; `editorAdded` set from added augments / catalyst-added increases (shows icon); magic modifiable item with ilvl < maxUseful−3 ⇒ hidden disabled "Rarity: Magic" pseudo (`item.rarity_magic`, `filters.hide_low_ilvl`); Unique or Relic with ≤3 visible filters ⇒ enable all.
- [ ] **PC-E06** Flask enchants hidden+disabled unless "Gains no Charges during Flask Effect" present (`hide_harvest_and_instilling`).
- [ ] **PC-E07** Cluster jewel "Adds # Passive Skills" enabled with optimal-count min/max rules; "# Added Passive Skills are Jewel Sockets" hidden.
- [ ] **PC-E08** Empty-affix detection (`showHasEmptyModifier`, `:845-887`): only modifiable Rare/Magic non-Map; base max mods: Normal 0, Magic 1, Jewel/Tablet/Relic/SanctumRelic 2, else 3 per side; "# Prefix/Suffix Modifier allowed" stats adjust; default option = Prefix if suffixes full, Suffix if prefixes full, else Any; counts per option.
- [ ] **PC-E09** Pseudo rules (`pseudo/index.ts:85-367`): total all-ele res (hidden, special min-element computation, removed if 0), total ele res (enabled), total fire/cold/lightning res (only the max one kept and hidden, or none if tie), total chaos res (enabled unless only from augment → hidden `filters.hide_crafted_chaos`), total all attributes / str / dex / int (all-equal ⇒ keep "to all"; else drop "to all" and hide the smallest when < 30 % of largest), total life (enabled; needs flat life), total mana (needs flat mana), total % ES, total flat ES, movement speed (enabled unless sole implicit source), "# uses remaining" (tablets, enabled). Source stats consumed by a pseudo rule are removed from the list.
- [ ] **PC-E10** Item property filters (`pseudo/item-property.ts`): Armour/Evasion/ES at Q20 (enabled; `isSingleAttrArmour` always true now), Block (disabled), Runic Ward (disabled); weapons: Total DPS (enabled when elemental), Elemental DPS (+fire/cold/lightning sub-rolls in `additionalInfo.elementalInfo`, option Any; disabled+hidden `filters.hide_ele_dps` if <15 % of total), Physical DPS (enabled if pdps-important class and ≥67 % of total; hidden `filters.hide_phys_dps` if <67 %), APS / Crit / Reload time (disabled), Spirit (enabled); maps: Revives (hidden), Pack size, Magic/Rare monsters, Drop chance, Item rarity, Gold, Monster rarity (→`item.map_rare_monsters`), Monster effectiveness (→`item.map_magic_monsters`) — all disabled. Stats used by these are removed from the list.
- [ ] **PC-E11** Anointment (`pseudo/anointments.ts`): oils decoded from enchant (`EMOTIONS` list); talisman ⇒ enabled; modifiable item without a high-value oil (Concentrated Liquid Isolation, Potent Liquid Ferocity, Potent Liquid Contempt) ⇒ hidden (`filters.hide_anointment`) disabled.

### F. FilterName row — `filters/FilterName.vue`
- [ ] **PC-F01** Left button label = active search: `searchRelaxed` (if not disabled) else `searchExact`; shows `name` or `baseType` or `t("item_category.prop",[t("item_category.<tradeId with . → _>")])`; fallback text `"??? Report if you see this text"`.
- [ ] **PC-F02** Click toggles `searchRelaxed.disabled` (exact base ↔ category) if `searchRelaxed` exists; border `gray-500` when relaxed is disabled (= exact), `gray-900` otherwise.
- [ ] **PC-F03** Right button (if `filters.corrupted`): red `t("item.corrupted")` / gray `t("item.not_corrupted")`; click toggles `corrupted.value`.

### G. Filter chips row — `filters/FiltersBlock.vue:4-166` (exact order)
- [ ] **PC-G01** Numeric chips (FilterBtnNumeric) in order: `item.gem_sockets` (socketNumber), `item.linked_sockets`, `item.map_tier`, `item.ascendancy_points`, `item.area_level`, `item.heist_wings_revealed`, `item.sentinel_charge`; then readonly logical chips: mapBlighted text, "Magic" (rarity magic), "Normal" (rarity normal), discriminator value; then numeric `item.item_level`, `item.requires_level`, `item.stock` (stackSize), `item.white_sockets`, `item.augment_sockets`, `item.gem_level`, `item.quality`; influences chips with `/images/influence-<Influence>.png`; `item.unidentified_tier` (numeric) or `item.unidentified` (logical); `item.veiled`; `item.foil_unique`; mirrored (always-active border, label `item.mirrored`/`item.not_mirrored` by disabled state); sanctified (same, `item.sanctified`/`item.not_sanctified`); ultimatum hint `item.<victorious|cowardly|deadly>`; stats-visibility chip.
- [ ] **PC-G02** FilterBtnNumeric (`FilterBtnNumeric.vue`): border `gray-500` when enabled; clicking the label toggles `disabled`; min input `type=number step=any`, width `(1.2 + max(len,2))ch`; **focus ⇒ select all + enable filter**; **right mouse-down ⇒ clear (value becomes 0) and focus** (`.prevent`); **blur while empty ⇒ value 0 and filter disabled**; wheel events stopped (`@mousewheel.stop`); max input only when the filter object has a `max` key (cluster ilvl, uncut gem level): placeholder "…", clearing sets `max=undefined`. Focused inputs hide the mouse cursor (`cursor:none`). Number spinners hidden globally (`App.vue`).
- [ ] **PC-G03** FilterBtnLogical (`FilterBtnLogical.vue`): optional 20×20 image, text passed through `t()`, active border = `active` prop if given else `!disabled`; click toggles unless `readonly`; `collapse` prop shows chevron (down when disabled).
- [ ] **PC-G04** Stats-visibility chip (only if `hasStats`): text `filters.selected_some` [selected, total] (active) or `filters.selected_none`; click collapses/expands the stat list (`statsVisibility.disabled`), chevron indicates state. `hasStats` = stats.length || (showUnknownMods && Unique) || presets>1.
- [ ] **PC-G05** Item-editor button (right of chips, 32×32 `bg-gray-900` bordered square) when `showItemEditor !== "none"` (`:167-192`, §R). Icon: `fa-question-circle` if ring/amulet/jewel without current catalyst; current catalyst icon; else `/images/augments/rune.png` if any augment present else `/images/augments/empty-socket.png`. Hover opens popover (tippy, `delay [0,500]`, `placement right`, interactive) containing `ItemEditorV2`.

### H. Stat list — `FiltersBlock.vue:195-286` + `FilterModifier.vue`
- [ ] **PC-H01** Shown when `!statsVisibility.disabled && hasStats`. Preset tabs (only if >1 preset): buttons `t(preset.id)` (`filters.preset_pseudo`, `filters.preset_base_item`, `filters.preset_exact`, roman numerals), active one has gradient bg; click switches preset.
- [ ] **PC-H02** Stat rows are inside a `<form @submit.prevent>` with a hidden `<input type=submit>` ⇒ **Enter in any min/max input triggers search**.
- [ ] **PC-H03** List = non-hidden filters; when "hidden" toggle on, list = **only hidden** filters. Row key `tag + "/" + text`.
- [ ] **PC-H04** Empty state `filters.empty` (border-bottom row) when nothing visible and no unknown mods.
- [ ] **PC-H05** Unknown modifiers (if `unknownModifiers.length` && not Sentinel && not unique Map): row with `fa-exclamation-triangle` (orange), text (truncated, full on hover), `t(stat.type) — t("Not recognized modifier")`, ReloadTradeData button at right.
- [ ] **PC-H06** Missing fractured warning (fractured item, base-item preset active, no Fractured stats): `t("Unable to determine fractured stat")`, `t("filters.tag_explicit") —` and a hidden "Bug Report" link (forum thread 3891367, `target=_blank`, class `hidden`).
- [ ] **PC-H07** Bottom bar: "collapse" button `filters.collapse` + chevron-up (w-40) → collapses list; toggle "show hidden" only when some filters are hidden, label `filters.hidden_explicit_toggle` (Map/Waystone) or `filters.hidden_toggle`; toggle "mods" `filters.mods_toggle` (shows source info on hover). `showHidden` and collapse reset on item change; "mods" toggle persists across items within the session.
- [ ] **PC-H08** FilterModifier row (`FilterModifier.vue`): checkbox icon (`far fa-square` gray when disabled / `fas fa-check-square`) + text; clicking the row button toggles `disabled`; **keyboard activation (`e.detail === 0`, e.g. Enter/Space on the focused button) emits `submit` instead** (`:283-289`).
- [ ] **PC-H09** Text: for internal trade ids (`INTERNAL_TRADE_IDS`) uses `t(tradeId[0], ["#","#"])`, else `filter.text`; `#` placeholders rendered with the roll value in white Exo2 semibold (`ui/ItemModifierText.vue`, split regex `/(?<![#])[+-]?[#]/gm`); truncated single line with full text overlay on hover (`.search-text-full`, `bg-gray-700`). Short text: Time-Lost jewels strip `TIMELESS_SMALL_PASSIVES`/`TIMELESS_NOTABLE_PASSIVES` templates to the captured part; "Grants Skill" prefix (`CLIENT_STRINGS.GRANTS_SKILL`) stripped.
- [ ] **PC-H10** Min/max inputs (`:55-82`) shown when `roll != null && !oils`: `w-12`, placeholders `t("min")`/`t("max")`, `min/max` attrs = bounds, `step` 0.01 if `dp` else 1; **focus on empty ⇒ fill with default min/max, select text; focus ⇒ enable filter**; right mouse-down ⇒ clear + focus; wheel stopped; focused ⇒ cursor hidden.
- [ ] **PC-H11** Augment notice icon (`editorAdded.icon`, 404 icon if `%NOT_FOUND%`) when the stat came from an editor-added augment/catalyst.
- [ ] **PC-H12** Q20 notice chip `t("item.prop_quality",[max(20, quality)])` for `item.armour/evasion_rating/energy_shield/total_dps/physical_dps` on modifiable items.
- [ ] **PC-H13** Hidden indicator: `fa-eye-slash` (gray, `faa-ring` shake animation if the hidden filter is enabled) with popover (placement `right-start`, boundary `#price-window`, max-width 18.5rem) showing `t(filter.hidden)` reason.
- [ ] **PC-H14** Tag chip (`showTag`: not Property, not has_empty_modifier, not Chronicle/Mirrored Tablet/Filled Coffin, not unique explicit/pseudo): `t("filters.tag_" + tag.replace("-","_"))` + `" x N"` when N>1 sources; colours: variant yellow, eldritch red→blue gradient, influence/delve/veiled/incursion icon prefixes, corrupted red, fractured yellow-400/black, crafted/synthesised/rune blue, skill/implicit/explicit plain gray, scourge orange, enchant purple, pseudo gray-700, added-rune blue diagonal stripes, sanctum bordered, desecrated green-900, mutated rose-900.
- [ ] **PC-H15** Tier chips (`FilterModifierTiers.vue`): for each source with a tier (not Map/Tablet): for Explicit/Desecrated/Fractured/Crafted/Pseudo/Property on non-jewel/cluster/memory-line items: T1 (yellow bg) / T2 (yellow border) / T3+ (gray, only if `alwaysShowTier`); for other tags tier ≥2 ⇒ gray "not-tier-1" chip. Sorted ascending. Text `t("filters.tier",[tier])`.
- [ ] **PC-H16** Empty-affix options (`FilterModifierItemHasEmpty.vue`) for `item.has_empty_modifier`: buttons `item.has_empty_affix` / `item.has_empty_prefix` / `item.has_empty_suffix` (only those with count>0), selected bordered; click ⇒ option, enable, roll = `{value:min:count, max:undefined}`.
- [ ] **PC-H17** Elemental DPS options (`FilterModifierItemIsElemental.vue`) for `item.elemental_dps`: buttons for `item.has_elemental_affix` (any) / fire / cold / lightning present in `elementalInfo` (coloured text fire `#c80000`, cold `#5aadff`, lightning `#ffff00`; selected border in that colour); **left click** ⇒ select option + enable + use that element's DPS roll (with min default); **right click** (`contextmenu.prevent`) ⇒ same but clears min/max (only restricts element type).
- [ ] **PC-H18** Range slider (`ui/StatRollSlider.vue`, 12.5rem) when `roll.bounds` (uniques): shows bounds (inclusive bound in black), fill for min/max/range, tick at current roll; **mousedown + drag** (only in min-only or max-only mode) sets value (floor for min / ceil for max, dp aware) with blue popup; on mouseup emits ⇒ sets min or max, enables filter, focuses the corresponding input (`FilterModifier.vue:233-252`); window blur ends drag.
- [ ] **PC-H19** Anointment block (`FilterModifierAnointment.vue`) right of row when `filter.oils`: oil icons (32 px, title=name) + summed poe.ninja price of oils (`ItemQuickPrice` with currency text; `?` if any oil unpriced).
- [ ] **PC-H20** Source info dropdown (`SourceInfo.vue`) shown **on row hover** when "mods" toggle on and `showSourceInfo` conditions hold (`:368-381`): absolutely positioned under the row, gradient bg, per source `t("item.mod_<type>")` + `"name"` + `(t("item.mod_tier",[tier]))` + `(t("item.mod_rank",[rank]))` in italic gray; each stat line (non-contributing struck through) and a contribution box (value × −1 if negated, rounded).

### I. Search / pre-search area — `CheckedItem.vue`
- [ ] **PC-I01** Before search: Search button (`t("Search")`, min-width 5rem) + hover-through trick (§1.3); on the right `TradeLinks` (only for `tradeAPI==="trade"`) using a `?q=<JSON>` URL (`makeTradeLink`, `:355-357`): `https://<poeWebApi()>/trade2/search/poe2/<league>?q=<JSON.stringify(createTradeRequest(...))>` (JSON not URI-encoded).
- [ ] **PC-I02** Filter change after a search ⇒ results disappear, Search button returns (§1.2).
- [ ] **PC-I03** Online-filter changes after a search ⇒ automatic re-search.

### J. Trade listing — `trade/TradeListing.vue`, `TradeItem.vue`, `TooltipItem.vue`
- [ ] **PC-J01** Header: `t("trade_result.matched")` + `...` while loading or `total` + `"+"` if `inexact`; `OnlineFilter` (by-time, api trade); spacer; `TradeLinks` with link to the search id (`/trade2/search/poe2/<league>/<searchId>`) once a result exists.
- [ ] **PC-J02** Table (striped `#353f52` odd rows, sticky headers): Price; Stock (if item has stack); Item level (if ilvl filter exists); Gem level (gem or uncut gem); Gem sockets (gem or `GRANTS_REAL_SKILL` category); Quality (if quality filter enabled, or gem); Listed (full width unless seller column); Seller (if `showSeller`).
- [ ] **PC-J03** Always 20 rows: placeholder rows (`***` transparent) until 900 ms artificial slowdown passes (`artificialSlowdown(900)` reset per item) and while fewer results.
- [ ] **PC-J04** Row (`TradeItem.vue`): `"{amount} {currency}"` + `" ({normalizedPrice} {abbrev})"` when the listing currency differs from the normalized core currency and isn't divine; `× n` badge if `listedTimes > 2`, else `fa-question` icon if listing has no price note; stack size; ilvl; gem level; gem sockets; quality (blue); status dot (`instantBuyout` none / `online` pink / `offline` red / `afk` orange / `rank-2` blue / `rank-3` yellow) + relative date (luxon); badges: `You` (isMine), `in demand` (yellow), `Gone` (red border) — in the Listed column when seller hidden; seller column shows `ign` or `accountName` per `showSeller`, `You` badge, `in demand`.
- [ ] **PC-J05** Grouping (`trade-api.ts:23-49`): consecutive listings by the same account with the same price, or by same account within the last 2 groups, merge (stack sum or `listedTimes++`). Fetches 2×10 in parallel then more until enough non-grouped results.
- [ ] **PC-J06** Hover tooltip with an in-game style item card (`TooltipItem.vue`): tippy placement **left**, interactive, arrow, no delay/animation, theme `item-tooltip` (transparent). Mode by `itemHoverTooltip`: `off` none; `keybind` (default) **only while Shift is held** (window keydown/keyup "Shift" enable/disable + show if hovered); `always` on hover. Content rendered only after first hover. Card: icon with sockets grid (`UiDetailedItemImg`, rune/soulcore/talisman/jewel socket images), title header images per rarity (normal/magic/rare/unique, runic variants for frameType 12-14), sections nameBlock/itemProps/enchant/rune/grantSkill/implicit/explicit(fractured+explicit+desecrated+mutated+veiled)/pseudo/item tags with rarity separators, numeric colours by `number-color-<n>` (incl. 8729-8733), tier label (blue for `S…` suffix, red for `P…` prefix); some props strip trailing `%` word (`STRIP_PERCENT_MODS`).
- [ ] **PC-J07** "Likely price fixed" notice (>15 grouped results and <5 priced in chaos/exalted/divine or cheap aug/regal/transmute <30): `trade_result.likely_price_fixed` + button `trade_result.filter_exalt_divine` (`fa-history`) ⇒ sets `trade.currency = "exalted_divine"` ⇒ auto re-search.
- [ ] **PC-J08** Extraction value notice (§P) under the table.
- [ ] **PC-J09** Error box: `trade_result.error`, `Error: <msg>`, fix hint `trade_result.fix_complex_query` when message starts with `"Query is too complex."`; actions `Retry` (re-run search) and `Browser` (**always builtin browser** `showBrowser(makeTradeLink())` — ignores `builtinBrowser` setting).

### K. Bulk exchange — `trade/TradeBulk.vue`
- [ ] **PC-K01** Header: `matched` + three currency buttons (exalted `/images/exa.png`, chaos `/images/chaos.png`, divine `/images/divine.png`, grayscale icons) each with result total or `?`; selected one has `btn` bg, others transparent; `OnlineFilter` (api bulk); `TradeLinks`.
- [ ] **PC-K02** Initial currency tab: `coreCurrency === "exalted" ? exalted : chaos`; after results arrive: no divine total ⇒ core; no exalted or no chaos total ⇒ divine; else divine if divine total > core total else core (`:228-249`).
- [ ] **PC-K03** Table (8 rows, placeholders until 900 ms slowdown): Price = `exchangeAmount/itemAmount` (4 dp); `"<exchange> / <items>"` with header `exalt|chaos|div / bulk`; Stock; Fulfill = `floor(stock/itemAmount)` with warning icon if `stock < itemAmount`; Listed (status dot + relative date + `You`); Seller.
- [ ] **PC-K04** Trade link: `/trade2/exchange/poe2/<league>?q=<JSON {exchange: query}>` with `have = ["divine"|"exalted"|"chaos"]` per selected tab (`:251-262`).
- [ ] **PC-K05** Error box `Retry` / `Browser`: Browser opens the exchange link with `have=["mirror"]` — builtin browser if `builtinBrowser && isElectron`, else `window.open`.

### L. Online filter popover — `trade/OnlineFilter.vue`
- [ ] **PC-L01** Button (`fa-history` + `Instant` | `Offline` | `Online` by listingType `securable` | `any` | other) + `, <league>` if the filter league differs from selected league; **orange** when `listed ∈ {1day,3days,1week}` or a currency restriction is set.
- [ ] **PC-L02** Popover (hover, delay [80,null], bottom-start, boundary `#price-window`): trade api radios `available` ("Instant or Online"), `securable` ("Instant"), `online`, `any` (`online_filter.offline_toggle`); bulk api radios `onlineleague` (`online_filter.in_league_toggle`), `online`, `any`. Trade only (byTime): listed any/1day/3days/1week/2weeks/1month/2months. Second column: league radios (all trade leagues), trade only: currency any / exalted / chaos / divine / exalted_divine. Defaults: trade `securable`, bulk forced `online`.

### M. Trade links — `trade/TradeLinks.vue`
- [ ] **PC-M01** If builtin browser enabled (`Host.isElectron && builtinBrowser`): two buttons — `t("Trade")` opens in builtin browser, external-link icon opens externally; else one button `Trade <external icon>` opening externally via `window.open(link)`.

### N. Price trend (poe.ninja) — `trends/PriceTrend.vue`
- [ ] **PC-N01** Data from `findPriceByQuery(getDetailsId(item))` (poe.ninja dense DB downloaded via `/proxy/api.exiledexchange2.dev/proxy/<league>/overviewData.json`). Price = `autoCurrency(primaryValue, coreOnly = refName==="Divine Orb")`.
- [ ] **PC-N02** For non-valuable bases, 800 ms "getting price" spinner first (`trade_result.getting_price` + `:getting_price_from`).
- [ ] **PC-N03** Volume block (if `volume` and `currencyVolume !== "none"`): currency/hour with core-currency icon (`value`/`both`), items/hour with item icon (`item`/`both`); click ⇒ open poe.ninja page.
- [ ] **PC-N04** Price: `ItemQuickPrice` (fraction display `1 / N` when a stack filter exists; item image sized by base w/h; divine prices golden `#e4c29a`); for valuable bases (N/M/R accessories/armour/weapons/quivers) the image slot shows `trade_result.base_item` text.
- [ ] **PC-N05** Trend block (if sparkline data ≥2 points): arrow up (green) / down (red) / `±` with `round(stddev*2) %`, label `trade_result.graph_7d`, 48×32 apexcharts area sparkline (smooth, no animation/tooltip, gray); click ⇒ open poe.ninja URL `https://poe.ninja/poe2/economy/<league slug>/<url>/<detailsId>`. Forecast up/down if 7 points and ≥4 positive/negative or last 3 all positive/negative.
- [ ] **PC-N06** `trade_result.highest_volume` + currency icon when volume info exists.
- [ ] **PC-N07** No price but not craftable ⇒ `?` price with currency text.

### O. Related items — `related-items/RelatedItems.vue`
- [ ] **PC-O01** Query id `"<ns>::<name>[ // <variant>]"` from `getDetailsId`; looks up `ITEM_DROP` (`item-drop.json` from `api.exiledexchange2.dev/proxy/data/item-drop.json`) entry whose `query` contains it; left column lists `query` items (current one highlighted `bg-gray-700`), right column `items`; each with price (fraction, currency text) and gray name; error text `Can't find "<id>".`.
- [ ] **PC-O02** Box: `bg-gray-800 text-gray-400 mt-6`, 0.25rem `gray-900` border, max-width `min(100%,24rem)`, rounded + inner shadow on the side away from the panel (`.inventory` / `.stash`).

### P. Extraction value — `trade/ExtractionValue.vue`
- [ ] **PC-P01** Shown only when the first listing's normalized price < (sum of poe.ninja prices of current augments − price of "Orb of Extraction" [99999 div if unknown]): red border, `Σ [rune img] augments − [extractor img] orb = profit`.

### Q. Rate limiter — `trade/RateLimiterState.vue`
- [ ] **PC-Q01** "Rate limiting" tab (absolute, bottom of screen, `mx-6`, rounded top) next to the panel; red + `shakeX` (animate.css) when any queue is non-empty.
- [ ] **PC-Q02** Click toggles persisted `showRateLimitState`; popup lists policies `trade-search-request-limit`, `trade-exchange-request-limit`, `trade-fetch-request-limit` (red if queued) with `active / max over window s (queue: n)`.

### R. Item editor
- [ ] **PC-R01** `getItemEditorType` (`item-editor/item-editor.ts:7-28`): none for Unique or no category; Ring/Amulet/Jewel ⇒ Catalyst; weapon/armour ⇒ Augment; else none. FiltersBlock: non-modifiable items get the editor only if they have augments (`FiltersBlock.vue:374-383`). `AugmentAndCatalyst` branch is unreachable placeholder text.
- [ ] **PC-R02** AugmentEditor (`AugmentEditor.vue`): socket row (6-col grid) of current augments (empty → `/images/augments/empty-socket.png`; `title` = name; socket-bound ones red border, not-allowed); clicking a socket with a selected augment ⇒ `useAugment(item, selected, index)` mutates the item (removes all augment mods, re-adds from socket list, added ones typed `added-rune`, recomputes properties) ⇒ filters rebuilt (§1.2) and added stats show augment icon + striped `added-rune` tag. Right: arrow + `ItemSumPrice` of all socketed augments (poe.ninja, truncated large numbers).
- [ ] **PC-R03** Tabs (UiTabs): main `Rune | Soul Core | Idol | Legacy | Other`; Rune sub-tabs `Lesser | Normal | Greater | Perfect | Other` (default **Greater**); Soul Core `Normal | Special`. Lists (`AugmentsList`, max-h 24rem scroll) of editor items (icon, gray name, multi-line stat text), selected bordered. Default selected augment = "Greater Iron Rune". Groups cached per category; cache cleared on language change.
- [ ] **PC-R04** Save row: `t("item_editor.save_type")` select: `class` (item category label), `casterWeapon` (Wand/Staff), `maritalWeapon` (martial weapons), `armour`, `all`; buttons `item_editor.clear` (red hover; `savedAugments[key] = []`) and `item_editor.save` (green hover; `savedAugments[key] = augments.map(refName|null)`). Saved augments are pre-applied by the parser to items whose sockets are all empty (`parser/augment-builder.ts:81-117`, `parser/Parser.ts:1384-1393+`, condition: all sockets empty and item not Unique). (`confirm` state never used.)
- [ ] **PC-R05** QualityEditor (`QualityEditor.vue`, only modifiable Catalyst items): amount buttons `0,20,30,40,50` (Breach Ring `0..70` default 40; Jewel `0,20`; default 20); price = catalyst poe.ninja price × amount (ItemQuickPrice with catalyst icon); list of catalysts (`CATALYST_TYPES.Normal` or `.Refined` for jewels) showing affected tags; selecting a catalyst or changing amount ⇒ `applyCatalyst(item, catalyst, amount)` mutates item (removes old catalyst incr, adds `rollIncr`, `addedIncr`, recomputes) ⇒ filters rebuilt; affected stats show catalyst icon. Selection resets on new item.

### S. Tips & support links — `CheckedItem.vue:288-322`, `web/help/Tip.vue`, `web/help/tips.ts`
- [ ] **PC-S01** Module-level counters (persist for app lifetime): support counter starts 0, tip counter starts 15. Every 13 items (and when not searched or bulk) show dashed box `app.thanks_3rd_party` with link `https://poe.ninja/support` (`target=_blank`).
- [ ] **PC-S02** Otherwise tips: if `tipsFrequency !== Never` and (Always or counter ≥ `TIP_FREQUENCY_MAP[freq]` = {Always 1, MoreOften 7, Normal 20, Rarely 50, VeryRarely 100}) and not searched ⇒ random tip 1..29: header `settings.tip_number_header` [n] + `tips.tip_<n>`.

### T. Background info — `BackgroundInfo.vue`
- [ ] **PC-T01** Update notice (`update-downloaded` / `update-available` with noDownloadReason) — updater dropped ⇒ backend reports `{state:"initial"}` ⇒ nothing shown.
- [ ] **PC-T02** `app.leagues_loading` while leagues load; error box `app.leagues_failed` / `app.leagues_failed_help` with `Retry` (`leagues.load`) and `Browser` (**builtin browser** to `https://<poeWebApi()>/api/trade2/data/leagues` — Cloudflare captcha solver; relies on shared cookies, §5.2).

### U. Settings page — `settings-price-check.vue` (shown in Settings window)
- [ ] **PC-U01** League: `price_check.league` + `Refresh` (disabled while loading); radio list of trade leagues (`league.text`); "Private league" text input (`settings.private_league`, placeholder `My League (PL12345)`) — shows `leagueId` only when it is not in the list; writes `leagueId`. Leagues error ⇒ `app.leagues_failed_help_alt` + `Retry`.
- [ ] **PC-U02** `settings.account_name` input (`accountName`, `font-poe`).
- [ ] **PC-U03** Show seller radios: No / `settings.account_name` (`"account"`) / `settings.last_char_name` (`"ign"`) + hint `price_check.highlight_hint`.
- [ ] **PC-U04** Fill rolls `±[n]%` (accepts number 0..50 only) + radio `fill_roll_exact` (=0).
- [ ] **PC-U05** Core currency radios with icons from `availableCoreCurrencies` (exalted/chaos), bg selection style.
- [ ] **PC-U06** Checkboxes: `remember_currency`, `remember_listing` (+ italic note `remember_listing_note`), `select_stock` (activateStockFilter).
- [ ] **PC-U07** Show volume radios: None / `Currency / Hour` / `Items / Hour` / `Both` (`currencyVolume`).
- [ ] **PC-U08** `show_prediction` checkbox (requestPricePrediction, poeprices.info) — feature dead ⇒ hide in port.
- [ ] **PC-U09** `cursor_pos` checkbox (showCursor).
- [ ] **PC-U10** Tooltip hover radios: `use_tooltip_off` / `use_tooltip_keybind` / `use_tooltip_always` (`itemHoverTooltip`).
- [ ] **PC-U11** `default_all_selected`, `always_show_tier` checkboxes.
- [ ] **PC-U12** `enable_browser` checkbox (builtinBrowser), orange box + `builtin_browser_warning` when on (decide per §5.2).
- [ ] **PC-U13** "Expensive" box (`warn_expensive`): `accurate_collapsed` checkbox (`collapseListings` values `['app','api']` — checked = `app`); auto-search toggles labelled with the actual hotkeys (`<hold> + <key>` → `smartInitialSearch`; `hotkeyLocked` → `lockedInitialSearch`), each only if that hotkey is set; extra delay `apiLatencySeconds` input clamped to [0.5, 10] s.
- [ ] **PC-U14** "Advanced" box (`warn_advanced`): `initial_delay` ms clamped [5, 400] (`initialDelay`, sent to host in `HostConfig.initialDelay` — delay before reading clipboard after the copy keystroke).
- [ ] **PC-U15** Hotkeys page (`settings/hotkeys.vue:46-67`): `price_check.hotkey` = mod key (`hotkeyHold`, Ctrl/Alt) + key (`hotkey`, default D); `price_check.hotkey_locked` (default `Ctrl + Alt + D`).

### V. Keyboard / mouse interaction summary (verify each in the port)
- [ ] **PC-V01** Quick check (hold `Ctrl` + `D`): panel opens read-only-ish; moving the mouse > 2.5rem away **without holding Ctrl** before entering the panel closes it; holding Ctrl and moving into the panel activates it; while active, leaving the panel area returns focus to the game (and closes); clicking inside the panel keeps it open until blur (`main/src/windowing/WidgetAreaTracker.ts:71-95`).
- [ ] **PC-V02** Locked check (`Ctrl + Alt + D`): panel opens focused (`focusOverlay:true`); `advancedCheck` uses `lockedInitialSearch`.
- [ ] **PC-V03** Enter in inputs ⇒ search; Enter/Space on a focused stat row button ⇒ search (not toggle).
- [ ] **PC-V04** Right-click on any numeric input ⇒ clear value (no context menu!). Right-click on elemental option ⇒ "type only" selection.
- [ ] **PC-V05** Slider drag; wheel over inputs does not scroll the panel.
- [ ] **PC-V06** Shift held over a listing row ⇒ item tooltip (keybind mode).
- [ ] **PC-V07** Mouse sweep from filters onto Search ⇒ search.
- [ ] **PC-V08** Hover popovers: hidden reason, item editor (0/500 ms), online filter (80 ms); click popovers: exchange rate.
- [ ] **PC-V09** Escape closes; overlay key toggles focus; close button closes.
- [ ] **PC-V10** Links: Trade (external/builtin), poe.ninja (trend/volume click), poe.ninja support link, error "Browser" buttons.

### W. Dropped / dead features (do not port, or port as no-op)
- Price prediction (poeprices.info): component commented out; `requestPricePrediction` default false and force-reset to false in `Config.ts:370`.
- `FilterBtnDropdown.vue`, `ItemEditorButton.vue`, `fill-augments.ts` apply/remove functions, `itemEditorSelection`/`tempAugmentStorage` plumbing, `item-editor-selection` emit, TradeListing `isShiftPressed`/`addedAugments`, `ItemSumPrice` import in TradeListing (commented block), Patreon link (commented).

---------------------------------------------------------------------------------------------------

## 3. Import dependency graph (everything imported from outside `web/price-check`)

Packages are in §4. "line" = line of the `from` clause.

### 3.1 `@/parser` and submodules
| Importer:line | Module | Symbols |
|---|---|---|
| `CheckedItem.vue:74` | `@/parser` | ItemRarity, ItemCategory, ParsedItem |
| `PriceCheckWindow.vue:152` | `@/parser` | ItemCategory, ItemRarity, parseClipboard, ParsedItem |
| `filters/FilterModifier.vue:162` | `@/parser` | ItemCategory, itemIsModifiable, ItemRarity, ParsedItem |
| `filters/FilterModifierTiers.vue:15` | `@/parser` | ItemCategory, ParsedItem |
| `filters/FilterName.vue:29` | `@/parser` | ParsedItem (type) |
| `filters/FiltersBlock.vue:312` | `@/parser` | ParsedItem, ItemRarity, ItemCategory, itemIsModifiable |
| `filters/FiltersBlock.vue:314` | `@/parser/modifiers` | ModifierType |
| `filters/FiltersBlock.vue:317` | `@/parser/meta.js` | ItemEditorType |
| `filters/SourceInfo.vue:23,25` | `@/parser/advanced-mod-desc`, `@/parser/modifiers` | applyIncr; StatCalculated (type) |
| `filters/UnknownModifier.vue:29` | `@/parser` | ParsedItem |
| `filters/common.ts:6,7` | `@/parser`, `@/parser/modifiers` | ItemCategory, itemIsModifiable, ItemRarity, ParsedItem; EXPLICIT_MOD_TYPES, ModifierType |
| `filters/create-item-filters.ts:2,4,7` | `@/parser`, `@/parser/modifiers`, `@/parser/meta` | ParsedItem, ItemCategory, ItemRarity; ModifierType; ARMOUR, GEM, WEAPON |
| `filters/create-presets.ts:6,7` | `@/parser/modifiers`, `@/parser` | sumStatsByModType; ItemCategory, ItemRarity, ParsedItem |
| `filters/create-stat-filters.ts:6,13,29` | `@/parser`, `@/parser/modifiers`, `@/parser/Parser` | ParsedItem, ItemRarity, ItemCategory, itemIsModifiable; ModifierType, StatCalculated, StatRoll, statSourcesTotal, translateStatWithRoll; getMaxSockets |
| `filters/create-unique-filters.ts:1,2` | `@/parser`, `@/parser/modifiers` | ParsedItem; ModifierType, StatCalculated |
| `filters/fill-augments.ts:1,3,5,6,15,17` | `@/parser`, `@/parser/calc-base`, `@/parser/Parser`, `@/parser/modifiers`, `@/parser/advanced-mod-desc`, `@/parser/meta` | ItemCategory, ItemRarity, ParsedItem; applyEleAugment, recalculateItemProperties; parseModifiersPoe2, replaceHashWithValues; ModifierType, sumStatsByModType; ADDED_AUGMENT_LINE; ItemEditorType |
| `filters/interfaces.ts:2,3,4` | `@/parser`, `@/parser/modifiers`, `@/parser/ParsedItem` | ItemInfluence, ItemCategory; StatCalculated; ParsedItem (types) |
| `filters/pseudo/anointments.ts:1,2` | modifiers, parser | ModifierType, StatCalculated; itemIsModifiable, ParsedItem |
| `filters/pseudo/atzoatl-rules.ts:2` | `@/parser/ParsedItem` | IncursionRoom |
| `filters/pseudo/index.ts:8,15` | `@/parser/modifiers`, `@/parser/stat-translations` | ModifierType, StatCalculated, StatSource; tryParseTranslation |
| `filters/pseudo/item-property.ts:10,12,13,14` | `@/parser/calc-q20`, `@/parser/meta`, `@/parser`, `@/parser/modifiers` | calcPropBounds, propAt20Quality, QUALITY_STATS; ARMOUR, WEAPON, ItemCategory; ParsedItem; ModifierType, StatRoll, StatSource |
| `item-editor/AugmentEditor.vue:171,185,186,190` | parser, ParsedItem, augment-builder, meta | ItemCategory, ParsedItem; EditorItem; buildEditorItems; ARMOUR, MARTIAL_WEAPON |
| `item-editor/AugmentsList.vue:19`, `ItemEditorItem.vue:26` | `@/parser/ParsedItem` | EditorItem |
| `item-editor/ItemEditorV2.vue:18,23` | parser, meta | ParsedItem; ItemEditorType |
| `item-editor/QualityEditor.vue:49,50,51` | parser, meta, ParsedItem | ItemCategory, ParsedItem; ItemEditorType; EditorItem, itemIsModifiable |
| `item-editor/augment.ts:2,3,8,9,10,11` | parser, augment-builder, modifiers, ParsedItem, Parser, calc-base | ItemCategory, ParsedItem; buildEditorItems; INTERNAL_AUGMENT_TYPES, ModifierType, sumStatsByModType; EditorItem; parseStatsFromMod; recalculateItemProperties |
| `item-editor/item-editor.ts:2,3,4,5` | parser, calc-base, meta, modifiers | ItemRarity, ParsedItem; recalculateItemProperties; ARMOUR, ItemCategory, ItemEditorType, WEAPON; sumStatsByModType |
| `price-prediction/*` | `@/parser` | ParsedItem |
| `related-items/RelatedItems.vue:54`, `stack-value/StackValue.vue:28`, `unidentified-resolver/UnidentifiedResolver.vue:31` | `@/parser` | ParsedItem (+ItemRarity in resolver) |
| `trade/ExtractionValue.vue:34`, `TradeBulk.vue:176`, `TradeListing.vue:148,155`, `TradeItem.vue:116,123,125` | parser, ParsedItem, meta | ParsedItem, ItemCategory; GEM, GRANTS_REAL_SKILL |
| `trends/PriceTrend.vue:149`, `trends/getDetailsId.ts:1,3` | parser, meta | ParsedItem, ItemRarity, ItemCategory; ACCESSORY, ARMOUR, GEM, WEAPON |

Reverse deps into price-check: `parser/Parser.ts:46` (`useAugment` from `item-editor/augment`), `web/ui/StatRollSlider.vue:43` and `web/map-check/prepare-map-stats.ts:3` (`filters/util`), `web/overlay/widget-registry.ts:6` (PriceCheckWindow), `web/settings/SettingsWindow.vue:135` (settings-price-check), `web/overlay/DevWidget.vue:24-27` (dev only).
Also `parser/augment-builder.ts:83` reads `AppConfig("price-check").savedAugments` ⇒ **the parser depends on the renderer Config** (cannot be moved to the Bun backend without a shim).

### 3.2 `@/assets/data`
| Importer:line | Symbols |
|---|---|
| `PriceCheckWindow.vue:164` | loadUltraLateItems |
| `filters/FilterModifier.vue:166` | CLIENT_STRINGS (as `_$`: TIMELESS_SMALL_PASSIVES, TIMELESS_NOTABLE_PASSIVES, GRANTS_SKILL) |
| `filters/FilterModifierAnointment.vue:24` | ITEM_BY_REF |
| `filters/FiltersBlock.vue:318` | CATALYST_TYPES (`@/assets/data/index.js`) |
| `filters/create-item-filters.ts:5` | BaseType, ITEM_BY_REF |
| `filters/create-stat-filters.ts:27` | StatBetter, CLIENT_STRINGS (DELVE_MODS, VEILED_MODS, INCURSION_MODS), CATALYST_TYPES |
| `filters/fill-augments.ts:4` | BaseType, ITEM_BY_REF, AUGMENT_DATA_BY_AUGMENT |
| `filters/interfaces.ts:1` | BaseType |
| `filters/pseudo/index.ts:6` | stat, STAT_BY_REF |
| `filters/pseudo/item-property.ts:11` | stat, StatBetter |
| `item-editor/AugmentEditor.vue:170` | AugmentGroup, GROUPED_AUGMENTS, ITEM_BY_REF |
| `item-editor/QualityEditor.vue:48` | BaseType, CATALYST_TO_TAG, CATALYST_TYPES |
| `item-editor/augment.ts:1`, `item-editor/item-editor.ts:1` | AugmentGroup, BaseType; BaseType, CATALYST_TO_TAG |
| `related-items/RelatedItems.vue:51` | BaseType, ITEM_BY_REF |
| `trends/getDetailsId.ts:4` | TRADE_TAG_TO_REF |
| `unidentified-resolver/UnidentifiedResolver.vue:30` | BaseType, ITEMS_ITERATOR |
| `ui/ItemQuickPrice.vue:63`, `ui/ItemSumPrice.vue` | ITEM_BY_REF, BaseType |

Data files (served statically): `renderer/public/data/<lang>/{items.ndjson, stats.ndjson, *.index.bin, client_strings.js, app_i18n.json}`, `renderer/public/data/item-drop.json(c)` (local copy; runtime uses the remote one). Item icons are **remote** `https://web.poecdn.com/...` URLs (445 items have `%NOT_FOUND%` → `/images/404.png`).

### 3.3 `@/web/Config`
`AppConfig`, `TipsFrequency` (`CheckedItem.vue:90`), `AppConfig` (`PriceCheckWindow.vue:151`, `FilterModifier.vue:156`, `FilterModifierTiers.vue:17`, `fill-augments.ts:12`, `AugmentEditor.vue:184`, `QualityEditor.vue:56`, `PriceTrend.vue:152`, `TradeListing.vue:145`, `TradeItem.vue:122`, `TradeBulk.vue:174`, `TradeLinks.vue:31`, `RateLimiterState.vue:35`), `poeWebApi` (`BackgroundInfo.vue:25`; re-exported as `getTradeEndpoint` by `trade/common.ts:7`). `poeWebApi()` (`Config.ts:91-116`): `preferredTradeSite==="www"` ⇒ `www.pathofexile.com`; by language en→www, ru→ru., cmn-Hant→`pathofexile.tw` (garena) / www, ko→`poe.kakaogames.com`, ja→jp., de→de., es→es., pt→br., fr→fr.

### 3.4 `@/web/background/*`
| Importer:line | Module | Symbols / usage |
|---|---|---|
| `PriceCheckWindow.vue:148` | IPC | MainProcess, Host — `onEvent("MAIN->CLIENT::item-text")`, `onEvent("MAIN->OVERLAY::hide-exclusive-widget")`, `sendEvent("OVERLAY->MAIN::track-area")`, `sendEvent("OVERLAY->MAIN::focus-game")`, `isElectron` |
| `BackgroundInfo.vue:24` | IPC | `Host.updateInfo` |
| `fallback/ReloadTradeData.vue:35` | IPC | `Host.selfDispatch` |
| `trade/TradeLinks.vue:30`, `trade/TradeBulk.vue:181` | IPC | `Host.isElectron` |
| `price-prediction/poeprices.ts:3` | IPC | `Host.proxy` (dead feature) |
| `PriceCheckWindow.vue:149` | Prices | `usePoeninja()` → xchgRate, xchgRateCurrency, initialLoading, queuePricesFetch |
| `FilterModifierAnointment.vue:23`, `QualityEditor.vue:55`, `PriceTrend.vue:145`, `RelatedItems.vue:52`, `StackValue.vue:26`, `ExtractionValue.vue:38`, `settings-price-check.vue:250`, `ui/ItemSumPrice.vue`, `ui/ItemQuickPrice.vue` | Prices | findPriceByQuery, autoCurrency, displayRounding, CurrencyValue, ITEM_DROP, availableCoreCurrencies, comparePrice, subtractPrice, xchgRate |
| `PriceCheckWindow.vue:150`, `CheckedItem.vue:93`, `BackgroundInfo.vue:23`, `settings-price-check.vue:248`, `trade/OnlineFilter.vue:125`, `poeprices.ts:2` | Leagues | `useLeagues()` → selectedId, list, isLoading, error, load |
| `fallback/ReloadTradeData.vue:33` | TradeData | `useTradeData()` → load(force), isLoading |

### 3.5 Other web modules
| Importer:line | Module | Symbols |
|---|---|---|
| `PriceCheckWindow.vue:163`, `CheckedItem.vue:92`, `PriceTrend.vue:153`, `TradeListing.vue:146`, `TradeBulk.vue:177`, `RateLimiterState.vue:34`, `settings-price-check.vue:247` | `@/web/overlay/interfaces` | PriceCheckWidget, WidgetManager, WidgetSpec |
| `FilterModifierTiers.vue:18`, `fill-augments.ts:13`, `AugmentEditor.vue:189`, `TradeItem.vue:119`, `TradeLinks.vue:32` | `@/web/overlay/widgets` | PriceCheckWidget |
| `PriceCheckWindow.vue:244` | `inject("wm")` from `overlay/OverlayWindow.vue:335-346` | WidgetManager: poePanelWidth, active, widgets, show, hide, setFlag |
| `CheckedItem.vue:85,94` | `@/web/help/Tip.vue`, `@/web/help/tips` | Tip; randomTip, TIP_FREQUENCY_MAP |
| `settings-price-check.vue:241`, `trade/*.vue`, `PriceTrend.vue:140`, `AugmentEditor.vue:188` | `@/web/i18n` | useI18nNs |
| `settings-price-check.vue:246` | `@/web/settings/utils.js` | configModelValue, configProp, findWidget |

### 3.6 `@/web/ui/*`
AppTitlebar (`PriceCheckWindow.vue:157`), Popover/UiPopover (`PriceCheckWindow.vue:145`, `FilterModifier.vue:150`, `FiltersBlock.vue:315`, `FeedbackOption.vue:38`, `OnlineFilter.vue:123`, `TradeListing.vue:141` [registered, unused]), UiErrorBox (`PriceCheckWindow.vue:144`, `BackgroundInfo.vue:27`, `settings-price-check.vue:245`, `PricePrediction.vue:100`, `TradeBulk.vue:171`, `TradeListing.vue:142`), UiToggle (`FiltersBlock.vue:300`, `settings-price-check.vue:244`, `OnlineFilter.vue:122` [unused]), UiCheckbox (`settings-price-check.vue:243`), UiRadio (`settings-price-check.vue:242`, `OnlineFilter.vue:121`), UiTabs (`AugmentEditor.vue:181`), ItemQuickPrice (`PriceCheckWindow.vue:158`, `FilterModifierAnointment.vue:25`, `PricePrediction.vue:103`, `RelatedItems.vue:55`, `ExtractionValue.vue:39`, `TradeListing.vue:150`, `PriceTrend.vue:147`, `QualityEditor.vue:54`), ItemSumPrice (`AugmentEditor.vue:180`, `TradeListing.vue:156` [unused]), StatRollSlider (`FilterModifier.vue:151`), ItemModifierText (`FilterModifier.vue:152`, `SourceInfo.vue:28`, `UnknownModifier.vue:30`), UiItemImg (`PriceTrend.vue:154`, `settings-price-check.vue:251`), CoreCurrencyImg (`PriceTrend.vue:155`), UiDetailedItemImg (`TooltipItem.vue:87`).

Static assets used (`renderer/public/images/`): `404.png, annul.png, chaos.png, divine.png, exa.png, extractor.png, wisdom.png (ItemQuickPrice default), delve.png, incursion.png, veiled.png, influence-{Crusader,Elder,Hunter,Redeemer,Shaper,Warlord}.png, augments/{empty-socket,rune,soulcore,sacredtalisman,primaltalisman,vividtalisman,wildtalisman,blue,red,green}.png, item-display/*.png (21 files)`. `/images/div.png` referenced by `DivCurrency` (`Prices.ts:104-110`) **does not exist**. Global CSS from `web/App.vue`: fontawesome, animate.css, `assets/font.css` (Fontin/FontinSmallCaps/FrizQuadrataC/Exo2 — bundled), `.btn`, `.btn-icon`, `.layout-column`, `.table-stripped`, `.faa-ring`, scrollbar and number-spinner rules, `#app` focus outline reset. Tailwind palette custom (`renderer/tailwind.config.*`: `fire/cold/lightning/normal/magic/rare/unique` colors) — keep config.

---------------------------------------------------------------------------------------------------

## 4. Config keys read/written and their effect

### 4.1 `AppConfig("price-check")` (`PriceCheckWidget`, `web/overlay/widgets.ts:38-64`; defaults `PriceCheckWindow.vue:178-210`)
| Key | Default | Read at | Effect |
|---|---|---|---|
| `wmWants` / `wmFlags` / `wmZorder` | hide / `["hide-on-blur","menu::skip"]` / `"exclusive"` | PriceCheckWindow | visibility, blur behaviour, exclusivity |
| `hotkey` / `hotkeyHold` | `"D"` / `"Ctrl"` | `Config.ts:696-703` (host shortcuts, `keepModKeys`), `PriceCheckWindow.vue:278` (track-area holdKey), settings labels | quick check hotkey `${hold} + ${key}` → `copy-item {target:"price-check", focusOverlay:false}` |
| `hotkeyLocked` | `"Ctrl + Alt + D"` | `Config.ts:704-709`, settings | locked check → `focusOverlay:true` |
| `showSeller` | `false` | TradeListing/TradeBulk/TradeItem | seller column (`"account"` → accountName, `"ign"` → last char) |
| `searchStatRange` | 10 | CheckedItem→createPresets, `fill-augments.ts:95` | ± % default range |
| `showRateLimitState` | false | RateLimiterState (read+write) | rate limit popup open |
| `apiLatencySeconds` | 2 | `trade/common.ts:82` | extra delay for rate limiter |
| `collapseListings` | `"api"` | createPresets → `filters.trade.collapseListings` | trade API collapse vs app-side grouping |
| `smartInitialSearch` | true | CheckedItem:182 | auto-search for quick check |
| `lockedInitialSearch` | true | CheckedItem:183 | auto-search for locked check |
| `activateStockFilter` | false | createFilters stackSize | stock filter enabled by default |
| `builtinBrowser` | false | TradeLinks, TradeBulk | builtin `<webview>` browser |
| `showCursor` | true | PriceCheckWindow:367 | check-position circle |
| `requestPricePrediction` | false | settings only | dead |
| `rememberCurrency` | false | CheckedItem:169 | keep currency filter across items |
| `defaultAllSelected` | false | create-stat-filters | enable all visible stat filters |
| `itemHoverTooltip` | `"keybind"` | TradeItem | off / Shift / always |
| `alwaysShowTier` | false | FilterModifierTiers | show T3+ chips |
| `coreCurrency` | `"exalted"` | TradeBulk, Prices (`selectedCoreCurrency`) | core currency for conversions and default bulk tab |
| `currencyVolume` | `"both"` | PriceTrend | volume display |
| `rememberListingType` | false | CheckedItem:175 | keep listing type across items |
| `initialDelay` | 48 | `Config.ts:840` → HostConfig | ms delay before reading clipboard (backend) |
| `savedAugments` | `{}` | AugmentEditor (write), `parser/augment-builder.ts:83` (read) | keys: ItemCategory string, `casterWeapon`, `maritalWeapon` (written) / `martialWeapon` (read — **mismatch bug**), `armour`, `all` → `Array<refName|null>` |
| `chaosPriceThreshold` | legacy | `Config.ts:360` | upgrade only |

### 4.2 Global `AppConfig()` keys read by price-check
`leagueId` (PriceCheckWindow:233, settings write, Leagues), `accountName` (settings write; trade `isMine`), `language` (`useEn`, AugmentEditor/QualityEditor cache reset, poeWebApi), `realm` (`useEn`, Leagues), `preferredTradeSite` (`useEn`, poeWebApi), `fontSize` (panel width, track-area threshold, FilterModifier unused), `overlayKey` (browser hint), `overlayAlwaysClose` (close behaviour), `tipsFrequency` (tips).

---------------------------------------------------------------------------------------------------

## 5. Third-party libraries (price-check + used ui)

| Package (renderer/package.json) | Used by | Notes |
|---|---|---|
| `vue` 3.2.37 (pinned) | all | Options + `<script setup>`; CSS modules (`$style`), `lang="postcss"` with tailwind nesting |
| `vue-i18n` ^10 | all (`useI18n`, `<i18n-t>` component) | legacy:false, fallback en |
| `tippy.js` ^6.2.7 | `ui/Popover.vue` (theme `light`, `tippy.css` + `themes/light.css`), `trade/TradeItem.vue` (theme `item-tooltip`) | popovers appended to `document.body` → constrained by the page viewport (important for panel-sized surfaces, §6.6) |
| `vue3-apexcharts` ~1.1.1 + `apexcharts` ^4 | `trends/PriceTrend.vue` | sparkline |
| `neverthrow` ^8 | `PriceCheckWindow.vue:142` (Result/ok/err) | parser returns Result |
| `luxon` 3 | `trade/pathofexile-*.ts` (relative dates) | |
| `dot-prop` 9 | `trade/pathofexile-trade.ts` | |
| `object-hash` ^3 | `trade/Cache.ts` | |
| `@vueuse/core` ^11 | `createGlobalState` in Leagues/Prices/TradeData | |
| `sockette` ^2 | `background/IPC.ts` (`ws://<host>/events`) | |
| `fast-deep-equal` | `Config.ts` saveConfig | |
| `@fortawesome/fontawesome-free` 6 | icons everywhere (`fas fa-*`, `far fa-*`, `fa-solid`) | imported in `App.vue` |
| `animate.css` ^4 | RateLimiterState `shakeX` | imported in `App.vue` |
| `tailwindcss` 3 + postcss nesting + autoprefixer | all styles | |
| `vuedraggable` | **not** price-check (stash-search editor, image strip) | |

---------------------------------------------------------------------------------------------------

## 6. Electron / fullscreen-overlay / window.open assumptions → required adaptations

### 6.1 `Host.isElectron` (UA contains "Electron") branches
- `background/IPC.ts:51-53`: when **not** Electron, every `MAIN->OVERLAY::*` listener is silently dropped ⇒ `hide-exclusive-widget` would never close the panel. Port: make "is overlay host" detection explicit (e.g. `navigator.userAgent.includes("QtWebEngine")` or a query param/global injected by the Qt host) and decide per call site.
- `PriceCheckWindow.vue:265` track-area only when Electron; `:397` close path; `TradeLinks.vue:52` builtin only in Electron; `TradeBulk.vue:278`; `OverlayWindow.vue:94` (`active = !isElectron`), `:328-330` (`poePanelWidth = 0` when not Electron), `:276` (always visible when not Electron).

### 6.2 External links and the builtin browser
- External opens: `window.open(url)` in `trends/PriceTrend.vue:245` (poe.ninja), `trade/TradeLinks.vue:59` (trade site), `trade/TradeBulk.vue:281`, `price-prediction/PricePrediction.vue:153` (dead); `<a target="_blank">` in `CheckedItem.vue:51-56` (poe.ninja/support), `FiltersBlock.vue:255-259` (hidden). Electron turns these into `shell.openExternal` via `setWindowOpenHandler` (`main/src/windowing/OverlayWindow.ts:71-74`).
  **Port:** in QtWebEngine `window.open`/`target=_blank` do nothing unless the host handles `QWebEnginePage::newWindowRequested(QWebEngineNewWindowRequest&)` → take `requestedUrl()` → `QDesktopServices::openUrl` (xdg-open) or forward to the backend (`Bun.spawn(["xdg-open", url])`). Doing it in the host needs zero renderer changes. URLs contain raw JSON (`?q={"query":…}`) — pass as a single argv element, never through a shell. Expect Hyprland to move focus to the browser (game loses focus ⇒ panel close rules apply).
- Builtin browser (`provide("builtin-browser", showBrowser)`, `PriceCheckWindow.vue:413-426`; `<webview>` custom element allowed in `renderer/vite.config.*` `isCustomElement`): opens the URL in an Electron `<webview>` that fills the rest of the screen next to the panel; flags switch to `invisible-on-blur`. Callers: TradeLinks (when enabled), TradeBulk error Browser (when enabled), **TradeListing error `Browser` (always)**, **BackgroundInfo leagues-error `Browser` (always, captcha)**.
  The webview shares Electron's `defaultSession` with the main-process proxy (`main/src/proxy.ts:45-54` `useSessionCookies:true`, partitioned-cookie stripping `:77-90`) ⇒ solving the Cloudflare challenge / logging in inside the webview makes `/proxy` requests succeed.
  **Port options:** (a) drop the builtin browser: map `showBrowser(url)` to external open, hide the `enable_browser` setting; (b) keep a captcha path: host opens a normal (xdg_toplevel) `QWebEngineView` window with the persistent profile, captures `pathofexile.com` cookies (`QWebEngineCookieStore::cookieAdded`: `cf_clearance`, `__cf_bm`, `POESESSID`) and sends them to the backend over stdio; the Bun proxy attaches them and uses **the same User-Agent** as `QWebEngineProfile::httpUserAgent()` (cf_clearance is UA-bound). Recommended: (b) for BackgroundInfo/TradeListing "Browser" buttons, (a) for normal Trade links.

### 6.3 Position, side and size come from the fullscreen overlay
- `checkPosition` (screen coords) compared with `window.screenX + window.innerWidth/2` (`:370-379`), CheckPositionCircle uses `position - window.screenX/Y`, track-area area uses `window.screenX/Y/innerWidth/innerHeight`, spacer width `--game-panel = innerHeight*986/1600`. In a panel-sized layer surface all of these are wrong.
  **Port:** backend computes `side: "stash"|"inventory"` from the cursor position (`hyprctl cursorpos`, global logical coords) vs the PoE2 window centre (`hyprctl clients`/activewindow geometry) and sends it with `item-text` (new optional payload field) — renderer uses it instead of the screenX computation; renderer's `poePanelWidth` must be 0 (no spacer); host anchors the layer surface `top|bottom|left` or `top|bottom|right` of the game's output with horizontal margin = `(gameX - outputX) + gameHeight*986/1600` (stash) or the mirrored value (inventory), width = `28.75 * fontSize` + side column (§6.6), height = game height. Fractional scaling: layer-shell sizes are logical px = CSS px at zoom 1.
- CheckPositionCircle (`showCursor`): only drawable with a separate full-output click-through layer surface (`Qt::WindowTransparentForInput` / empty input region) or drop it. It was only shown when the overlay was active.

### 6.4 Focus model (`hide-on-blur`, track-area, overlay key)
Electron flow: quick check shows the panel without focus; `OVERLAY->MAIN::track-area` (`ipc/types.ts:134-143`: `{holdKey, closeThreshold, from:{x,y}, area:{x,y,width,height}, dpr}`) makes main watch global mouse moves (uiohook) to auto-close (`MAIN->OVERLAY::hide-exclusive-widget`) or activate the overlay (`main/src/windowing/WidgetAreaTracker.ts`); panel closes on overlay blur (`focus-change {overlay:false}`), on Escape/Ctrl+W, on close button (`OVERLAY->MAIN::focus-game`).
**Port (decided: game keeps keyboard focus, panel natively mouse-interactive):** no "activation" step needed; reproduce the close rules explicitly:
1. close button → hide; 2. Escape → backend registers a **non-consuming** Hyprland bind (`bindn`) only while the panel is open so the game still receives Escape; 3. new check → replace content; 4. PoE2 loses focus to another client / workspace (Hyprland `activewindow` event) → hide; 5. quick check only: if the pointer moves > `2.5*fontSize` logical px from the press point before ever entering the panel surface → hide (backend polls `hyprctl cursorpos` until host reports pointer-enter, or until moved away); the "hold Ctrl to move into the panel" nuance becomes unnecessary because the pointer can enter freely — but keep the threshold behaviour so a stray mouse move still dismisses an unwanted panel; 6. if the panel took keyboard focus (see 6.5) and the user clicks back into the game → hide (equivalent of hide-on-blur). Never hide on a blur when the panel never had focus (omarchy branch lesson).
Replace `OVERLAY->MAIN::focus-game` with a plain "hide panel" and make `wm.show/hide` notify the backend/host to map/unmap the layer surface. Save config when the panel hides.

### 6.5 Keyboard while the game keeps focus
Requires keyboard: numeric inputs (FilterBtnNumeric, FilterModifier min/max, settings), Enter-to-search (form submit), keyboard activation of rows, Shift-held tooltip mode (`TradeItem.vue:170-210` window keydown/keyup "Shift").
**Port:** layer surface `KeyboardInteractivity::OnDemand` (layer-shell v4; Hyprland supports it) so clicking an input gives the panel keyboard focus; focus returns to the game when the surface unmaps. `itemHoverTooltip="keybind"` cannot see Shift while the game has focus ⇒ either (a) default to `always` on Linux, (b) only works after the panel was clicked, or (c) backend forwards Shift press/release via `bindn`/`bindrn` on `Shift_L`/`Shift_R` as a new WS event and the renderer dispatches synthetic keydown/keyup. Decide explicitly.
Right-click clears inputs (`@mousedown.right.prevent`) but does **not** prevent the `contextmenu` event: QtWebEngine shows its default context menu (Electron does not) ⇒ host must set `QWebEngineView::setContextMenuPolicy(Qt::NoContextMenu)` (or globally `preventDefault` `contextmenu` in the renderer).

### 6.6 Things drawn outside the 28.75rem panel
RelatedItems box (up to 24rem + 0.5rem border, `mt-6`), "Rate limiting" tab + popup (absolute at the bottom of the full-height container, on the screen-centre side), tippy popovers (TradeItem item tooltip placement `left`, no boundary, can be ~300-500 px wide; item editor popover `placement right`, `min-w-96`=24rem; hidden-reason `right-start`; exchange-rate and online-filter are bounded to `#price-window`). Tippy can only position inside the WebEngine viewport.
**Port:** size the panel surface as panel (28.75rem) + a side column (~25rem) on the screen-centre side, transparent background, and set the **input region** (`QWindow::setMask` → `wl_surface.set_input_region` on Qt Wayland — verify) to the union of rects reported by the renderer (ResizeObserver on `#price-window`, related-items wrapper, rate-limit tab/popup, `.tippy-box`) so the transparent area is click-through to the game. Otherwise item tooltips/editor will be clipped or overlap the panel.

### 6.7 Other host-coupled behaviours
- Opening settings from the title (`openLeagueSelection`) uses the in-page widget manager; with the settings in a separate window/renderer instance this needs a new event (e.g. `CLIENT->MAIN::open-settings {widget:"price-check"}`) → host shows the settings window on the price-check page.
- Config sync between panel and settings instances: `CLIENT->MAIN::save-config {contents, isTemporary}` → backend writes + broadcasts `MAIN->CLIENT::config-changed {contents}` to **all** clients including sender (`main/src/host-files/ConfigStore.ts:15-21`); `initConfig` re-applies (`Config.ts:59-63`). Keep this contract (last-writer-wins).
- `/config` GET must return `{contents, version, updater:{state:"initial"}}` (`IPC.ts:65-72`, `HostState`).
- `/proxy/<host>/<path>` hosts needed by this area: `*.pathofexile.com` (+ `pathofexile.tw`, `poe.kakaogames.com`) for leagues/trade/stats/items, `api.exiledexchange2.dev` (poe.ninja mirror: `proxy/data/item-drop.json`, `proxy/data/namespaceMap.json`, `proxy/<league>/overviewData.json`), `poe.ninja`, (`www.poeprices.info` only if price prediction kept). Proxy must strip `sec-*`, `host`, `origin`, `content-length` request headers, drop `content-encoding` response header and pass rate-limit headers (`x-rate-limit-rules`, `x-rate-limit-<rule>`, `x-rate-limit-<rule>-state`) through unchanged (`trade/common.ts:59-73`).
- `performance.mark` calls are harmless; `console.log` in `getDetailsId.ts:77` (Filled Coffin) and `TradeListing.vue:258` are debug leftovers.

---------------------------------------------------------------------------------------------------

## 7. Known bugs / quirks (preserve for parity or fix deliberately)
1. `savedAugments` written under `"maritalWeapon"` (`AugmentEditor.vue:267-269`) but read as `lookup.martialWeapon` (`parser/augment-builder.ts:89-93`) ⇒ saving for "martial weapon" never applies.
2. QualityEditor prices catalysts with `name: selectedCatalyst.name` (localized) instead of `refName` (`QualityEditor.vue:169-172`) ⇒ no price in non-English clients.
3. Item editor mutates the ParsedItem in place ⇒ deep watcher rebuilds presets and discards manual filter edits (by design today).
4. `FiltersBlock.hiddenLabel` returns an already translated string that the template translates again (`:447-456` + `:278`).
5. TradeListing error "Browser" always uses the builtin browser regardless of setting; in non-Electron it renders a dead `<webview>`.
6. `UnidentifiedResolver` auto-selects inside a computed (side effect).
7. `FilterBtnNumeric` right-click clear sets value to 0 (not empty), and blur with empty input disables the filter.
8. `DivCurrency.icon` `/images/div.png` missing.
9. Reflection rules (`pseudo/reflection-rules.ts:28-49`) assume every filter has a roll (`filter.roll!.value`).
10. `TradeBulk` "Browser" link uses `have=["mirror"]`.

---------------------------------------------------------------------------------------------------

## 8. System packages (answer to "what do I have to install")
Checked on this machine (2026-10-30, `pacman -Q`):
- Present: `bun 1.4.3`, `nodejs-lts-iron 20.20` (+ mise node 26), `npm`, `qt6-base 6.12.0`, `qt6-webengine` (lib `libQt6WebEngineCore.so.6.12.0`; a `qml` smoke test importing `QtWebEngine` loads fine), `qt6-declarative`, `qt6-wayland`, `layer-shell-qt 6.8.1` (CMake package `LayerShellQt`), `wl-clipboard` (`wl-copy`/`wl-paste`), `xdg-utils` (`xdg-open`), `gcc`, `pkgconf`, `hyprland 0.56.2`, `quickshell`.
- **Missing, needed to build the Qt6 C++ host:** `cmake` (required) and `ninja` (recommended) → `sudo pacman -S cmake ninja`.
- Nothing else is needed for the price-check renderer itself: all JS libs, fonts (Fontin, FrizQuadrata, Exo2) and Font Awesome are bundled via `bun install`/`npm install` + Vite build; item icons load from `web.poecdn.com` at runtime (network).
