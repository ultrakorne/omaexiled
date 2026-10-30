# 06 — Item parser, game data assets, test suite

Source: `/home/ultra/Developer/Exiled-Exchange-2` (EE2), branch `master` at
`cca30662` (2026-09-06). Paths below are relative to that repo unless they
start with `OmaExiled/`. Line numbers are for `master`.

The user's `omarchy*` branches do not touch the parser, the data module, the
data files or the specs. The only related changes there are
`renderer/package.json` (`"prebuild": "npm run make-index-files"`, see §2.5)
and `export function isPoeItem` in `main/src/shortcuts/HostClipboard.ts`.

---

## 0. Key findings (read these first)

1. **Index `.bin` files go stale.** The four `*.index.bin` files per language are
   gitignored (`renderer/public/data/.gitignore` = `*.index.bin`, plus `*.bin`
   in the root `.gitignore`). They store offsets into `items.ndjson` /
   `stats.ndjson`. In the EE2 working tree on 2026-10-30 they were dated
   Jul 30 while the ndjson files were newer. 2395 of 2478 `stats-ref` offsets
   in `en` pointed mid-line. With those stale files, **399 of 529 tests fail**
   (`SyntaxError: Unexpected token 'e', "ecrated.st"... is not valid JSON` at
   `src/assets/data/index.ts:251`), and the app would hit the same error.
   After regenerating them, all tests pass. The port must rebuild the indexes
   every time the data changes (§2.5).
2. **Parsing needs the advanced copy format (Ctrl+Alt+C).** `parseModifiers`
   (`Parser.ts:1264`) only recognises a section if it contains `{ … }`
   mod-info lines, `… (enchant)`, `… (rune)` or `Grants Skill: `. I fed the
   parser a simulated plain Ctrl+C copy: the rare bow from the tests went from
   5 parsed stats to **0**, and none of the dropped stats appeared in
   `unknownModifiers`. A passive "game's own Ctrl+C" trigger therefore gives
   incomplete price checks unless the game's "show advanced mod descriptions"
   key is held while copying (§6.4).
3. **Runtime requirements.** The parser calls `Set.prototype.intersection`
   (`Parser.ts:2180`, `2201`) and `Array.prototype.toSorted` (`1334`, `2153`,
   `2222`). So the browser engine must be Chromium 122 or newer, and the test
   runtime must be Node 22+ or Bun. With Node 20 (`/usr/bin/node` is v20.20.2
   on this machine), 8 augment tests fail with `set.intersection is not a
   function`. The installed QtWebEngine 6.11.2 is Chromium 140; I checked
   that `typeof new Set().intersection === "function"` there.
4. **The parser lives in the renderer.** The backend only sees raw clipboard
   text and checks its first line with `isPoeItem`
   (`main/src/shortcuts/HostClipboard.ts:110`). It sends that text unparsed
   in `MAIN->CLIENT::item-text` `{ target, clipboard, item?, position:{x,y},
   focusOverlay }` (`ipc/types.ts:184`).
5. **Startup needs the trade-data proxy.** `Data.init()` calls
   `loadTradeData()`, which fetches
   `/proxy/www.pathofexile.com/api/trade2/data/items` and `.../stats` before
   the WebSocket is opened (`main.ts:10-11`). If that fails, the error is
   logged and the parser loses its fallback lookups (§2.6). If any static
   data file is missing, the app does not start at all (§2.4).

---

## 1. Inventory and what to copy verbatim

### 1.1 Parser — `renderer/src/parser/` (13 files, all copy verbatim)

| File | Lines | Exports | Imports from outside `src/parser` |
|---|---|---|---|
| `index.ts` | 4 | `type ParsedItem`, `ItemRarity`, `ItemInfluence`, `itemIsModifiable`, `parseClipboard`, `ItemCategory` | — |
| `Parser.ts` | 2269 | `ParserState` (126), `parseClipboard` (189), `parseModifiersPoe2` (1195), `parseStatsFromMod` (1849), `removeLinesEnding` (2000), `parseAffixStrings` (2009), `getMaxSockets` (2014), `isArmourOrWeaponOrCaster` (2076), `replaceHashWithValues` (2237), `__testExports` (2252) | `neverthrow`; `@/assets/data` (CLIENT_STRINGS, CLIENT_STRINGS_REF, ITEM_BY_REF, STAT_BY_MATCH_STR, BaseType, ITEM_BY_TRANSLATED, TRADE_ITEM_BY_REF, AUGMENT_DATA_BY_TRADE_ID, CATALYST_TYPES, CATALYST_TO_TAG); `@/web/Config` (`AppConfig`, line 44); `@/web/price-check/item-editor/augment` (`useAugment`, line 46) |
| `ParsedItem.ts` | 159 | `ItemRarity` (6), `ItemInfluence` (13), `EditorItem` (31), `ParsedItem` (42), `IncursionRoom` (132), `createVirtualItem` (137), `itemIsModifiable` (152) | type-only from `@/assets/data` |
| `advanced-mod-desc.ts` | 270 | `SCOURGE_LINE=" (scourge)"`, `AUGMENT_LINE=" (rune)"`, `ADDED_AUGMENT_LINE=" (added rune)"`, `ENCHANT_LINE=" (enchant)"`, `IMPLICIT_LINE=" (implicit)"`, `DESECRATED_LINE=" (desecrated)"` (6-11; private: `" (crafted)"`, `" (fractured)"`), `ParsedModifier`, `ModifierInfo`, `parseModInfoLine` (32), `isModInfoLine` (170), `groupLinesByMod` (179), `parseModType` (200), `applyIncr` (242), `incrRoll` (266) | `@/assets/data` |
| `stat-translations.ts` | 380 | `ParsedStat`, `linesToStatStrings` (38), `tryParseTranslation` (171), `getRollOrMinmaxAvg` (329), `__testExports` (378) | `@/assets/data` (STAT_BY_MATCH_STR, TRADE_STAT_BY_MATCH_STR, CLIENT_STRINGS(_REF), StatBetter) |
| `modifiers.ts` | 222 | `StatCalculated`, `StatSource`, `StatRoll`, `sumStatsByModType` (25), `statSourcesTotal` (98), `translateStatWithRoll` (132), `modsEqual` (176), `ModifierType` (193), `EXPLICIT_MOD_TYPES` (210), `INTERNAL_AUGMENT_TYPES` (219) | type-only |
| `meta.ts` | 152 | `ItemCategory` enum (1, 66 values; string values must equal the trade/data category names), `WEAPON_ONE_HANDED_MELEE`, `WEAPON_ONE_HANDED`, `WEAPON_TWO_HANDED_MELEE`, `MARTIAL_WEAPON`, `WEAPON`, `ARMOUR`, `ACCESSORY`, `GRANTS_REAL_SKILL`, `GRANTS_SKILL`, `GEM`, `ItemEditorType` | — |
| `magic-name.ts` | 47 | `magicBasetype` (8) | `@/assets/data`, `@/web/Config` (`AppConfig().language`, line 10) |
| `augment-builder.ts` | 116 | `selectAugmentEffectByItemCategory` (8), `buildEditorItems` (17), `getSavedAugments` (81) | `@/assets/data`, `@/web/Config` (`AppConfig("price-check").savedAugments`, line 83), `@/web/overlay/widgets` (only the type `PriceCheckWidget`, which esbuild erases) |
| `calc-base.ts` | 290 | `recalculateItemProperties` (12), `applyEleAugment` (173), `calcBase` (226), `calcTotal` (240), `calcBaseDamage` (259), `calcTotalDamage` (274) | — |
| `calc-q20.ts` | 206 | `QUALITY_STATS` (14), `OTHER_PSEUDO_STATS` (51), `propAt20Quality` (94), `calcPropBounds` (114), `calcPropPercentile` (144), `calcPropBase` (157), `calcFlat` (184), `calcIncreased` (196) | `@/assets/data` (`stat()` validator) |
| `utils.ts` | 10 | `combinations`, `avg` | — |

Inside the parser, `Parser.ts` ↔ `advanced-mod-desc.ts` / `augment-builder.ts`
/ `calc-base.ts` import each other in a cycle (`removeLinesEnding`,
`replaceHashWithValues`, `isArmourOrWeaponOrCaster`). There is also a cycle
through `web/price-check/item-editor/augment.ts`, which imports
`parseStatsFromMod` back from `Parser.ts`. Both cycles work because the
imports are only called at runtime, never at module-evaluation time. Do not
add top-level code that calls across them.

Who calls into the parser (kept features): `web/price-check/PriceCheckWindow.vue:308`
(`parseClipboard`), `web/item-check/WidgetItemCheck.vue:86`,
`web/item-check/hotkeyable-actions.ts:98`, `web/price-check/filters/fill-augments.ts:93`
(`parseModifiersPoe2`, used only by the item editor and not part of the
pipeline), `web/price-check/filters/create-stat-filters.ts:252`
(`getMaxSockets`), plus about 50 importers of types and enums across
`web/price-check/**`. Dropped callers: `web/library/SingleItemSession.vue:116`,
`web/map-check/*`, `web/item-search/*`.

**Coupling to watch:** `web/item-check/WidgetItemCheck.vue:68` imports
`../map-check/MapCheck.vue`, and `web/item-check/widget.ts:2` imports the type
`MapCheckConfig` from `../map-check/common.js`. Dropping map check means
editing item check. The parser itself has no map-check dependency.
Waystone/map *parsing* (`parseMap`, `parseWaystone`, `parseBlightedMap`)
stays, because price check uses it.

### 1.2 Data module — `renderer/src/assets/`

| File | Copy? | Notes |
|---|---|---|
| `assets/data/index.ts` (624 lines) | verbatim | Loader and lookup tables (§2). Imports `@/web/background/TradeData` (line 14), `@/parser/meta`, `@/parser/ParsedItem`, `../client-string-loader` |
| `assets/data/interfaces.ts` (351) | verbatim | `StatMatcher`, `StatTier`, `Stat`, `StatBetter`, `DropEntry`, `BaseType`, `AugmentLineData`, **`TranslationDict`** (115-284, every client-string key), `Augment*` and `CatalystGroup` types |
| `assets/client-string-loader.ts` (11) | verbatim | `loadClientStrings(lang)` = `(await import(\`${import.meta.env.BASE_URL}data/${lang}/client_strings.js\`)).default` (a native ES-module dynamic import, `@vite-ignore`) |
| `assets/make-index-files.mjs` (130) | verbatim (build tool) | Builds the 4 index `.bin` files for each of `LANGUAGES = ["en","ru","cmn-Hant","ko","ja","de","es","pt","fr"]` (line 7). Reads and writes relative paths `./public/data/...`, so **run it with cwd = `renderer/`**. Needs `@sindresorhus/fnv1a` |
| `web/background/TradeData.ts` (234) | verbatim | `useTradeData` (createGlobalState). Downloads the trade2 item/stat lists through `Host.proxy` (§2.6). Imported by the data module, so it is part of the parser's runtime closure |
| `assets/font.css` + `assets/font/*.ttf` (8 fonts, about 700 KB) | verbatim (UI) | Imported by `web/App.vue:14`. Fontin (item display), FrizQuadrata (Cyrillic), Exo2 (UI) |

### 1.3 `renderer/public/data/` — runtime game data

`du -sh` (EE2 working tree, 2026-10-30): the whole directory is **25 MB**.

| Entry | Size | Fetched at runtime? | Keep? |
|---|---|---|---|
| `en/` | 2.6M | yes | keep |
| `ru/` | 3.0M | yes (if selected) | keep |
| `cmn-Hant/` | 2.5M | yes (if selected) | keep |
| `ko/` | 2.7M | yes (if selected) | keep |
| `ja/` | 2.8M | yes (if selected) | keep |
| `de/` | 2.7M | yes (if selected) | keep |
| `es/` | 2.7M | yes (if selected) | keep |
| `pt/` | 2.7M | yes (if selected) | keep |
| `fr/` | 2.8M | yes (if selected) | keep |
| `th/` | 28K | **no**. It only holds `app_i18n.json`; `th` is not in `Config["language"]` (`web/Config.ts:146`) or the settings `<select>` (`web/settings/general.vue:5-15`) | droppable |
| `item-drop.json` | 24K | **yes, unconditionally** (`data/index.ts:288-290`) | keep |
| `item-drop.jsonc` | 28K | no (annotated source of item-drop.json) | optional |
| `patrons.json` | 12K | **yes, unconditionally** (`data/index.ts:291-293`). Used by `web/settings/SettingsWindow.vue:123` | keep, or remove from `init()` together with the patrons UI |
| `remnants.json` | 164K | no (unused on master; belongs to the `features/CvRemnants` branch) | drop |
| `.gitignore` | `*.index.bin` | — | keep |

Each of the 9 game-language directories contains exactly these files
(sizes for `en` after regeneration):

| File | en size | Tracked in git | Producer |
|---|---|---|---|
| `client_strings.js` | 7,049 | yes | dataParser (Python) — autogenerated ES module `export default { … }` with **RegExp literals**, so it cannot be JSON |
| `items.ndjson` | 1,671,319 B (4063 lines; 1,671,297 UTF-16 code units) | yes | dataParser |
| `stats.ndjson` | 895,065 B (2526 lines) | yes | dataParser |
| `app_i18n.json` | 23,170 | yes | Crowdin / app UI strings (`web/i18n.ts`) |
| `items-name.index.bin` | 28,720 | **no (generated)** | `make-index-files.mjs` |
| `items-ref.index.bin` | 28,720 | **no (generated)** | same |
| `stats-ref.index.bin` | 20,208 | **no (generated)** | same |
| `stats-matcher.index.bin` | 38,632 | **no (generated)** | same |

Together the generated bins are about 1 MB for all 9 languages. Every ndjson
file ends in `\n` and contains no `\r` (checked). The ndjson lines come from
Python `json.dumps(obj, ensure_ascii=False)`, i.e. the separators are `", "`
and `": "`. **Copy these files byte for byte and never re-serialize them.**
The loader uses substring searches that depend on this exact formatting:
`'": "GEM"'`, `'": "UNIQUE"'`, `'": "ITEM"'` (`data/index.ts:210-212`),
`'"tradeTag":'` (215), `'"craftable": {"category": "SoulCore"}'` (328),
`'"tags": ["catalyst"'` (342), `'"tags": ["jewel_catalyst"'` (344), and
`ITEMS_ITERATOR(JSON.stringify(baseType))` in
`web/price-check/unidentified-resolver/UnidentifiedResolver.vue:45`.
Item icons are remote URLs (`https://web.poecdn.com/gen/image/...`; 445 items
use `"%NOT_FOUND%"`, which the UI maps to `/images/404.png`). The page must
therefore be allowed to load images from `web.poecdn.com`. There is no CSP
today.

### 1.4 `renderer/public/images/` (2.2 MB, 28 entries) and root files

Referenced with **absolute** paths (`/images/...`) from source, not via
`BASE_URL`. The renderer must therefore be served from the origin root.

Used by kept features (copy): `404.png`, `annul.png`, `chaos.png`,
`divine.png`, `exa.png`, `wisdom.png`, `extractor.png`, `delve.png`,
`incursion.png`, `veiled.png`, `influence-{Crusader,Elder,Hunter,Redeemer,Shaper,Warlord}.png`,
`Patreon.svg` (CheckedItem.vue / SettingsWindow.vue), `jeweler.png`
(LoadingAnimation.vue, about.vue), `augments/{blue,green,red,rune,soulcore,empty-socket,primaltalisman,sacredtalisman,vividtalisman,wildtalisman}.png`,
all 24 `item-display/*.png` (TooltipItem.vue).
Settings-only: `dc_reddit.png`, `discord.png` (about.vue), `peepoLove2x.webp` (SettingsWindow.vue).
Unused or dropped (do not copy): `syndicate.jpg` (1 MB, image strip),
`dc_tft.gif` (460 KB, unused), `socket2.png`, `socketSprites.pdn`,
`TransferOrb.png`, `augments/empty-jewel.png`.
Existing bug: `web/background/Prices.ts:109` references `/images/div.png`,
which does not exist (only `divine.png` does).
Root: `public/icon.ico` (favicon, `index.html` `<link rel="icon" href="/icon.ico">`),
`public/icon.png` (useful for the bar plugin).

### 1.5 `dataParser/` — build-time only, NOT needed at runtime

A Python 3 project (`src/main.py`; dependencies pandas, numpy, tqdm,
requests, cloudscraper, murmurhash; pytest in `tests/`). `--pull` exports
game data (`providers/game_api.py`) and pulls the trade API per language
(`providers/trade_api.py`). It writes `output/<lang>/{stats.ndjson,items.ndjson,client_strings.js}`,
and `--push --main-repo-path ../exiled-exchange-2` copies those three files to
`renderer/public/data/<lang>/` (`main.py:85-99`). It does **not** create the
index bins or `app_i18n.json`. `copymain.sh` syncs it from the author's
private repo. The port does not need it. Refresh data by copying newer
`public/data/<lang>/*` files from upstream EE2, then regenerate the indexes.

---

## 2. How data is loaded at runtime (what the backend must serve)

### 2.1 Base path

Every data URL is `${import.meta.env.BASE_URL}data/...`. Vite's `base` is not
set (`vite.config.mts`), so `BASE_URL = "/"` and the URLs are `/data/...`.
Images use hard-coded `/images/...` and the WebSocket uses
`ws://${window.location.host}/events` (`web/background/IPC.ts:25`). The
renderer must be loaded over HTTP from the **origin root**
(`http://127.0.0.1:<port>/` or `/index.html`; EE2 loads
`http://localhost:${port}/index.html`, `main/src/windowing/OverlayWindow.ts:79`).
`file://` does not work: `fetch()` and the dynamic module `import()` of
`client_strings.js` both fail. No query strings or hash routing are used.

### 2.2 Startup sequence (`renderer/src/main.ts`)

```
await initConfig();                          // GET /config
await I18n.init(AppConfig().language);       // web/i18n.ts
await Data.init(AppConfig().language);       // assets/data/index.ts:286
await Host.init();                           // opens ws://<host>/events
watch(() => AppConfig().language, async () => {
  await Data.loadForLang(AppConfig().language);
  await I18n.loadLang(AppConfig().language);
});
```

Requests in order at startup, for the configured language `L`:

| # | Request | Code | How it is read |
|---|---|---|---|
| 1 | `GET /data/en/app_i18n.json` | `web/i18n.ts:16` | `.json()` |
| 2 | `GET /data/L/app_i18n.json` (only if L≠en) | `web/i18n.ts:28` | `.json()` |
| 3 | `import("/data/en/client_strings.js")` → `CLIENT_STRINGS_REF` (always English) | `data/index.ts:287` via `client-string-loader.ts:8` | ES module |
| 4 | `GET /data/item-drop.json` | `data/index.ts:288-290` | `.json()` |
| 5 | `GET /data/patrons.json` | `data/index.ts:291-293` | `.json()` |
| 6 | `import("/data/L/client_strings.js")` → `CLIENT_STRINGS` | `data/index.ts:319` | ES module (cached by URL; for L=en it is the same module as #3) |
| 7 | `GET /data/L/items.ndjson` | `data/index.ts:159` | `.text()` |
| 8 | `GET /data/L/items-name.index.bin` | `:165-167` | `.arrayBuffer()` → `Uint32Array` |
| 9 | `GET /data/L/items-ref.index.bin` | `:172-174` | `.arrayBuffer()` |
| 10 | `GET /data/L/stats.ndjson` | `:222` | `.text()` |
| 11 | `GET /data/L/stats-ref.index.bin` | `:228-230` | `.arrayBuffer()` |
| 12 | `GET /data/L/stats-matcher.index.bin` | `:235-237` | `.arrayBuffer()` |
| 13 | `loadUltraLateItems()` builds the augment and catalyst tables from ITEMS_ITERATOR (no I/O) | `:326-388` | — |
| 14 | `GET /proxy/www.pathofexile.com/api/trade2/data/items` and `GET /proxy/www.pathofexile.com/api/trade2/data/stats` (in parallel) | `TradeData.ts:120`, `:68` via `Host.proxy` = `fetch("/proxy/" + url)` (`IPC.ts:83-85`) | `.text()` + `JSON.parse` |
| 15 | Then `DELAYED_STAT_VALIDATION`: every `stat("…")` string registered at module load must resolve through `STAT_BY_REF`. Failures are only `console.log`ged (`:297-313`) | — | — |

All of these are awaited one after another, except #14, where the two
requests run in parallel. Nothing in steps 1-13 is wrapped in try/catch. If a
static file 404s or returns a non-JSON body, `init()` rejects, the async IIFE
in `main.ts` stops, and **the app never mounts**. With L=en, startup downloads
about 2.75 MB from localhost. The ndjson strings stay in memory for the
lifetime of the page (about 2.6 MB of JS string per language).

**Language switch** (settings → `AppConfig().language = value`,
`web/settings/general.vue:171-178`): the watcher runs
`Data.loadForLang(lang)`, which repeats #6-#14 for the new language. Note that
it re-downloads the trade data with `force=true`. Then `I18n.loadLang(lang)`
fetches `/data/<lang>/app_i18n.json`. English `CLIENT_STRINGS_REF` is
never reloaded. Only the selected language's data is ever fetched (lazy per
language). The backend should serve all nine directories.

### 2.3 Index file format (needed if the backend or a build step generates them)

Produced by `renderer/src/assets/make-index-files.mjs`:

- Each file is a raw `Uint32Array` dump in host byte order (little-endian on
  x86_64 and aarch64) of `[hash, offset]` pairs (`INDEX_WIDTH = 2`), **sorted
  ascending by hash**. Lookup is a binary search (`dataBinarySearch`,
  `data/index.ts:95`).
- `hash = Number(fnv1a(key, { size: 32 }))` from `@sindresorhus/fnv1a` v3.1.0.
- `offset` is the **UTF-16 code-unit index into the ndjson JavaScript string**
  where the line starts, **not a byte offset**. For example, `en/items.ndjson`
  is 1,671,319 bytes but only 1,671,297 code units long. A reimplementation
  outside JavaScript must count UTF-16 code units.
- `stats-ref.index.bin`: one row per stat line, key = `stat.ref`.
- `stats-matcher.index.bin`: one row per `matcher.string` and per
  `matcher.advanced`, pointing at the stat line. On lookup the code re-checks
  `m.string === matchStr || m.advanced === matchStr`, so an fnv1a collision
  returns `undefined` (`data/index.ts:254-275`).
- `items-ref.index.bin` / `items-name.index.bin`: one row per **distinct
  `namespace::refName`** (the first line of each group); the keys are
  `` `${namespace}::${refName}` `` and `` `${namespace}::${name}` ``. A lookup
  scans forward from the offset while `record.namespace === ns &&
  record[prop] === name`, and stops after the first record unless it has
  `disc` or `unique` (`commonFind`, `data/index.ts:178-203`). The ndjson must
  therefore keep variants of one item on adjacent lines. Each ndjson line
  must also end with `\n`, otherwise `indexOf("\n")` returns -1.
- Run time: about 0.45 s for all 9 languages under Bun 1.4.3. **Bun produced
  bins byte-identical to Node's** (I compared all 36 files).

### 2.4 Serving requirements for the Bun backend (static part)

- Serve the built renderer (`renderer/dist/`: Vite copies `public/` into the
  dist root, i.e. `dist/data/**`, `dist/images/**`, `dist/icon.*`) at `/`, and
  map `/` → `/index.html`. EE2's server (`main/src/server.ts:20-46`) does
  `fs.createReadStream(path.join(__dirname, req.url))`. It has no 404
  handling and does not strip query strings. The port should do both
  properly, without path traversal.
- **MIME types matter for `client_strings.js`.** It is loaded with a module
  `import()`, and Chromium enforces strict MIME checking for module scripts:
  it must be served as `text/javascript`. EE2 sets `text/html` for `.html`,
  `text/javascript` for `.js`, `application/json` for `.json` and
  `image/svg+xml` for `.svg`, and nothing else. For `.ndjson` and `.bin`
  any type works (they are read with `.text()` / `.arrayBuffer()`).
  `Bun.file()` infers `text/javascript;charset=utf-8` for `.js`.
- **Cache control.** Serve `/data/**` with `Cache-Control: no-cache` plus an
  ETag or Last-Modified, or set the host's `QWebEngineProfile` HTTP cache to
  memory-only or none. If the cache returns an old `items.ndjson` with a new
  `.bin` (or the reverse), you get the same corruption as stale bins.
- A missing file must return a real 404. The renderer will still crash on it
  (§2.2), so log it on the backend side.
- During development (`vite` dev server) the renderer proxies
  `^/(config|uploads|proxy)` and `/events` (ws) to `http://127.0.0.1:8584`
  (`vite.config.mts` `server.proxy`). The Bun backend should listen on
  **8584** in dev mode so `npm run dev` keeps working, and serve `public/` +
  `dist/` in production.

### 2.5 Keeping the indexes fresh (required)

Pick one, and make it impossible to forget:

1. **Build step:** `"prebuild": "npm run make-index-files"` (this is what the
   user's `omarchy*` branches added to `renderer/package.json`), plus
   `"pretest": "npm run make-index-files"`, so tests can't run on stale data
   either.
2. **Backend (recommended for robustness):** port `make-index-files.mjs` to a
   function in the Bun backend. On startup, or lazily per language, it would
   compute the 4 indexes in memory from the ndjson it is about to serve, and
   answer `/data/<lang>/*.index.bin` from memory. The bins can then never
   disagree with the served ndjson. It takes about 50 ms per language.
3. At minimum, have the backend check at startup that every offset in each
   bin is 0 or follows a `\n` in the ndjson (this is how I detected the
   staleness), and regenerate the bins if not.

`OmaExiled/.gitignore` already contains `*.index.bin`. When I checked,
`OmaExiled/renderer/public/data/*/` held freshly generated bins (28,720-byte
`items-*.index.bin`, which matches the current data).

### 2.6 Trade-data dependency (`web/background/TradeData.ts`)

- URLs (always English `www`, regardless of language or realm; see the
  comment "don't use getTradeEndpoint"): `Host.proxy("www.pathofexile.com/api/trade2/data/stats")`
  (line 68) and `Host.proxy("www.pathofexile.com/api/trade2/data/items")`
  (line 120). Through the backend these become
  `GET /proxy/www.pathofexile.com/api/trade2/data/{stats,items}`. The proxy
  rules (headers, User-Agent, cookies) are covered by the proxy note.
- They produce `TRADE_ITEM_BY_REF` (fallback in `findInDatabase`,
  `Parser.ts:338-349`, and in `magicBasetype`), `TRADE_STAT_BY_MATCH_STR`
  (fallback in `trySecondaryParseTranslation`, `stat-translations.ts:340-341`)
  and `TRADE_STAT_BY_STAT_ID`.
- Failure handling: `load()` catches the error and sets `error.value`.
  `loadTradeData` then logs `Failed to load trade data:` and returns, and the
  TRADE_* functions stay as their initial no-ops returning `undefined` /
  `false`. Parsing keeps working, but items or stats that only exist in the
  live trade data become `item.unknown` or unknown stats.
- Refresh: `setInterval(load, 30 min)`. A non-forced `load()` only runs if
  2 h have passed since the last update AND the data was used
  (`expressInterest`) within the last hour. The new data is ignored unless it
  has more items AND more stats than the current data ("don't regress").

---

## 3. Parser architecture

### 3.1 `parseClipboard(clipboard: string): Result<ParsedItem, string>` (`Parser.ts:189-230`)

1. `itemTextToSections` (232-251): split on `/\r?\n/` (so CRLF is fine), drop
   **one** trailing `""` line, split into sections on lines that are exactly
   `"--------"` (8 hyphens), and drop empty sections.
2. If `sections[0][2] === CLIENT_STRINGS.CANNOT_USE_ITEM`, pop that line and
   prepend section 0 (Item Class + Rarity) to section 1 (194-198). The game
   puts this line ("You cannot use this item. Its stats will be ignored")
   into the first block when the character can't use the item.
3. `parseNamePlate(sections[0])` (539-628):
   - First line must start with `ITEM_CLASS`. If it does not:
     `isItemMissingItemClass` (2245) accepts a 2-3 line header whose first
     line starts with `RARITY` (meta and uncut skill gems copied without an
     Item Class line), and the category is forced to `Gem`. Otherwise
     `LANGUAGE_DETECTOR.find(d => section[1].startsWith(d.rarityLine))`
     decides between `err("item.wrong_language|<found displayLang>|<configured displayLang>")`
     and `err("item.parse_error")`.
   - The **Item Class value is ignored**. The category comes from the rarity
     line (Currency, Divination Card, Gem) or later from the database
     (`info.craftable.category`).
   - `Rarity: X` maps `RARITY_NORMAL|RARITY_QUEST→Normal`, `MAGIC`, `RARE`,
     `UNIQUE`, and `RARITY_CURRENCY→category Currency`,
     `RARITY_DIVCARD→DivinationCard`, `RARITY_GEM→Gem`.
   - The next line is `name` and the one after it is `baseType` (optional).
     Both go through `markupConditionParser` (1833): it strips `<<set:..>>`
     and keeps only the `<if:..>{…}` branch.
4. `rawText = clipboard`. Then run the `parsers` pipeline (132-187). Each
   section is consumed by at most one parser and each parser consumes at most
   one section. A section parser returns `SECTION_PARSED` (consume it and
   move to the next parser), `SECTION_SKIPPED` (try the next section) or
   `PARSER_SKIPPED` (abort this parser). "Virtual" parsers run once on the
   item; returning an `err` aborts the whole parse.
5. Return `Object.freeze(parsed)` (a shallow freeze). Any thrown exception →
   `console.log(e)` → `err("item.parse_error")`.

Pipeline order (line numbers = definitions in `Parser.ts`):

| # | Parser | Def | Kind / what it reads |
|---|---|---|---|
| 1 | `parseUnidentified` | 694 | `UNIDENTIFIED` regex (with optional tier) |
| 2 | `parseSuperior` | 1585 | virtual: strip `ITEM_SUPERIOR` prefix (REF regex first, then localized) |
| 3 | `parseExceptional` | 1601 | virtual: strip `ITEM_EXCEPTIONAL` |
| 4 | `parseRuneforged` | 1617 | virtual: no-op |
| 5 | `parseSynthesised` | 1560 | `SECTION_SYNTHESISED` / `ITEM_SYNTHESISED` |
| 6 | `parseCategoryByHelpText` | 1632 | `BEAST_HELP`, `METAMORPH_HELP`, `VOIDSTONE_HELP` |
| 7 | `normalizeName` | 253 | virtual: magic base type (`magicBasetype`), blighted map prefixes, metamorph organs |
| 8 | `findInDatabase` | 301 | virtual: `ITEM_BY_REF` → `ITEM_BY_TRANSLATED` → `TRADE_ITEM_BY_REF`; otherwise `err("item.unknown")` (347). Sets `info`, `infoVariants`, category |
| 9 | `parseItemLevel` | 707 | `ITEM_LEVEL` (`CORPSE_LEVEL` for Filled Coffin) |
| 10 | `parseRequirements` | 723 | `REQUIRES` + `REQUIRES_LINE` regex. **Throws** if the regex fails, which becomes parse_error |
| 11 | `parseTalismanTier` | 749 | `TALISMAN_TIER` |
| 12 | `parseGem` | 789 | `GEM_LEVEL` (+ nested quality) |
| 13 | `parseArmour` | 946 | `ARMOUR`, `EVASION`, `ENERGY_SHIELD`, `BLOCK_CHANCE`, `RUNIC_WARD`. Undone for uniques |
| 14 | `parseWeapon` | 994 | `CRIT_CHANCE`, `ATTACK_SPEED`, `PHYSICAL_DAMAGE`, `ELEMENTAL_DAMAGE`, `FIRE/COLD/LIGHTNING_DAMAGE`, `RELOAD_SPEED`, `BASE_SPIRIT`; split on `HYPHEN` (`'到'` for cmn-Hant). Undone for uniques |
| 15 | `parseCaster` | 1130 | quality-only section of Wand/Sceptre/Staff |
| 16 | `parseFlask` | 1445 | `FLASK_CHARGES` |
| 17 | `parseJewelery` | 1466 | consumes the quality section of amulets, rings and belts |
| 18 | `parseCharmSlots` | 1485 | `CHARM_SLOTS` (belts) |
| 19 | `parseSpirit` | 1503 | `BASE_SPIRIT` (sceptres) |
| 20 | `parsePriceNote` | 1521 | `PRICE_NOTE` → `item.note` |
| 21 | `parseTimelostRadius` | 1533 | `TIMELESS_RADIUS` (jewels) |
| 22 | `parseStackSize` | 819 | `STACK_SIZE` (strips non-digits; ignored for "Idol of Estazunti") |
| 23 | `parseCorrupted` | 666 | `CORRUPTED`, `DOUBLE_CORRUPTED`, `UNMODIFIABLE` |
| 24 | `parseFoil` | 682 | `FOIL_UNIQUE` |
| 25 | `parseInfluence` | 630 | `INFLUENCE_*` |
| 26 | `parseMap` | 383 | `MAP_TIER` |
| 27 | `parseWaystone` | 392 | `WAYSTONE_REVIVES`, `PACK_SIZE`, `MAGIC_MONSTERS`, `RARE_MONSTERS`, `DROP_CHANCE`, `RARITY`, `MONSTER_RARITY`, `EFFECTIVENESS` |
| 28 | `parseSockets` | 886 | gem `SOCKETS` |
| 29 | `parseAugmentSockets` | 845 | `SOCKETS` (`S` count) vs `getMaxSockets` |
| 30 | `parseHeistBlueprint` | 1648 | heist |
| 31 | `parseTrials` | 1687 | Djinn Barya / Inscribed Ultimatum: `TRIAL_COUNT`, `ULTIMATUM_*` |
| 32 | `parseAreaLevel` | 1729 | `AREA_LEVEL` for Chronicle / Logbook / Mirrored Tablet / Forbidden Tome |
| 33 | `parseAtzoatlRooms` | 1744 | `INCURSION_OPEN` / `INCURSION_OBSTRUCTED` |
| 34 | `parseMirroredTablet` | 1790 | — |
| 35 | `parseFilledCoffin` | 1817 | Necropolis implicit |
| 36 | `parseMirrored` | 1423 | `MIRRORED` |
| 37 | `parseSanctified` | 1434 | `SANCTIFIED` |
| 38 | `parseSentinelCharge` | 1544 | `SENTINEL_CHARGE` |
| 39-41 | `parseLogbookArea` ×3 | 1147 | Expedition Logbook areas |
| 42-46 | `parseModifiers` ×5 (enchant, augment, implicit, grant skill, explicit) | 1264 | sections recognised by `{…}` (advanced), `(enchant)`, `(rune)`, `Grants Skill: ` → `parseStatsFromMod` (1849) → `linesToStatStrings` + `tryParseTranslation` |
| 47 | `transformToLegacyModifiers` | 1922 | virtual: `statsByType = sumStatsByModType(newMods)` |
| 48 | `parseFractured` | 487 | virtual |
| 49 | `parseBlightedMap` | 467 | virtual |
| 50 | `applyAugmentSockets` | 1320 | virtual: infer runes/soul cores from `(rune)` stats (`determineAugments` 2156 / `modifiedBfs` 2113, needs `Set.prototype.intersection`). If every socket is empty, auto-fill from `AppConfig("price-check").savedAugments` via `useAugment` |
| 51 | `applyElementalAdded` | 1927 | virtual |
| 52 | `pickCorrectVariant` | 494 | virtual: `disc` rules (propAR/EV/ES, mapTier W/Y/R, hasImplicit/hasExplicit, sectionText ⊂ rawText) |
| 53 | `calcBasePercentile` | 1964 | virtual |

`parseVaalGemName` (761) is defined but disabled (EE2 issue #954).
`parseModifiersPoe2` (1195) is not in the pipeline. The item editor uses it
(`fill-augments.ts:93`).

Error strings, which the UI resolves as i18n keys:

| Code | Emitted at | UI handling |
|---|---|---|
| `item.parse_error` | 228 (exception), 561, 576 | `PriceCheckWindow.vue:306-333` → `{name: err, message: err+"_help", rawText}`. en text: "An error occurred while parsing the item" |
| `item.unknown` | 347; also raised by the UI for non-unique HeistContract / Sentinel (`PriceCheckWindow.vue:309-315`) | "Unknown Item" |
| `item.wrong_language\|<game>\|<ee>` | 556-558 | split on `\|`; `format: [gameLang, eeLang]` → "POE2 is set to {0} but EE2 is currently set to {1}" |

Edge cases worth keeping in mind:

- `LANGUAGE_DETECTOR.find(...)` for the wrong-language message checks `en`
  ("Rarity: ") first. Thai and Simplified Chinese items also use "Rarity: ",
  so they are reported as English.
- If the header has fewer than 2 lines, `section[1].startsWith` throws, which
  becomes `item.parse_error`.
- `LANGUAGE_DETECTOR.find(lang === AppConfig().language)!.displayLang`
  requires `AppConfig().language` to be one of the 11 detector languages.
- Unique armour and weapons get their AR/EV/ES and DPS properties
  **cleared** (`parseArmour` 983-990, `parseWeapon` 1117-1127).

### 3.2 Simple vs advanced copy, CRLF, trailing newline (verified)

I ran these in a scratch copy with vitest (`specs/Parser/items.ts` fixtures):

| Input | RareItem (bow, 4 mods) | ItemAllTheModifierTypes |
|---|---|---|
| Advanced text (`{ Prefix Modifier "…" (Tier: n) — tags }` lines, `value(min-max)` rolls) | 4 mods / 5 stats | 10 mods / 11 stats |
| Same text with `{…}` lines and `(min-max)` removed (≈ plain Ctrl+C) | **0 mods / 0 stats, 0 unknown** | 3 mods / 4 stats (only enchant, rune, grants-skill) |
| Advanced text with `\r\n` line endings + trailing `\r\n` | 5 stats | 11 stats |
| Advanced text + one extra trailing `\n` | 5 stats | 11 stats |

So the backend must send **Ctrl + `<showModsKey>` + C** (EE2:
`mergeTwoHotkeys("Ctrl + C", gameConfig.showModsKey)`, which defaults to
Ctrl+Alt+C; `main/src/shortcuts/Shortcuts.ts:293-325`). For the passive or
pass-through trigger on the game's own Ctrl+C, the advanced format is only
present if the user holds the show-mods key while copying. The backend can
check for advanced text by looking for a line matching `^\{ .* \}$`.

---

## 4. Parser dependencies on non-parser modules

| Dependency | Where | What is used | Port action |
|---|---|---|---|
| `@/assets/data` | everywhere | `CLIENT_STRINGS` (localized markers), `CLIENT_STRINGS_REF` (English), `ITEM_BY_REF`, `ITEM_BY_TRANSLATED`, `STAT_BY_MATCH_STR`, `STAT_BY_REF`, `TRADE_ITEM_BY_REF`, `TRADE_STAT_BY_MATCH_STR`, `AUGMENT_DATA_BY_TRADE_ID`, `CATALYST_TYPES`, `CATALYST_TO_TAG`, `stat()` | Copy verbatim. These are module-level `let` bindings that `init()`/`loadForLang()` reassign, so **`Data.init()` must finish before anything parses** (main.ts already does this) |
| `@/web/Config` → `AppConfig()` | `Parser.ts:557` (`.language`), `magic-name.ts:10` (`.language === "cmn-Hant"` changes the word separator), `augment-builder.ts:83` (`AppConfig("price-check").savedAugments`, a `{[categoryOrGroup]: (refName\|null)[]}` map with keys `<ItemCategory>`, `martialWeapon`, `casterWeapon`, `armour`, `all`) | Keep `AppConfig()` with the same overloads (`web/Config.ts:15-23`). The trimmed `Config` must keep `language` and the `price-check` widget's `savedAugments` (`web/overlay/widgets.ts:61`; migration `Config.ts:676-684`). Tests mock this module entirely |
| `@/web/price-check/item-editor/augment` → `useAugment` | `Parser.ts:46`, used in `applyAugmentSockets` | Keep (price-check item editor) |
| `@/web/background/TradeData` → `@/web/background/IPC` (`Host.proxy`) | via `data/index.ts:14` | Keep `Host.proxy(url, init) = fetch("/proxy/" + url, init)` (`IPC.ts:83-85`). The backend must implement `/proxy/www.pathofexile.com/...` |
| `@/web/overlay/widgets` | `augment-builder.ts:5` (type only) | Keep the type or inline it |
| i18n (`vue-i18n`, `web/i18n.ts`) | **none in the parser** | Error codes are i18n keys that the UI resolves |
| `neverthrow`, `@sindresorhus/fnv1a`, `vue` + `@vueuse/core` (TradeData only) | — | npm dependencies |
| Browser globals | `performance.mark/measure` (about 60 calls), `fetch`, dynamic `import()`, `Set.prototype.intersection`, `Array.prototype.toSorted`, `Array.prototype.at` | Chromium ≥122 (QtWebEngine 6.11 = Chromium 140 OK); Node ≥22 or Bun for tests |
| `Host.isElectron` (`IPC.ts:87-89` = `navigator.userAgent.includes("Electron")`) | not in the parser, but `Host.onEvent` drops every `MAIN->OVERLAY*` subscription when it is false (`IPC.ts:53-55`); the test mock sets `isElectron: true` | The QtWebEngine host must either put "Electron" in the user agent or the port must change this getter. Covered in the IPC/renderer note |

---

## 5. Test suite

### 5.1 Layout

```
renderer/vitest.config.ts       plugins: vite-tsconfig-paths; test.globals=true;
                                test.setupFiles=["./specs/vitest.setup.ts"];
                                includeSource=["src/**/*.{js,ts}"] (unused: define sets
                                import.meta.vitest=undefined and no src file uses it);
                                coverage.exclude ["*.vue"];
                                alias "@/assets/data/en" → "./src/parser/en" (stale, harmless; dir doesn't exist)
renderer/tsconfig.json          paths: @/* → ./src/*, @ipc/* → ../ipc/*, @specs/* → ./specs/*
renderer/specs/vitest.setup.ts  global mocks + setupTests()
renderer/specs/helper.ts        createTestStatFilter, createTestCreateOptions, createTestItem,
                                createParsedStat, createParsedModifier, makeCalcStat
renderer/specs/Parser/items.ts  TestItem class + ~30 real item-text fixtures (en)
renderer/specs/Parser/mods.ts   mod-line fixtures
renderer/specs/data/items.json  mock of api/trade2/data/items (9967 lines)
renderer/specs/data/stats.json  mock of api/trade2/data/stats (30688 lines)
renderer/specs/docs/fetchResponses.json   trade fetch responses (pathofexile-trade.test.ts)
renderer/specs/docs/fetchResponses2.json  UNUSED
renderer/specs/web/FullCampaign.txt       Client.txt fixture for client-log.test.ts (dropped)
```

### 5.2 How tests load data (`specs/vitest.setup.ts`)

- `vi.mock("@/web/Config")` (line 7): `AppConfig(type?)` returns `mockConfig`
  or the widget with `wmType === type`. `TipsFrequency.Always = 1`.
- `setupClientStringLoaderMock` (23-38): `loadClientStrings(lang)` →
  `import(path.resolve(__dirname, "../public/data/") + "/<lang>/client_strings.js")`,
  i.e. the real file from `renderer/public/data`. (`vi.mock` is nested in a
  function, so vitest warns that it is hoisted. The warning is harmless today
  and slated to become an error in a future vitest version.)
- `setupFetchMock` (41-93): replaces `global.fetch`. The URL has its
  `BASE_URL` ("/") stripped (only the first occurrence), the result is
  resolved under `renderer/public/`, and the file is read from disk. Only
  `.ndjson` (text), `.bin` (ArrayBuffer) and `.json` (text, `.json()`) are
  handled. A read error gives a 404-like response; any other extension
  **throws** `Unhandled fetch request`. **The bins must exist and be fresh in
  `renderer/public/data/<lang>/`.**
- `vi.mock("@/web/background/IPC")` (95-123): `Host.proxy` returns
  `specs/data/{stats,items}.json` for URLs ending in
  `api/trade2/data/stats|items` (it picks the file with `url.slice(-5)`), and
  falls back to the fetch mock otherwise. `onEvent` returns an
  AbortController, `sendEvent` is a no-op, `getConfig` → null,
  `isElectron: true`, `version "0.0.00000"`, `updateInfo {state:"initial"}`.
- `defaultConfigMock(overrides)` (124-166) builds a full `Config`. It
  includes the keys `clientLog`, `gameConfig`, `readClientLog`,
  `enableAlphas`, `alphas`, `stashScroll`, etc., and a single `price-check`
  widget with `savedAugments: {}`. Trim it in step with the trimmed `Config`
  type, or `vue-tsc`/`tsc` will fail on `specs/`.
- `setupTests(overrides)` (168-172) = config mock + client-string mock +
  fetch mock. Almost every suite does `beforeEach(async () => { setupTests(); await init("en"); })`.
  This means `init()` (the full data load including 4 bins) runs once per
  test, which is why the 240-case `advanced-mod-desc` suite takes about 2.7 s.
  Language-specific suites call `setupTests({ language: "cmn-Hant" })` + `init("cmn-Hant")`
  (magic-name) and `init(lang)` for en / cmn-Hant / ja / ko / ru (parsers.test.ts
  `parseRequirements`). Those languages' data and bins must therefore be
  present too.

### 5.3 Running the tests (exact commands)

The CI job is `.github/workflows/test.yml`: Node 24, `npm ci` (renderer and
main), `npm run make-index-files`, `npm run test` (in `renderer/`).

```bash
cd renderer
npm ci                       # or: bun install
npm run make-index-files     # or: bun src/assets/make-index-files.mjs   (REQUIRED; bins are gitignored and go stale)
npx vitest run               # one-shot. `npm test` = `vitest` = watch mode in an interactive TTY
# under the Bun runtime instead of Node (works, about 2.6 s):
bun --bun ./node_modules/.bin/vitest run
# type check (passes on master, 0 errors):
npx vue-tsc --noEmit         # also: npm run check-types (= tsc --noemit)
```

What I did, without writing to the source repo: copied `renderer/` (without
`node_modules`/`dist`) and `ipc/` to a scratch directory, symlinked
`node_modules` (vitest 4.1.4 / vite 5.4.21 / vue 3.2.37 are installed; the
lockfile wants vitest 4.1.11, and the older version works), and ran the
suites there. Even with that setup, vitest wrote
`node_modules/.vite/vitest/<hash>/results.json` and created
`node_modules/.vite-temp/` inside the symlinked (source) `node_modules`. I
removed both afterwards. `vue-tsc` rewrote the existing
`node_modules/.vue-global-types/vue_3.2_0_0_0.d.ts`. The source repo's
`git status` is clean.

Results:

| Run | Files | Tests |
|---|---|---|
| As checked out (stale Jul-30 bins), Node 26.8.1 | 13 failed / 10 passed (23) | **399 failed / 128 passed / 2 skipped (529)** |
| After `make-index-files`, Node 26.8.1 | 23 passed | **527 passed / 2 skipped** (3.3 s) |
| After `make-index-files`, `bun --bun` (Bun 1.4.3) | 23 passed | 527 passed / 2 skipped (2.6 s) |
| After `make-index-files`, system Node 20.20.2 | 1 failed / 22 passed | 8 failed (all `specs/Parser/augment.test.ts`: `set.intersection is not a function`) / 519 passed / 2 skipped |

The 2 skipped tests are `client-log.test.ts` › "local performance tests"
(`slice`, `regex`).

### 5.4 Test files: kept vs dropped features

| Spec | Tests | Covers | Port |
|---|---|---|---|
| `specs/data/dataLoader.test.ts` | 2 | `augmentsToLookup`, `init("en")` | keep |
| `specs/Parser/advanced-mod-desc.test.ts` | 240 | `parseModType`, `parseModInfoLine` | keep |
| `specs/Parser/augment.test.ts` | 28 | `determineAugments`, `modifiedBfs`, `parseAugmentSockets`, `applyAugmentSockets` | keep (needs Node ≥22 / Bun) |
| `specs/Parser/example.test.ts` | 2 | sanity + `init` | keep |
| `specs/Parser/fractureParsers.test.ts` | 2 | `parseFractured` | keep |
| `specs/Parser/integration.test.ts` | 4 | `parseClipboard` end-to-end (bow DPS, spectre spirit, armour, charm quality) | keep |
| `specs/Parser/magic-name.test.ts` | 12 | `magicBasetype` (en, cmn-Hant) | keep |
| `specs/Parser/mapParser.test.ts` | 4 | `parseWaystone` (waystones are price-checked) | keep |
| `specs/Parser/modifiersParsers.test.ts` | 32 | `parseModifiers` e2e + unit | keep |
| `specs/Parser/parsers.test.ts` | 30 | `itemTextToSections`, `parseWeapon`, `parseArmour`, `parseRequirements` (en/cmn-Hant/ja/ko/ru) | keep |
| `specs/Parser/sectionUnit.test.ts` | 21 | `parseUnidentified`, `parseTrials` | keep |
| `specs/Parser/skillGem.test.ts` | 10 | `isItemMissingItemClass`, uncut/skill gems, `createFilters` for uncut gems | keep |
| `specs/Parser/stat-translation.test.ts` | 10 | `tryParseTranslation` (mocks `@/assets/data`) | keep |
| `specs/web/item-check.test.ts` | 4 | `encodePoe2dbUri` (item check) | keep |
| `specs/web/prices.test.ts` | 2 | `Prices.ts` `parseXchg`, `splitJsonBlob` (poe.ninja) | keep |
| `specs/web/useTradeApi.test.ts` | 7 | `trade-api.ts` (mocks `pathofexile-trade`) | keep |
| `specs/web/price-check/filters/create-item-filters.test.ts` | 42 | item filters | keep |
| `specs/web/price-check/filters/create-stat-filters.test.ts` | 23 | stat filters | keep |
| `specs/web/price-check/filters/missing-fracture-rules.test.ts` | 4 | pseudo rules | keep |
| `specs/web/price-check/filters/pseudo/index.test.ts` | 11 | `filterPseudo`, `filterPseudoSources` | keep |
| `specs/web/price-check/trade/pathofexile-trade.test.ts` | 4 | `parseFetchResult` tooltip tiers (uses `specs/docs/fetchResponses.json`) | keep |
| `specs/web/client-log.test.ts` | 28 (+2 skipped) | `web/client-log/client-log` (uses `FullCampaign.txt`, 13,570 lines) | **drop** (client-log feature dropped) |
| `specs/web/library/libraryChaos.test.ts` | 5 | `web/library/widget` `modFilter` | **drop** (library widget dropped) |

Kept: 21 files, **494 tests**. Dropped: 2 files, 33 tests + 2 skipped.
Also drop `specs/docs/fetchResponses2.json` (unused) and
`specs/web/FullCampaign.txt`.

### 5.5 Porting the tests into OmaExiled

- Keep the directory layout (`renderer/specs`, `renderer/public/data`); the
  mocks resolve `../public/` relative to `specs/`.
- If `@/web/background/IPC` or `@/web/Config` move or get renamed, update the
  `vi.mock` paths in `vitest.setup.ts` (lines 7, 95). If the factory is
  missing, the real IPC module opens a WebSocket during import-time code
  paths.
- Add `"pretest": "npm run make-index-files"` (or the in-memory backend
  index, with tests calling the same function) so tests never run on stale
  bins.
- Pin the runtime: `"engines": { "node": ">=22" }`, or document
  `bun --bun vitest run`. Do **not** use Bun's own `bun test` runner. The
  suites rely on vitest's `vi.mock` hoisting, `vi.mocked`,
  `import.meta.env.BASE_URL` and tsconfig path aliases.
- Optional: drop `vite-tsconfig-paths` in favour of Vite's native
  `resolve.tsconfigPaths` (vitest prints a hint), and move the nested
  `vi.mock` in `setupClientStringLoaderMock` to top level before vitest turns
  the warning into an error.

---

## 6. Item-text format markers (backend clipboard detection)

### 6.1 Backend-side check in EE2 (`main/src/shortcuts/HostClipboard.ts`)

```ts
function isPoeItem(text: string) {           // :110-115
  return LANGUAGE_DETECTOR.find(({ firstLine, uncutSkillGemLine }) =>
    text.startsWith(firstLine) || text.startsWith(uncutSkillGemLine));
}
```

`LANGUAGE_DETECTOR` (`:117-173`). The check is on the very first characters
of the clipboard, and the trailing space is part of each marker:

| lang | `firstLine` (Item Class) | `uncutSkillGemLine` (Rarity) |
|---|---|---|
| en | `Item Class: ` | `Rarity: ` |
| ru | `Класс предмета: ` | `Редкость: ` |
| fr | `Classe d'objet: ` (ASCII apostrophe U+0027) | `Rareté: ` |
| de | `Gegenstandsklasse: ` | `Seltenheit: ` |
| pt | `Classe do Item: ` | `Raridade: ` |
| es | `Clase de objeto: ` | `Rareza: ` |
| th | `ชนิดไอเทม: ` | `Rarity: ` |
| ko | `아이템 종류: ` | `아이템 희귀도: ` |
| cmn-Hant | `物品種類: ` | `稀有度: ` |
| cmn-Hans | `物品类别: ` | `Rarity: ` |
| ja | `アイテムクラス: ` | `レアリティ: ` |

The renderer has its own copy, `LANGUAGE_DETECTOR` in
`renderer/src/parser/Parser.ts:57-124`, with the same strings as
`itemClassLine` / `rarityLine` plus a `displayLang`. It is used only to word
the wrong-language error. Use one shared constant in the port (e.g.
`backend/src/item-text.ts`), and keep it in sync with the renderer copy.

Design point: detection deliberately accepts **all** languages, whatever
`config.language` is. The renderer then reports `item.wrong_language`
instead of nothing happening. Keep that behaviour.

Other clipboard behaviour in `HostClipboard.ts` the backend should reproduce
(the clipboard/hotkey note covers it in detail): `POLL_DELAY = 48` ms,
`POLL_LIMIT = 500` ms, `RESTORE_AFTER = 120` ms. Before copying, if the
current clipboard already is an item, it is replaced so the poll can see a
change. On Linux it **always** writes the sentinel `__EE2_FORCE_EMPTY_${Date.now()}`
(workarounds for KDE's empty-clipboard prevention and a Proton 10+ bug,
lines 37-50). If `restoreClipboard` is on, the previous text is restored.
The initial delay is `config.widgets.price-check.initialDelay`
(`updateDelay`). The sentinel does not start with any marker, so `isPoeItem`
is false for it.

Experience from the user's `omarchy_new` branch (`main/src/shortcuts/Shortcuts.ts`):
PoE2 under Proton writes the X11 CLIPBOARD, and Hyprland forwards it to
Wayland only while focus allows (the sync is focus-gated). `wl-paste --watch sh -c 'cat; printf "\000"'`
fires once per selection change, even when the text is identical, so
repeated copies of the same item are seen. The first payload (the clipboard
contents when the watch starts) must be ignored, payloads over 512 KiB
dropped, the same text within 250 ms (Wayland) / 1500 ms (X11 poll)
de-duplicated, and the watcher restarted with backoff (1 s → 30 s). It also
polled the X11 clipboard every 150 ms as a fallback.

### 6.2 Markers the renderer parser uses (from `public/data/<lang>/client_strings.js`)

| key | en | ru | fr | de | pt | es | ko | cmn-Hant | ja |
|---|---|---|---|---|---|---|---|---|---|
| `ITEM_CLASS` | `Item Class: ` | `Класс предмета: ` | `Classe d'objet: ` | `Gegenstandsklasse: ` | `Classe do Item: ` | `Clase de objeto: ` | `아이템 종류: ` | `物品種類: ` | `アイテムクラス: ` |
| `RARITY` | `Rarity: ` | `Редкость: ` | `Rareté: ` | `Seltenheit: ` | `Raridade: ` | `Rareza: ` | `아이템 희귀도: ` | `稀有度: ` | `レアリティ: ` |
| `RARITY_NORMAL` | Normal | Обычный | Normal | Normal | Normal | Normal | 일반 | 中 | ノーマル |
| `RARITY_MAGIC` | Magic | Волшебный | Magique | Magisch | Mágico | Mágico | 마법 | 魔法 | マジック |
| `RARITY_RARE` | Rare | Редкий | Rare | Selten | Raro | Raro | 희귀 | 稀有 | レア |
| `RARITY_UNIQUE` | Unique | Уникальный | Unique | Einzigartig | Único | Único | 고유 | 傳奇 | ユニーク |
| `RARITY_GEM` | Gem | Камень | Gemme | Gemme | Gema | Gema | 젬 | 寶石 | ジェム |
| `RARITY_CURRENCY` | Currency | Валюта | Objet monétaire | Währung | Moeda | Objetos monetarios | 화폐 | 通貨 | カレンシー |
| `RARITY_DIVCARD` | Divination Card | Гадальная карта | Carte divinatoire | Weissagungskarte | Carta de Adivinhação | Carta de adivinación | 점술 카드 | 命運卡 | 占いカード |
| `RARITY_QUEST` | Quest | Задание | Quête | Quest | Missão | Misión | 퀘스트 | 任務 | クエスト |
| `HYPHEN` | `-` | `-` | `-` | `-` | `-` | `-` | `-` | `到` | `-` |
| `UNIDENTIFIED` | `/^Unidentified(?:\s*\(Tier\s*(?<tier>\d+)\))?$/` | `Неопознано`/`Ранг` | `Non identifié`/`Palier` | `Nicht identifiziert`/`Level` | `Sem Identificação`/`Nível` | `Sin identificar`/`Grado` | `미확인`/`등급` | `未鑑定`/`階級` | `未鑑定`/`ティア` |

The `CANNOT_USE_ITEM` strings: en `You cannot use this item. Its stats will be ignored`,
ru `Вы не можете использовать этот предмет, его параметры не будут учтены`,
fr `Vous ne pouvez pas utiliser cet objet ; ses stats sont ignorées.`,
de `Du kannst diesen Gegenstand nicht benutzen. Seine Eigenschaften werden ignoriert.`,
pt `Você não pode usar este item. Os efeitos serão ignorados.`,
es `No puedes usar este objeto. Sus estadísticas serán ignoradas`,
ko `아이템 착용 불가. 아이템 효과 미적용`, cmn-Hant `你無法使用這項裝備，它的數值將被忽略`,
ja `このアイテムを使用できません。アイテムの効果は無視されます`.

The full key set is `TranslationDict` in `src/assets/data/interfaces.ts:115-284`.
The en values are in `public/data/en/client_strings.js` (182 lines). Values
ending in `: ` are matched as line prefixes with `startsWith` / `slice`.

### 6.3 Text structure the parser relies on (game output, English example)

```
Item Class: Bows                       ← ITEM_CLASS prefix (value ignored)
Rarity: Rare                           ← RARITY prefix (+ RARITY_* value)
[You cannot use this item. …]          ← optional CANNOT_USE_ITEM, moved into the next block
Oblivion Strike                        ← name   (<<set:..>> / <if:..>{..} markup stripped)
Rider Bow                              ← baseType (absent for Normal/Magic/Currency/…)
--------                               ← section separator, exactly 8 '-'
Physical Damage: 36-61 …
--------
Requires: Level 51, 103 (augmented) Dex
--------
Item Level: 80
--------
{ Prefix Modifier "Shocking" (Tier: 4) — Damage, Elemental, Lightning, Attack }   ← advanced only; split on U+2014 '—'
Adds 5(1-5) to 82(62-89) Lightning Damage        ← value(min-max) rolls; ' — Unscalable Value' suffix possible
…
--------
Corrupted
```

- Meta and uncut-skill-gem variant: the first line is `Rarity: Gem` with no
  `Item Class:` line (fixture `MetaSkillGem`, `specs/Parser/items.ts:425`).
  `isPoeItem` accepts it through `uncutSkillGemLine`.
- Mod-type suffixes on stat lines: ` (implicit)`, ` (enchant)`, ` (rune)`,
  ` (added rune)`, ` (scourge)`, ` (crafted)`, ` (fractured)`,
  ` (desecrated)`. The mod-info line header words are localized
  (`PREFIX_MODIFIER`, `SUFFIX_MODIFIER`, `IMPLICIT_MODIFIER`,
  `FRACTURED_MODIFIER`, `DESECRATED_MODIFIER`, `CRAFTED_MODIFIER`,
  `CORRUPTED_MODIFIER`, `ENCHANT_MODIFIER`, `UNIQUE_MODIFIER`,
  `VAAL_UNIQUE_MODIFIER`), parsed by the `MODIFIER_LINE` regex.
- `Grants Skill: Level 18 …` lines form their own section and are parsed as
  `ModifierType.Skill`. `Grants Skill: Parry` / `Raise Shield` / `Spear Throw`
  are skipped.

### 6.4 Recommendations for the backend detector

1. Same semantics as EE2: `text.startsWith(marker)` over the 22 markers in
   §6.1. Do not trim or normalize the text before passing it on. The parser
   handles `\r\n` and one trailing newline, and `rawText` is shown back to
   users and used for `disc.sectionText` matching.
2. Read with `wl-paste --no-newline --type text/plain;charset=utf-8` (or
   `-t text`). An extra trailing newline is harmless (verified), but avoid
   it anyway.
3. Ignore the sentinel `__EE2_FORCE_EMPTY_*` and anything over about 512 KiB.
4. To warn the user (e.g. on the bar) when a copy lacks advanced
   descriptions, check for `/^\{.*\}$/m`. A rare or magic item without it
   will price-check with no mods (§3.2).

---

## 7. What has to be installed on this machine

Checked on 2026-10-30.

| Need | Status | Action |
|---|---|---|
| JavaScript runtime for the renderer build and tests | Node **26.8.1** (mise; first on `PATH`), npm 11.19, Bun **1.4.3** (`/usr/bin/bun`) | none. Do **not** run the tests with `/usr/bin/node` (nodejs-lts-iron **20.20.2**), because 8 augment tests fail |
| renderer `node_modules` (to run EE2's tests in place) | present in EE2 (vitest 4.1.4) | none (OmaExiled needs its own `npm ci` / `bun install`) |
| Index generation | `make-index-files.mjs` runs on Node or Bun | none |
| QtWebEngine for the host | qt6-webengine **6.11.2** (Chromium 140) installed. Smoke test: QML `WebEngineView` under `qml6` loads, and `Set.prototype.intersection` exists | none for the parser. Note the version skew: qt6-base/declarative/wayland are **6.12.0** while qt6-webengine is 6.11.2. It worked in my test, but upgrade it when Arch ships 6.12 (`sudo pacman -Syu`) |
| layer-shell-qt (headers + CMake config present) | 6.8.1 | none |
| CMake / Ninja to build the Qt host | **not installed** (`cmake`, `ninja` missing; `g++` 16.2.1 and `qmake6` exist) | `sudo pacman -S cmake ninja` (LayerShellQt ships only a CMake package config, `/usr/lib/cmake/LayerShellQt`) |
| wl-clipboard (`wl-paste`/`wl-copy`) | 2.3.0 installed | none |
| Python for `dataParser/` | Python 3.14.8; pandas/numpy/tqdm/requests/cloudscraper/murmurhash not installed | not needed (data is copied, not regenerated) |

---

## 8. Checklist for implementers

- [ ] Copy `renderer/src/parser/**`, `renderer/src/assets/{data/**,client-string-loader.ts,make-index-files.mjs,font.css,font/**}`, `renderer/src/web/background/TradeData.ts` verbatim.
- [ ] Copy `renderer/public/data/{en,ru,cmn-Hant,ko,ja,de,es,pt,fr}/{client_strings.js,items.ndjson,stats.ndjson,app_i18n.json}`, `item-drop.json`, `patrons.json`, `.gitignore` byte for byte. Never copy `*.index.bin`; generate them.
- [ ] Copy the kept images (§1.4) and `icon.ico`/`icon.png`.
- [ ] Make index generation automatic (prebuild + pretest, or in the backend, §2.5).
- [ ] Backend serves the renderer at the origin root with `text/javascript` for `.js`, proper 404s, and no-cache/ETag on `/data/**`. The proxy for `www.pathofexile.com/api/trade2/data/{items,stats}` must work before the WebSocket connects.
- [ ] Keep `AppConfig()` (`language`, `price-check.savedAugments`) and `Host.proxy` signatures. Fix `Host.isElectron` for QtWebEngine.
- [ ] The copy shortcut must produce advanced mod descriptions (Ctrl+Alt+C by default).
- [ ] Item check without map check: edit `WidgetItemCheck.vue:68` and `item-check/widget.ts:2`.
- [ ] Port 21 spec files (494 tests). Drop `client-log.test.ts`, `library/libraryChaos.test.ts`, `FullCampaign.txt`, `fetchResponses2.json`. Update `vitest.setup.ts` mocks and `defaultConfigMock` for the trimmed Config. Run with Node ≥22 or `bun --bun vitest run`.
