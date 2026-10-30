# 05 — Trade API client, rate limiting, price/trend sources, and the `/proxy/` contract

Source analysed: `/home/ultra/Developer/Exiled-Exchange-2` @ `master` (EE2 0.16.3, Electron ^40.9.1).
The user's Linux branches (`omarchy`, `omarchy_2`, `omarchy_new`) do **not** change anything in this
area: `git diff master...<branch>` touches only shortcuts, windowing, the Hyprland watcher, and
`OverlayWindow.vue`. Nothing in `proxy.ts`, `trade/*`, `Prices.ts`, `Leagues.ts`, or `TradeData.ts` changed.

All paths below are relative to the EE2 repo root unless absolute. `R/` = `renderer/src/`.

Live probes were run on 2026-10-30 against the real endpoints, with about 8 requests in total. The
captured headers and bodies are quoted in §15, and they confirm the formats described here.

---

## 0. TL;DR for implementers

* The renderer never talks to the internet directly, except for `<img src>` item icons from
  `web.poecdn.com` and links opened in an external browser. Every API call goes through
  `Host.proxy(url, init)` = `window.fetch("/proxy/" + url, init)` (`R/web/background/IPC.ts:84-86`).
  `url` is **`host/path?query` without a scheme**.
* The backend must serve `ANY /proxy/<host>/<path>?<query>` on the **same origin** that serves the
  renderer (`http://127.0.0.1:<port>`). It forwards the request to `https://<host>/<path>?<query>`
  and returns the upstream **status, headers (especially `x-rate-limit-*`, `retry-after`,
  `content-type`) and body byte-for-byte**. Because it is same-origin, CORS is not involved. Do not
  add CORS headers.
* The **client-side** rate limiter (`RateLimiter.ts`, `common.ts`) is driven entirely by the
  `x-rate-limit-rules`, `x-rate-limit-<rule>`, and `x-rate-limit-<rule>-state` response headers. If
  the proxy drops them, the client falls back to 1 request per 5 s per policy forever.
* The renderer reads trade API bodies as JSON **regardless of HTTP status**. For example, a 400
  response carries `{"error":{"code":2,"message":"Unknown category"}}` and the renderer shows the
  message. So the proxy must not replace upstream error bodies.
* Price/trend data comes from **`api.exiledexchange2.dev`** (EE2 maintainer's mirror of poe.ninja PoE2
  economy data), **not** directly from poe.ninja. The parser does raw `indexOf` string scanning
  on the JSON text, so the body **must be passed through byte-exact**: no re-serialization and no
  pretty-printing.
* No poe2scout usage exists anywhere in EE2. poeprices.info code exists but its UI is commented out,
  so it is effectively dead.
* POESESSID is **never handled explicitly** in EE2. Logged-in behavior (higher limits, private
  leagues, complex queries) and Cloudflare clearance came from the Electron session cookie jar,
  which is shared between the proxy (`net.request({useSessionCookies:true})`) and the built-in
  `<webview>` browser. The port has no `<webview>`, so it needs its own cookie strategy (§14, §16.6).
* `Host.isElectron` is `navigator.userAgent.includes("Electron")`. Under QtWebEngine it is
  **false**, which changes how trade links open (§13). Two "Browser" buttons call `showBrowser()`
  unconditionally and will silently do nothing without a renderer patch (§17).

---

## 1. Renderer transport: `Host.proxy`

`R/web/background/IPC.ts:84-86`

```ts
proxy: (typeof window)["fetch"] = async (url, init) => {
  return await window.fetch(`/proxy/${url as string}`, init);
};
```

* `url` must be a string. Request objects are not supported. Examples:
  `www.pathofexile.com/api/trade2/search/Standard`,
  `api.exiledexchange2.dev/proxy/data/namespaceMap.json`.
* The path is **relative**, so the page must be loaded from the backend origin. The Qt host must load
  `http://127.0.0.1:<port>/index.html`, never `file://` or `qrc://`.
* League names are interpolated **unencoded**, for example `.../search/Runes of Aldur`. The browser's
  URL parser percent-encodes spaces to `%20` before the request hits the proxy. The proxy must
  forward the path **as received** (still encoded) and must not decode it.
* Dev mode: `renderer/vite.config.mts` `server.proxy` forwards `^/(config|uploads|proxy)` and the
  `/events` websocket to `http://127.0.0.1:8584`. EE2 main listens on port 8584 when
  `VITE_DEV_SERVER_URL` is set (`main/src/server.ts:131`), otherwise on port 0 (random) on
  `127.0.0.1`. `--listen=[host][:port]` overrides this (`server.ts:133-139`).

---

## 2. EE2's Electron proxy — exact current behavior (`main/src/proxy.ts`)

Registered as an extra `"request"` listener on the same Node `http.Server` that serves static files.
The static handler explicitly skips `/config`, `/uploads`, and `/proxy` (`main/src/server.ts:20-27`).

1. **Match**: `if (!req.url?.startsWith("/proxy/")) return;` (line 25).
2. **Host extraction**: `const host = req.url.split("/", 3)[2];`, which is the first segment after
   `/proxy/` (line 26). If a query string follows the host directly, such as `/proxy/host?x`, the
   segment becomes `host?x` and fails the allowlist.
3. **Allowlist** (lines 5-19). The `official` flag is computed but **otherwise unused** in this
   file:

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
   | `api.exiledexchange2.dev` | false |

   If the host is not listed, `req.destroy()` resets the socket and the renderer's `fetch` rejects
   with `TypeError: Failed to fetch` (line 31).
4. **Request header filtering** (lines 33-43). Deletes every header whose name starts with `sec-`
   (`sec-fetch-*`, `sec-ch-ua*`), plus `host`, `origin`, and `content-length`. Everything else from
   the renderer is forwarded: `accept`, `content-type`, `accept-language`, `accept-encoding`,
   `referer`, `cookie` (normally none for 127.0.0.1), `connection`, and so on.
5. **Upstream request** (lines 45-54): `net.request({ url: "https://" + req.url.slice("/proxy/".length), method: req.method, headers: {...req.headers, "user-agent": app.userAgentFallback}, useSessionCookies: true, referrerPolicy: "no-referrer-when-downgrade" })`
   * The URL is `https://` plus the raw remaining path and query, so percent-encoding is preserved.
     Only HTTPS is used.
   * **User-Agent is always replaced** with Electron's `app.userAgentFallback`, a Chromium-like UA
     that also contains `exiled-exchange-2/<ver>` and `Electron/<ver>` tokens. This is the **same
     UA as the built-in `<webview>`**, which matters because Cloudflare `cf_clearance` is bound to
     the UA.
   * `useSessionCookies: true` attaches cookies from Electron's **persistent** `session.defaultSession`
     jar and stores `Set-Cookie` responses back into it. That jar is shared with the `<webview>`,
     which has no `partition` attribute, so it uses the default session. This is how login and
     captcha solving reached the proxy.
   * Redirects are followed (Electron default).
   * No timeout.
6. **Body**: `req.pipe(proxyReq)` streams the request body (line 75).
7. **Response** (lines 55-69): copies **all** upstream headers except `content-encoding`. Electron
   `net` decodes the body, so `content-encoding` is removed. The status code and status message are
   passed through unchanged, and the body is piped. `set-cookie` is copied too, but the browser
   rejects it because the `domain=.pathofexile.com` attribute does not match 127.0.0.1.
8. **Errors** (lines 66-67, 70-73): the proxy logs `error [proxy] <message> (<host>)` through the
   RemoteLogger and calls `res.destroy(err)`. The renderer then sees a network error (`TypeError:
   Failed to fetch`).
9. **Cookie fix-up** (lines 77-90): `session.defaultSession.webRequest.onHeadersReceived` removes the
   `Partitioned` attribute from every `set-cookie` header. The reason is that Cloudflare sets
   partitioned cookies, which `net.request` cannot store.

---

## 3. Which host is used: `poeWebApi()` / `getTradeEndpoint()`, realm, language

`R/web/Config.ts:91-116`. `getTradeEndpoint` is a re-export of `poeWebApi` (`R/web/price-check/trade/common.ts:7`).

```
if (preferredTradeSite === "www") return "www.pathofexile.com";
switch (language):
  en       -> www.pathofexile.com
  ru       -> ru.pathofexile.com
  cmn-Hant -> realm === "pc-garena" ? pathofexile.tw : www.pathofexile.com
  ko       -> poe.kakaogames.com
  ja       -> jp.pathofexile.com
  de       -> de.pathofexile.com
  es       -> es.pathofexile.com
  pt       -> br.pathofexile.com
  fr       -> fr.pathofexile.com
```

* Config keys: `language` (`"en"|"ru"|"cmn-Hant"|"ko"|"ja"|"de"|"es"|"pt"|"fr"`, default `"en"`),
  `preferredTradeSite` (`"default"|"www"`, default `"default"`), `realm` (`"pc-ggg"|"pc-garena"`,
  default `"pc-ggg"`) (`Config.ts:144-148, 204-208`).
* **Realm**: EE2 supports only the PC realms `pc-ggg` and `pc-garena`. There is **no xbox/sony
  support anywhere**. Realm is used in exactly four places:
  1. `poeWebApi()` for the `cmn-Hant` host.
  2. `Prices.load()`, which loads ninja prices **only when `realm === "pc-ggg"`** (`Prices.ts:160`).
  3. `useLeagues().selected.realm` (`Leagues.ts:41`).
  4. `CheckedItem.vue:164-167`: `useEn = (language==="cmn-Hant" && realm==="pc-ggg") || preferredTradeSite==="www"`.
     This makes queries use English ref names instead of translated names.
  * Config upgrade v12 forces `realm = "pc-ggg"` (`Config.ts:385`).
* Trade **API** URLs contain **no realm segment**, for example `/api/trade2/search/<league>`. For
  `/api/trade2/*`, the server assumes the `poe2` realm. Trade **site links** do contain one:
  `/trade2/search/poe2/<league>` (§13).
* `TradeData` (stats/items) **always** uses `www.pathofexile.com` to get English reference data
  (`R/web/background/TradeData.ts:52-55, 102-105`).

---

## 4. Endpoint catalogue

All of these go through `/proxy/`. `<H>` is `poeWebApi()`. `<league>` is the raw league id, which
the browser %20-encodes.

| # | Method | Renderer call (`Host.proxy` arg) | Real URL | Explicit req headers | Body | Client RL policy | Code |
|---|---|---|---|---|---|---|---|
| 1 | POST | `<H>/api/trade2/search/<league>` | `https://<H>/api/trade2/search/<league>` | `Accept: application/json`, `Content-Type: application/json` | search JSON (§5.1) | SEARCH | `pathofexile-trade.ts:1257-1299` |
| 2 | GET | `<H>/api/trade2/fetch/<id1,id2,...≤10>?query=<searchId>` | same with https | none (browser default `Accept: */*`) | — | FETCH | `pathofexile-trade.ts:1301-1334` |
| 3 | POST | `<H>/api/trade2/exchange/<league>` | `https://<H>/api/trade2/exchange/<league>` | `Accept: application/json`, `Content-Type: application/json` | exchange JSON (§5.2) | EXCHANGE | `pathofexile-bulk.ts:67-106` |
| 4 | GET | `<H>/api/trade2/data/leagues` | same | none | — | none | `Leagues.ts:52-54` |
| 5 | GET | `www.pathofexile.com/api/trade2/data/stats` | same | none (with `signal`) | — | none | `TradeData.ts:52-58` |
| 6 | GET | `www.pathofexile.com/api/trade2/data/items` | same | none (with `signal`) | — | none | `TradeData.ts:102-108` |
| 7 | GET | `api.exiledexchange2.dev/proxy/data/item-drop.json` | same | none (with `signal`) | — | none | `Prices.ts:173-176` |
| 8 | GET | `api.exiledexchange2.dev/proxy/data/namespaceMap.json` | same | none (with `signal`) | — | none | `Prices.ts:191-198` |
| 9 | GET | `api.exiledexchange2.dev/proxy/<ninjaLeagueForProxy>/overviewData.json` | same | none (with `signal`) | — | none | `Prices.ts:199-205` |
| 10 | GET | `www.poeprices.info/api?i=<b64>&l=<league>&s=awakened-poe-trade` | same | none | — | none (own cache) | `poeprices.ts:31-56` (**UI disabled**) |
| 11 | POST | `www.poeprices.info/send_feedback` | same | browser sets `multipart/form-data; boundary=…` | FormData | none | `poeprices.ts:102-126` (**UI disabled**) |

Notes:

* `<ninjaLeagueForProxy>` = `selectedLeagueToUrl(true)` (`Prices.ts:245-262`): `"Standard"` becomes
  `"standard"`, `"Hardcore"` becomes `"hardcore"`, and any other league is the **raw id**, for
  example `Runes of Aldur`, which reaches the server as `Runes%20of%20Aldur`.
* Who sets which headers:
  * **User-Agent** is set by the proxy and overrides the renderer's.
  * **Cookie** is set by the proxy's cookie jar. The renderer never sets cookies.
  * **Content-Type** is set by the renderer for #1 and #3, and by the browser for #11 (multipart).
  * **Accept** is `application/json` for #1 and #3, and the browser default otherwise.
* Item icons in fetch results (`item.icon`, `https://web.poecdn.com/...`) are rendered directly via
  `<img :src>` (`R/web/ui/UiItemImg.vue`, `TooltipItem.vue:5`). They are **not proxied**.
* Static game data (`/data/<lang>/items.ndjson`, `stats.ndjson`, `app_i18n.json`, `/data/item-drop.json`, …)
  is fetched from the backend's own static server via `fetch(import.meta.env.BASE_URL + "data/…")`
  (`R/assets/data/index.ts:159-292`, `R/web/i18n.ts:16,28`). It is not proxied, and other notes
  cover it.
* There are **no** other outbound fetches in the trimmed feature set.
  `R/web/item-search/WidgetItemSearch.vue` uses `usePoeninja()` but is being dropped.

---

## 5. Request bodies

### 5.1 Trade search body (`createTradeRequest`, `pathofexile-trade.ts:567-1253`; type `TradeRequest` `:264-376`)

```jsonc
{
  "query": {
    "status": { "option": "available" | "securable" | "online" | "any" },  // filters.trade.listingType; "onlineleague" coerced to "securable" (:572-577)
    "name": "<string>" | { "discriminator": "<filters.discriminator.trade>", "option": "<name>" },  // optional (:623-627, nameToQuery :1471-1480)
    "type": "<string>" | { "discriminator": "...", "option": "<baseType>" },                      // optional (:629-633)
    "stats": [
      { "type": "and", "filters": [ { "id": "<tradeId>[|<option>]", "value": { "min"?: n, "max"?: n }, "disabled": bool }, ... ] },
      // additional groups: {type:"count", value:{min:1[,max:1]}, disabled, filters:[...]}, {type:"not", filters:[{id}], disabled?}
    ],
    "filters": {
      "type_filters":      { "filters": { "category"?: {"option": "<CATEGORY_TO_TRADE_ID>"}, "rarity"?: {"option": "nonunique"|"uniquefoil"|"magic"|<filters.rarity.value>}, "ilvl"?: {min,max?}, "quality"?: {min} } },
      "equipment_filters": { "filters": { "ar"|"ev"|"es"|"ward"|"block"|"dps"|"pdps"|"edps"|"crit"|"aps"|"spirit"|"reload_time": {min?,max?}, "rune_sockets"?: {min} } },
      "req_filters":       { "filters": { "lvl"?: {"max": n} } },
      "map_filters":       { "filters": { "map_tier"?: {min,max}, "map_revives"|"map_packsize"|"map_magic_monsters"|"map_rare_monsters"|"map_bonus"|"map_iir"|"map_gold": {min}, "ultimatum_hint"?: {"option": "Victorious"|"Cowardly"|"Deadly"} } },
      "misc_filters":      { "filters": { "gem_level"?: {min,max?}, "gem_sockets"?: {min}, "area_level"?: {min?|max?}, "identified"?: {"option":"false"}, "unidentified_tier"?: {min}, "corrupted"?: {"option":"true"|"false"}, "fractured_item"?: {"option":"false"}, "mirrored"?: {"option":"false"}, "sanctified"?: {"option":"false"}, "veiled"?: {"option":"true"} } },
      "trade_filters":     { "filters": { "price"?: {"option": "exalted"|"chaos"|"divine"|"exalted_divine"}, "collapse"?: {"option":"true"}, "indexed"?: {"option": "1day"|"3days"|"1week"|"2weeks"|"1month"|"2months"} } }
    }
  },
  "sort": { "price": "asc" }
}
```

* Boolean options are **strings** (`String(true)` / `String(false)`).
* `filters` is built with `dot-prop` `setProperty`, so sub-objects exist only when set. Values set
  to `undefined` disappear in `JSON.stringify`.
* `trade_filters.collapse` is added only when `filters.trade.collapseListings === "api"`
  (config `price-check.collapseListings`, default `"api"`) (`:601-607`).
* The category mapping is in `CATEGORY_TO_TRADE_ID` (`:35-87`). An unknown category throws
  `Invalid category: …` (`:641`).
* Special stat handling (`:864-1174`):
  * `item.has_empty_modifier` adds a count group.
  * Flask `#% increased Charge Recovery` adds a "not" group.
  * `item.elemental_dps` adds a "not" group for the other elements.
  * Mageblood `item.duplicates` adds a count group (`buildMageBloodNotFilter` `:1933-2097`). It
    throws `not valid Mageblood, reduce duplicates or unselect a Legacy`.
  * `Only affects Passives in # Ring` adds a count group with `id|N` (`:1195-1213`).
  * Multi-id stats become `count` groups.
  * Veiled adds pseudo `pseudo.pseudo_number_of_unrevealed_mods` (`:1227-1250`).
* Stat id with an option: `tradeId + "|" + option.value` (`tradeIdToQuery`, `:1430-1469`).
  `tradeInvert` swaps and negates min/max (`getMinMax`, `:1418-1428`).
* `createTradeRequest` **mutates** `filters.trade.listingType` when it is `"onlineleague"`.
* The body must be cacheable as a key, so it must be deterministic (see Cache, §8).

### 5.2 Bulk exchange body (`pathofexile-bulk.ts:17-27, 139-169`)

```json
{
  "engine": "new",
  "query": {
    "have": ["divine","exalted","chaos"],
    "want": ["<item.info.tradeTag>"],
    "status": { "option": "online" | "onlineleague" | "any" },
    "minimum": 123
  },
  "sort": { "have": "asc" }
}
```

* `minimum` is present only if the `filters.stackSize` filter is enabled. Otherwise it is
  `undefined` and omitted.
* `listingType` `"securable"` and `"available"` are coerced to `"online"`, and the function mutates
  `filters` (`:144-152`).
* The `have` list is chosen in `bulk-api.ts:28-43`:

  | item | `have` |
  |---|---|
  | `Exalted Orb` | `["divine","chaos"]` |
  | `Chaos Orb` | `["divine","exalted"]` |
  | `Divine Orb` | `["exalted","chaos"]` |
  | any other | `["divine","exalted","chaos"]` |

  The comment on this explains: "at league start many players set wrong price, and this breaks
  optimistic search".

### 5.3 Which API is used: `apiToSatisfySearch` (`common.ts:26-45`)

| condition | API |
|---|---|
| any enabled stat filter | `"trade"` |
| `filters.stackSize` exists and the item is a Divination Card or Map | `"trade"` if stackSize is disabled, otherwise `"bulk"` |
| item has `info.tradeTag` | `"bulk"` |
| otherwise | `"trade"` |

`CheckedItem.vue:198-206`: when the API is bulk, it forces `itemFilters.trade.listingType = "online"`.

---

## 6. Responses and status handling

### 6.1 Shapes

* **Search** (`SearchResult`, `pathofexile-trade.ts:378-383`):
  `{ id: string, result: string[] /* ≤100 ids */, total: number, inexact?: boolean }`.
  The live response also contains `complexity: number`, which is unused.
* **Fetch** (`:414-477`): `{ result: Array<FetchResult|null> }`.
  * Null entries are filtered out (`:1326`).
  * Fields used: `id`, `gone`, the `item.*` display fields, `listing.indexed` (ISO date →
    luxon relative), `listing.fee` (present means instant buyout), `listing.price{amount, currency, type}`,
    `listing.account{name, lastCharacterName, online?:{status?:"afk"}|null}`, and `listing.in_demand`.
  * Item properties used by numeric `type`: `78` = item level, `6` = quality, `5` = gem level
    (`:1376-1384`).
* **Exchange** (`pathofexile-bulk.ts:29-51`): `{ id, result: Record<string, FetchResult>, total }`.
  Each `listing.offers[]` has `{ exchange:{currency, amount}, item:{amount, stock} }`. Only listings
  with exactly one offer are used (`:186-188`).
* **Leagues**: `{ result: [{ id, realm: "poe2", text }] }`.
* **Error JSON** (`TradeResponse`, `common.ts:17-24`): `{ "error": { "code": number, "message": string } }`.
  Codes observed live: `2` "Unknown category" with HTTP 400. GGG developer-doc codes, not all
  observed: 1 not found, 2 invalid query, 3 rate limit exceeded, 4 internal error, 5 unexpected
  content type, 6 forbidden, 7 temporarily unavailable, 8 unauthorized, 9 method not allowed,
  10 unprocessable.

### 6.2 How each consumer reacts to status codes and bodies

| Consumer | Reads headers | Status check | Body handling | User-visible result on failure |
|---|---|---|---|---|
| search (`:1271-1289`) | `adjustRateLimits(SEARCH, response.headers)` **before** parsing, for any status | **none** | `response.json()`; if `.error` then `throw new Error(error.message)` | error box in `TradeListing.vue` shows the message. If the message starts with `"Query is too complex."`, a hint `:fix_complex_query` is added (`TradeListing.vue:257-263`) |
| fetch (`:1315-1327`) | `adjustRateLimits(FETCH, …)` | none | same | same |
| exchange (`pathofexile-bulk.ts:78-96`) | `adjustRateLimits(EXCHANGE, …)` | none | same | `TradeBulk.vue` error box |
| leagues (`Leagues.ts:52-57`) | — | `if (!response.ok) throw new Error(JSON.stringify(Object.fromEntries(response.headers)))` | `.json()` | "Failed to load leagues" box. The message is the **response headers as JSON**, so a Cloudflare `cf-mitigated` header would be visible |
| stats/items (`TradeData.ts`) | — | none | `.text()`, then `JSON.parse` | `error.value` and `console.warn`. Parsing falls back to bundled data |
| ninja (`Prices.ts:172-205`) | — | none | `.text()`, then `JSON.parse`/string scanning | errors swallowed (`console.warn`). No prices or trends are shown |
| poeprices (`poeprices.ts:42-53`) | — | none | `.json()`, or throws `"<status>, poeprices.info API is under load or down."`; `data.error !== 0` throws `error_msg` | disabled UI |

Consequences for the proxy:

* An **HTML Cloudflare challenge** (403) on search causes `response.json()` to throw `SyntaxError`
  (`Unexpected token '<' …`), and that message is shown.
* On **429**, the body is GGG JSON (`code 3`, `"Rate limit exceeded"`). The renderer shows it, and
  `adjustRateLimits` ingests the state headers. **`Retry-After` is never read by the renderer**
  (grep confirms there is no occurrence).
* A **network error** (socket destroyed) causes `fetch` to reject with `TypeError: Failed to fetch`,
  which is shown verbatim.
* The renderer's own preflight throttling error (§7.6) is `"Retry after N seconds"`. This message is
  produced client-side and is **not** related to the HTTP `Retry-After` header.

---

## 7. Rate limiting (renderer-side, fully client-driven)

### 7.1 Server headers (GGG format — confirmed live, §15)

```
x-rate-limit-policy: trade-search-request-limit            # informational, NOT read by client
x-rate-limit-rules: Ip                                      # comma list, e.g. "Ip" or "Ip,Account" when logged in
x-rate-limit-ip: 5:10:60,15:60:300,30:300:1800,600:21600:3600       # max:windowSec:penaltySec per entry
x-rate-limit-ip-state: 1:10:0,1:60:0,1:300:0,1:21600:0              # currentHits:windowSec:activePenaltySec
retry-after: <sec>                                          # only on 429 (per GGG docs; not observed live)
```

Live policies (2026-10-30, anonymous, IP rule):

| Policy (endpoint) | `x-rate-limit-ip` |
|---|---|
| `trade-search-request-limit` (search) | `5:10:60,15:60:300,30:300:1800,600:21600:3600` |
| `trade-fetch-request-limit` (fetch) | `12:4:10,16:12:300,50:300:300,1000:21600:1800` |
| `trade-exchange-request-limit` (exchange) | `5:15:60,10:90:300,30:300:1800` |

The data endpoints (leagues, stats, items) return **no** rate-limit headers (they are Cloudflare-cached).
GGG also sends `access-control-expose-headers: X-Rate-Limit-Policy, X-Rate-Limit-Rules, X-Rate-Limit-Ip, X-Rate-Limit-Ip-State`.
That header is irrelevant here because the request is same-origin.

### 7.2 Client limiter sets (`common.ts:51-57`)

```ts
RATE_LIMIT_RULES = {
  SEARCH:   shallowReactive(new Set([new RateLimiter(1, 5)])),
  EXCHANGE: shallowReactive(new Set([new RateLimiter(1, 5)])),
  FETCH:    shallowReactive(new Set([new RateLimiter(1, 5)])),
}
```

Each policy starts with a placeholder limit of 1 request per 5 s. It is replaced by the real limits
after the first response that carries headers. These are module-level singletons, one per JS
context. **If the port runs more than one WebEngine page that performs trade requests, each page
has independent limiter state** (see §16.8).

### 7.3 `RateLimiter` (`RateLimiter.ts`)

* Fields: `max`, `window` (seconds, **already including the latency fudge**, §7.4), `stack:
  ResourceHandle[]` (active borrows), and `queue: shallowRef<number>` (the number of waiters,
  shown in the UI).
* `ResourceHandle(millis, cb)` (`:143-173`): records `borrowedAt` and `releasedAt = borrowedAt + millis`.
  Its `promise` resolves after `millis` via `setTimeout`, which also removes the handle from `stack`.
  `cancel(reason)` clears the timer, removes the handle, and rejects the promise.
* `wait(borrow=true)` → `_wait` (`:14-31`):
  1. If the limiter is destroyed, throw `Error("RateLimiter is no longer active")`.
  2. If `isFullyUtilized` (`stack.length >= max`): `queue++`, `await stack[0].promise` (the oldest
     borrow expiring), `queue--`, then recurse.
  3. Otherwise, if `borrow`, `push()` a new handle with `window*1000` ms. The push happens
     **synchronously** inside the async function before any await, so non-awaited `rl.wait()`
     calls borrow immediately when capacity exists.
  * Quirk: if `stack[0].promise` rejects (cancelled by `destroy`), `queue--` never runs and the
    error propagates to `waitMulti`.
* `static waitMulti(limiters)` (`:43-66`):
  1. `await Promise.all(limiters.map(rl => rl.wait(false)))` waits until **every** limiter has
     capacity, without borrowing.
  2. If any of them threw `"RateLimiter is no longer active"`, retry `waitMulti` with the **same
     Set object**. `adjustRateLimits` has meanwhile mutated that Set, so the retry sees the new
     limiters.
  3. After all resolve, if every limiter still has capacity, call `rl.wait()` on all of them
     (borrow 1 each, not awaited). Otherwise retry, because another waiter took the slot.
* `static estimateTime(count, limiters, ignoreState=false)` (`:68-116`) simulates when `count`
  requests could be sent:
  * Each limiter becomes `{max, window, stack: sorted(handle.releasedAt - now)}`, or an empty stack
    if `ignoreState`.
  * `total = 0`. Repeat `count` times:
    * While any simulated stack has `length >= max`:
      `waitTime = max over saturated limits of (stack[0] - total)` (floored at 0),
      `total += waitTime`, and each stack drops entries `<= total`.
    * Push `total + window*1000` onto every stack.
  * Return `total` in ms.
  * The code comment notes that the existing queue cannot be simulated.
* `destroy()` (`:130-136`): sets `_destroyed`. If `queue > 0`, it cancels `stack[0]` with
  `"RateLimiter is no longer active"`, which wakes the queued waiters so they retry against the new
  limiter set.
* `isEqualLimit(o)`: `max === o.max && window === o.window`.
  `available = max(max - stack.length, 0)`.
  `toString()`: `RateLimiter<max=…:window=…>: (stack=…,queue=…)`.

### 7.4 Syncing from headers: `adjustRateLimits(set, headers)` (`common.ts:59-148`)

1. If there is no `x-rate-limit-rules` header, **return without changes**. If the proxy strips
   these headers, the limiter stays at 1 request per 5 s.
2. `rules = headers.get("x-rate-limit-rules").split(",")` (for example `["Ip"]`).
   * `limitStr = rules.map(r => headers.get("x-rate-limit-" + r)).join(",")`
   * `stateStr = rules.map(r => headers.get("x-rate-limit-" + r + "-state")).join(",")`
   * `Headers.get` is case-insensitive, so `x-rate-limit-Ip` works.
   * A missing per-rule header becomes the string `"null"`, which parses to `NaN` limits.
3. `DESYNC_FIX = AppConfig("price-check").apiLatencySeconds` (default **2**, set in config upgrade
   v6, `Config.ts:290-297`; also in the widget defaults in `PriceCheckWindow.vue:187`).
4. Parse each server entry `max:window:penalty` into `{max, window: window + DESYNC_FIX, state: Number(stateEntry.split(":")[0])}`.
   State entries are aligned **by index**. The **penalty field and the state's third field (active
   restriction seconds) are ignored.**
5. **Destroy** client limiters that have no equal `(max, window)` server rule: delete them from the
   Set and call `destroy()`.
   * Changing `apiLatencySeconds` therefore recreates all limiters on the next response.
6. **Sync** existing limiters: `delta = server.state - limiter.stack.length`. If `delta > 0`, borrow
   `min(delta, available)` extra slots via `limiter.wait()`. If `delta <= 0`, do nothing.
7. **Add** server rules that have no client limiter: create `new RateLimiter(max, window+DESYNC_FIX)`
   and call `wait()` `state` times.
   * On a 429, where `state > max`, the excess `wait()` calls queue as phantom borrowers. This
     delays later real requests further.
   * The server's restriction duration is not honored directly, because **`Retry-After` is
     ignored**.

### 7.5 Where limiters are applied

| Call | Pre-check | Wait | Sync |
|---|---|---|---|
| search | `preventQueueCreation([{count:1, SEARCH}, {count:1, FETCH}])` | `waitMulti(SEARCH)` | `adjustRateLimits(SEARCH, headers)` |
| fetch | none | `waitMulti(FETCH)` | `adjustRateLimits(FETCH, headers)` |
| exchange | `preventQueueCreation([{count:1, EXCHANGE}])` | `waitMulti(EXCHANGE)` | `adjustRateLimits(EXCHANGE, headers)` |

Cache hits skip all of the above (§8). Leagues, stats/items, ninja, and poeprices are **not**
rate-limited client-side.

Startup behavior: the first trade search starts two fetches in parallel (§9.1). The second fetch
queues behind the 1-per-5 s placeholder. When the first fetch's headers arrive, the placeholder is
destroyed, the queued waiter is rejected, `waitMulti` retries against the real limits, and the
second fetch proceeds immediately.

### 7.6 `preventQueueCreation(targets)` (`common.ts:150-172`)

```
For each target:
  estimated = estimateTime(count, limiters)
  clean     = estimateTime(count, limiters, ignoreState=true)
  value     = estimated === clean ? 0 : estimated   // "ignore if impossible to run without queue"
ms = max(values)
if (ms >= 1500) throw new Error(`Retry after ${Math.round(ms/1000)} seconds`)
```

This error is shown in the trade error box. It is a purely client-side refusal; no request is sent.

### 7.7 UI

`R/web/price-check/trade/RateLimiterState.vue` is a "Rate limiting" button that turns red and shakes
when any limiter has a queue. The panel lists the policies `trade-search-request-limit`,
`trade-exchange-request-limit`, and `trade-fetch-request-limit` with `active / max over window`.
Its visibility is persisted in config `price-check.showRateLimitState` (default false). It is
imported by `PriceCheckWindow.vue:154,219`.

---

## 8. Caching

### 8.1 `Cache` (`R/web/price-check/trade/Cache.ts`)

* In-memory `Map<sha1, value>`. The key is `object-hash` `sha1(JSON.parse(JSON.stringify(key)))`.
* `set(key, value, ttlSec)` deletes the entry after `ttlSec` via `setTimeout`.
* `deriveTtl(...limiters)` returns `300` if any limiter was passed, otherwise `0`. The sets are
  never empty, so the TTL is effectively **always 300 s**.
* `purgeIfDifferentCurrency(cur)`: if `cur` is truthy and differs from the stored value, it clears
  the whole cache.
* Instances:
  * `pathofexile-trade.ts:1255`: one cache shared by search and fetch.
    * Search key: `[body, leagueId]`.
    * Fetch key: the `resultIds` array only. The `queryId` is **not** part of the key.
    * `requestResults` calls `cache.purgeIfDifferentCurrency(xchgRateCurrency.value?.id)` first
      (`:1308`), so changing the core currency clears both search and fetch results.
  * `pathofexile-bulk.ts:65`: exchange cache, key `[body, leagueId]`, TTL 300.
  * `poeprices.ts:7`: key is the query string, TTL 300.
* Errors are never cached.
* Implication for the backend: **no proxy-side caching is needed** for POST or trade calls, and
  none must be added.

### 8.2 HTTP caching (incidental)

Upstream responses carry cache headers:
* leagues: `cache-control: public, max-age=14400`
* `api.exiledexchange2.dev`: `cache-control: max-age=14400`, plus `etag` and `last-modified`

EE2 forwarded these, so Chromium's HTTP cache in the renderer could serve `/proxy/...` GETs for up
to 4 h. This includes the leagues "Refresh" button and ninja reloads. Passing them through keeps
parity. Stripping them makes refreshes truly fresh at the cost of more traffic. Either is
acceptable; parity is recommended.

### 8.3 `artificialSlowdown(ms)` (`artificial-slowdown.ts`)

This is UI-only. It delays showing results so that switching items does not flicker:

| Component | Delay | Placeholders |
|---|---|---|
| `TradeListing.vue:159` | 900 ms | 20 placeholder rows (`SHOW_RESULTS = 20`, `:161`) |
| `TradeBulk.vue:184` | 900 ms | 8 rows |
| `PriceTrend.vue:157` | 800 ms | — |

`reset(item)` restarts the timer only when the item identity changes. It has no network relevance.

---

## 9. Search orchestration

### 9.1 Trade (`trade-api.ts`)

Constants: `API_FETCH_LIMIT = 100`, `MIN_NOT_GROUPED = 7`, `MIN_GROUPED = 10`.

1. `search()` increments `searchId`, resets state, builds the body, and calls
   `requestTradeResultList(body, filters.trade.league)`.
2. If a newer search started meanwhile, it returns.
3. It fetches two pages **in parallel**: ids `[0,10)` and, if there are more than 10 results,
   `[10,20)`. The second page is appended after the first to keep the order.
4. `fetchMore()` runs sequentially, 10 ids per call, while all of these hold:
   * `totalNotGrouped < 7 || totalGrouped < 10`
   * `fetched < result.length`
   * `fetched < 100`
   * `searchId` is unchanged
5. `groupedResults` (`:23-49`) merges a listing into an existing row when the account and the
   price/currency are the same, or when the account is the same and the row is one of the last
   two. A merge adds to `stackSize` if present, otherwise increments `listedTimes`.

The test `renderer/specs/web/useTradeApi.test.ts` asserts the call counts for result counts:

| results | `requestResults` calls |
|---|---|
| 1 | 1 |
| 10 | 1 |
| 11 | 2 |
| 20 | 2 |
| 21 | 3 |

GGG constraints this relies on: search returns at most 100 ids, and fetch accepts at most 10 ids
per call (comma-joined in the path).

### 9.2 Bulk (`bulk-api.ts`, `pathofexile-bulk.ts:171-230`)

1. One optimistic exchange request is sent with all `have` currencies.
2. Per `have` tag, offers are filtered by `exchange.currency === tag`, sorted by
   `exchange.amount / item.amount` ascending, and the top `SHOW_RESULTS = 8` are kept.
3. The `exalted` tab is marked as **loaded on demand** (`null`) when it has fewer than 8 results and
   `total > 100`. It is fetched lazily with `have=[tag]` when its tab's `listedLazy` computed is
   first read (`bulk-api.ts:84-110`). The other tab's estimated total is then corrected.
4. The tabs are `xchgStable` (divine), `xchgExalted`, and `xchgChaos`. Auto-selection is in
   `TradeBulk.vue:228-249`.

---

## 10. Price / trend source: `usePoeninja` (`R/web/background/Prices.ts`)

### 10.1 Data source

All data comes from `api.exiledexchange2.dev`, which mirrors and aggregates the poe.ninja PoE2
economy. `poe.ninja` itself is only **linked**, never fetched, even though it is in the proxy
allowlist.

1. `GET /proxy/api.exiledexchange2.dev/proxy/data/item-drop.json` returns `ITEM_DROP: DropEntry[]`.
2. `GET /proxy/api.exiledexchange2.dev/proxy/data/namespaceMap.json` returns
   `{schemaVersion:1, map:[{ns:"ITEM"|"GEM"|"UNIQUE", cx:boolean, url:"<ninja path>", type:"<overview type>"}]}`.
   As of 2026-10-30 there are 23 entries, for example:
   * `Currency→ITEM/currency`
   * `Ritual→ITEM/omens`
   * `Ultimatum→ITEM/soul-cores`
   * `LineageSupportGems→GEM/lineage-support-gems`
   * `UniqueArmours→UNIQUE/unique-armours (cx:false)`
   * `PrecursorTablets→ITEM/precursor-tablets (cx:false)`
3. `GET /proxy/api.exiledexchange2.dev/proxy/<league>/overviewData.json` (about 275 KB, brotli
   upstream). The body is compact JSON:

   ```
   {"core":{"rates":{"exalted":573,"chaos":9.31},"primary":"divine","secondary":"chaos"},
    "itemOverviews":[{"type":"Currency","lines":[{"name":"Orb of Alchemy","primaryValue":0.001777,"detailsId":"orb-of-alchemy","id":"alch","volumePrimaryValue":0.5,"maxVolumeCurrency":"divine","maxVolumeRate":562.7,"sparkline":{"totalChange":-28.91,"data":[...]}}, ...]},
                     {"type":"UniqueWeapons","lines":[{"name":"Redbeak","variant":"Shortsword","primaryValue":5829,"detailsId":"redbeak-shortsword","sparkline":{...}}, ...]}, ...]}
   ```

   * `primaryValue` is in **divines**.
   * `rates` gives exalted and chaos per divine.

### 10.2 Byte-exact requirement (do not reformat)

* `parseXchg` (`:471-477`) slices from `{"rates":` to the first `"}` after it, then calls
  `JSON.parse`. This requires the compact form `{"rates":{...},"primary":"divine","secondary":"chaos"}`.
* `splitJsonBlob` (`:479-522`) splits the text at each occurrence of `{"type":"`. Each slice is
  kept as a **string** (`lines`) together with the `ns/cx/url` from the namespace map.
* `findPriceByQuery({ns,name,variant})` (`:264-291`):
  1. Builds the needle `JSON.stringify({name, variant, primaryValue:0}).replace(":0}", ":")`, which
     is `{"name":"X","primaryValue":` or `{"name":"X","variant":"V","primaryValue":`.
  2. Calls `indexOf` on the slice, then reads up to the next `}}` (the end of `sparkline`) and
     calls `JSON.parse` on that substring.
  3. This depends on the **key order** `name`, then `variant`, then `primaryValue`, and on the
     absence of whitespace.
  4. It returns `{...info, cx, url: "https://poe.ninja/poe2/economy/<ninjaLeague>/<url>/<detailsId>"}`.
* **The proxy must stream or copy the bytes unchanged.** Do not use `res.json()` followed by
  `Response.json()`.

### 10.3 League mapping

`selectedLeagueToUrl(proxy)` (`:245-262`):

| league | `proxy=true` (EE2 mirror path) | `proxy=false` (poe.ninja link slug) |
|---|---|---|
| `Standard` | `standard` | `standard` |
| `Hardcore` | `hardcore` | `hardcore` |
| anything else | the raw league id (`%20`-encoded by the browser) | `lowercase(id)` with spaces removed |

For the poe.ninja slug, a leading `hc` is moved to the end: `"HC Runes of Aldur"` becomes
`hcrunesofaldur`, then `runesofaldurhc`.

### 10.4 Load gating and timers

| Constant | Value |
|---|---|
| `RETRY_INTERVAL_MS` | 4 min (a `setInterval` calls `load()` every 4 min, `:436-438`) |
| `UPDATE_INTERVAL_MS` | 31 min |
| `INTEREST_SPAN_MS` | 20 min |

`load(force)` (`:158-238`):
1. It returns early unless `leagues.selected` exists, `isPopular` is true, and
   `realm === "pc-ggg"`. **Private leagues** (`/\(PL\d+\)$/`) and any id containing `"Ruthless"`
   never get prices.
2. When not forced, it skips if less than 31 min passed since the last update, or if there was no
   interest in the last 20 min.
3. It aborts the previous download through `AbortController`. The proxy should propagate the abort
   upstream.
4. Sequence: item-drop, then compute `availableCoreCurrencies` (exalted and chaos with localized
   names), then the namespace map, then the overview data, then `parseXchg` and `splitJsonBlob`.
5. Core currency rate:
   * If any rate is `>= 10`, the preferred core currency (config `price-check.coreCurrency`,
     `"exalted"|"chaos"`, default `"exalted"`) is used **if its rate is `>= 5`**.
   * Otherwise exalted is used.
   * This sets `xchgRate` (core per divine) and `xchgRateCurrency`.
6. It clears `priceCache` and sets `lastUpdateTime`. Errors are only logged with `console.warn`.

Triggers for loading:
* `queuePricesFetch()` marks interest and calls `load()` on **every successfully parsed price-check
  item** (`PriceCheckWindow.vue:302`).
* `watch(leagues.selectedId)` resets state and calls `load(true)`.
* `watch(selectedCoreCurrencyId)` does the same.
* `usePoeninja()` is first instantiated in `R/web/overlay/OverlayWindow.vue:90`.

### 10.5 Conversion helpers (used by trade rows, trends, related items, and stack value)

* `autoCurrency(div | [min,max], coreOnly)` (`:298-342`) converts divines to the core currency.
  * Single value: if the core value is above `0.94 × rate`, it is shown in div. Between
    `0.94×` and `1.06×` it is snapped to exactly `1 div`.
  * Range: div is used if `core[0] > rate`.
  * `xchgRate || 9999` is the fallback when no rate is loaded.
* `cachedCurrencyByQuery(query, count)` is memoized by `ns:name:variant:count`. It is used for
  `normalizedPrice` of trade listings (`pathofexile-trade.ts:1358-1372`).
  * The currency trade tag is mapped to a ref name via `getCurrencyDetailsId` (`trends/getDetailsId.ts:6-17`)
    using `TRADE_TAG_TO_REF` from `items.ndjson` `tradeTag`.
* `CONVERT_CURRENCY` (`pathofexile-trade.ts:107-118`) relabels greater/perfect currencies
  (`greater-chaos-orb` becomes `G. chaos`) and sets `priceCurrencyRank` 2 or 3.
* `getDetailsId(item)` (`trends/getDetailsId.ts:38-85`) builds the ninja lookup key:

  | item | lookup key |
  |---|---|
  | gems | `{ns, refName}` |
  | maps | `name` with blighted prefix, `variant: "T<tier>[, Gen-18]"` |
  | uniques | `variant` = unique base, `"Relic"` for sanctum relics, `null` for flasks |
  | tablets | `variant` = rarity |
  | valuable bases (normal/magic/rare accessory, armour, weapon, quiver) | `forBasetype` (influence variant; returns `undefined` if more than one influence) |
  | `Filled Coffin` | the stat text with value, `variant` = ilvl bracket from `[1,70,80,84]` |
  | default | `{ns, refName}` |

* The PriceTrend UI (`trends/PriceTrend.vue`) shows the price, the 7-point sparkline (forecast
  up/down/const), and the volume (config `price-check.currencyVolume`: `"none"|"value"|"item"|"both"`,
  default `"both"`). Clicking opens the poe.ninja URL with `window.open` (`:244-246`).

### 10.6 Other price sources

* **poeprices.info** (`price-prediction/poeprices.ts`):
  * `GET www.poeprices.info/api?i=<base64(utf8 item text with "(…)" after digits and "{…}" lines stripped)>&l=<league>&s=awakened-poe-trade`.
  * Response: `{currency:"chaos"|"divine"|"exalt", error, error_msg, warning_msg, min, max, pred_confidence_score, pred_explanation:[[name,contrib]]}`.
  * Feedback: `POST www.poeprices.info/send_feedback` with multipart fields `selector`,
    `feedbacktxt`, `qitem_txt`, `source=awakened-poe-trade`, `min`, `max`, `currency`, `league`.
  * The external link is the same as the API URL plus `&w=1`.
  * **Disabled**: `<price-prediction>` is commented out in `CheckedItem.vue:4`. Config
    `price-check.requestPricePrediction` is still in settings (`settings-price-check.vue:139-143`)
    but has no effect.
  * Recommendation: drop it from the port, and drop the setting checkbox. poeprices is a PoE1
    service (see the `FIXME` at `poeprices.ts:69`).
* **poe2scout**: not used anywhere in EE2. If it is added later, it is a new feature, not a port
  item.

---

## 11. Leagues (`R/web/background/Leagues.ts`)

1. `load()` (`:46-79`): `GET /proxy/<H>/api/trade2/data/leagues`. The TODO says to switch to
   `/api/leagues?realm=poe2` later.
2. On `!response.ok`, it throws the headers JSON (§6.2).
3. Each entry is mapped to `{id, isPopular: true, text}`.
4. If the stored `AppConfig().leagueId` is not in the list and is not private, it auto-selects
   **index 2** when the list has more than 2 entries (`TMP_CHALLENGE`), otherwise index 0.
   * Live list on 2026-10-30, in order: `Forbidden Rites`, `HC Forbidden Rites`, `Runes of Aldur`,
     `HC Runes of Aldur`, `Standard`, `Hardcore`.
   * The auto-pick would therefore be `Runes of Aldur`.
5. `isPrivateLeague(id)` (`:91-96`): true if the id contains `"Ruthless"` or matches `/\(PL\d+\)$/`.
6. `selected` (`:35-44`) = `{id: leagueId, realm, isPopular: !private && listed?.isPopular}`.
7. `selectedId` returns `undefined` until the league list is loaded.
8. Loading starts at startup from `R/web/overlay/OverlayWindow.vue:91` (`useLeagues().load()`),
   and from the Retry and Refresh buttons (`BackgroundInfo.vue:14`, `settings-price-check.vue:8,42`).
9. Private leagues are typed into the `customLeagueId` input (`settings-price-check.vue:28-33, 269-279`).
   Searching a private league requires a **logged-in session cookie**.
10. Per-search override: `OnlineFilter.vue:84-91` lets the user pick a different trade league for
    the current search (`filters.trade.league`).

---

## 12. Trade data: stats and items (`R/web/background/TradeData.ts`)

* `GET www.pathofexile.com/api/trade2/data/stats` (about 854 KB) and
  `GET www.pathofexile.com/api/trade2/data/items` (about 187 KB), in parallel, each with an
  `AbortController` signal.
* Startup: `assets/data/index.ts:517-519` calls `trade.load(true)` during `init()` (`:323`).
  It builds `TRADE_ITEM_BY_REF`, `TRADE_STAT_BY_STAT_ID`, and `TRADE_STAT_BY_MATCH_STR`
  fallbacks for items and stats that are not in the bundled data.
* Refresh: `setInterval(load, 30 min)`. A non-forced load proceeds only if at least 2 h passed since
  the last update **and** interest was expressed (via the fallback lookups) within the last 60 min.
  The code comment says "20 min", but the value is 60 min.
* "Don't regress": the new data is kept only if **both** the item count and the stat count grew
  (`foundItems > 0 && foundStats > 0`).
* There is a manual reload button in `price-check/fallback/ReloadTradeData.vue`.
* A failure sets `error` and logs a warning. The app keeps working on bundled data.
* Requirement for the proxy: support aborting the upstream request when the client aborts, and
  handle bodies of about 1 MB.

---

## 13. Trade-site and external links: how they are built and opened

### 13.1 Link builders

The URLs are built by string concatenation, and **the `q` JSON is not URL-encoded**. The browser
URL parser encodes it when opening.

| Where | URL |
|---|---|
| `CheckedItem.vue:355-357` (before searching) | `https://<H>/trade2/search/poe2/<league>?q=<JSON.stringify(createTradeRequest(...))>` (full body incl. `sort`) |
| `TradeListing.vue:204-208` | after search: `https://<H>/trade2/search/poe2/<league>/<searchResult.id>`; before: same `?q=` form |
| `TradeBulk.vue:251-262` | `https://<H>/trade2/exchange/poe2/<league>?q=<JSON.stringify({exchange: body.query})>`; `have` defaults to the selected tab (`["divine"]`/`["exalted"]`/`["chaos"]`); the error box uses `["mirror"]` |
| `Prices.ts:287` | `https://poe.ninja/poe2/economy/<ninjaSlug>/<map.url>/<detailsId>` |
| `poeprices.ts:92-100` | `https://www.poeprices.info/api?...&w=1` (dead UI) |
| `BackgroundInfo.vue:58-60` ("captcha") | `https://<H>/api/trade2/data/leagues` |
| item-check actions (other note) | `https://www.poe2wiki.net/wiki/<ref>`, `https://poe2db.tw/<lang>/<path>`, `https://craftofexile.com/?game=poe2&eimport=<enc>` |

### 13.2 How links are opened in EE2

* `TradeLinks.vue:46-62`:
  * If `Host.isElectron && price-check.builtinBrowser` (default **false**), there are two buttons.
    "Trade" calls `showBrowser(link)`, which opens the in-overlay `<webview>`. The "↗" button calls
    `window.open(link)`.
  * Otherwise there is a single "Trade ↗" button that calls `window.open(link)`.
* `TradeBulk.vue:277-283` "Browser" (error box): `showBrowser` if `builtinBrowser && isElectron`,
  otherwise `window.open`.
* `TradeListing.vue:267-269` "Browser" (error box): **always `showBrowser(makeTradeLink())`**.
* `BackgroundInfo.vue:58-60` "Browser" (leagues failed): **always `showBrowser(...)`**.
* `PriceTrend.vue:244-246`: `window.open(ninjaUrl)`.
* `showBrowser` (`PriceCheckWindow.vue:413-426`) sets widget flag `has-browser` and assigns
  `iframeEl.src = url` on a `<webview>` element (`:103-109`). This is an Electron-only tag; Vite
  marks it as a custom element in `vite.config.mts`.
* Electron main: `webContents.setWindowOpenHandler(d => { shell.openExternal(d.url); return {action:"deny"} })`
  (`main/src/windowing/OverlayWindow.ts:71-74`). As a result, `window.open` and
  `<a target="_blank">` open in the **system default browser**.

### 13.3 Port consequences

* Under QtWebEngine, `Host.isElectron` is false, so TradeLinks always uses `window.open`. The Qt
  host must implement the equivalent of `setWindowOpenHandler`: Qt6
  `QWebEnginePage::newWindowRequested(QWebEngineNewWindowRequest&)` calls
  `QDesktopServices::openUrl(request.requestedUrl())`, which runs xdg-open. The same path also
  catches `<a target="_blank">` links (support links in `CheckedItem.vue:46-55`, settings, and the
  about page).
* The two **unconditional `showBrowser` callers** (`TradeListing.vue:268` and `BackgroundInfo.vue:59`)
  would set `has-browser` and render an inert `<webview>`. The panel would show nothing useful.
  A renderer patch is needed (§17).
* Hyprland UX note, outside this area: opening a browser while PoE2 is fullscreen may land behind
  the game, depending on `misc:new_window_takes_over_fullscreen`. Whoever owns the Hyprland
  integration should decide whether to focus or move the browser.

---

## 14. POESESSID, cookies, Cloudflare

* EE2 has **no explicit POESESSID setting**. Login happens by signing in inside the built-in
  `<webview>` (docs: `docs/private-leagues.md`, `docs/complex-query.md`). The resulting
  `POESESSID` lands in Electron's persistent default-session cookie jar and is attached to every
  proxied request by `useSessionCookies: true`.
* What a logged-in POESESSID gives:
  * account-based rate-limit rules (`x-rate-limit-rules` includes `Account`), which the limiter
    ingests automatically
  * private league search
  * a higher query-complexity limit (`"Query is too complex."` errors)
  * trade results relative to the account
* Even anonymous requests receive a `set-cookie: POESESSID=<random>; path=/; domain=.pathofexile.com; secure; HttpOnly; SameSite=Lax`
  on every response that is not cached (observed live). Electron stored and reused it. Without a
  jar, every request starts a new anonymous session. This is harmless but noisy.
* **Cloudflare**: `docs/failed-load-leagues.md` describes the "Browser" button. It opens
  `https://<H>/api/trade2/data/leagues` in the `<webview>`, the user solves the challenge, and the
  `cf_clearance` cookie in the shared jar then unblocks the proxy.
  * This only works because the proxy sends the **same UA** as the webview (`app.userAgentFallback`).
  * The `Partitioned` stripping exists for these Cloudflare cookies.
  * As of 2026-10-30, no challenge was observed for curl or Bun with a custom UA (`OmaExiled/0.1`)
    on search, leagues, or the EE2 mirror. Challenges historically appear around league launches.
* `accountName` (config, top-level, default `""`) is used only to flag your own listings
  (`isMine`). It has nothing to do with authentication.

---

## 15. Live probe evidence (2026-10-30)

```
GET https://www.pathofexile.com/api/trade2/data/leagues  -> 200, content-type: application/json,
    cache-control: public, max-age=14400, cf-cache-status: HIT, NO rate-limit headers, NO set-cookie
    {"result":[{"id":"Forbidden Rites","realm":"poe2","text":"Forbidden Rites"}, ... ,{"id":"Hardcore","realm":"poe2","text":"Hardcore"}]}

POST https://www.pathofexile.com/api/trade2/search/Standard -> 200
    set-cookie: POESESSID=...; path=/; domain=.pathofexile.com; secure; HttpOnly; SameSite=Lax
    access-control-expose-headers: X-Rate-Limit-Policy, X-Rate-Limit-Rules, X-Rate-Limit-Ip, X-Rate-Limit-Ip-State
    x-rate-limit-policy: trade-search-request-limit
    x-rate-limit-rules: Ip
    x-rate-limit-ip: 5:10:60,15:60:300,30:300:1800,600:21600:3600
    x-rate-limit-ip-state: 1:10:0,1:60:0,1:300:0,1:21600:0
    {"id":"H4sIAAAA...","complexity":6,"result":["f5c99483...", ...],"total":381}

GET https://www.pathofexile.com/api/trade2/fetch/<id>,<id>?query=<searchId> -> 200
    x-rate-limit-policy: trade-fetch-request-limit
    x-rate-limit-ip: 12:4:10,16:12:300,50:300:300,1000:21600:1800
    listing: {"method":"psapi","indexed":"2025-03-14T16:19:19Z","stash":{...},"price":{"type":"~price","amount":1,"currency":"exalted"},
              "account":{"name":"…#8965","online":{"league":"Standard"},"lastCharacterName":"…","language":"en_US","realm":"poe2"},"whisper":"@… Hi, …"}

POST https://www.pathofexile.com/api/trade2/search/Standard (bogus category) -> 400
    x-rate-limit-* present (state incremented)
    {"error":{"code":2,"message":"Unknown category"}}

POST https://www.pathofexile.com/api/trade2/exchange/Standard -> 200
    x-rate-limit-policy: trade-exchange-request-limit
    x-rate-limit-ip: 5:15:60,10:90:300,30:300:1800
    {"id":"H4sI…","complexity":…,"result":{"7a79d5a4…":{"id":"…","item":null,"listing":{"indexed":"…","account":{…,"online":{"league":"Standard","status":"afk"}},"offers":[{"exchange":{"currency":"divine","amount":1,"whisper":"{0} Divine Orb"},"item":{"currency":"alch","amount":8,"stock":2834,"id":"…","whisper":"{0} Orb of Alchemy"}}],"whisper":"…"}}},"total":2}

GET https://api.exiledexchange2.dev/proxy/data/namespaceMap.json -> 200 (content-encoding: br when requested), cache-control: max-age=14400, etag
GET https://api.exiledexchange2.dev/proxy/Runes%20of%20Aldur/overviewData.json -> 200, 275067 bytes, compact JSON (see §10.1)
GET /api/trade2/data/stats -> 200, 854470 bytes;  /api/trade2/data/items -> 200, 186664 bytes

Bun 1.4.3 fetch facts (verified):
  * auto-decompresses but KEEPS `content-encoding: br` in response.headers  -> proxy MUST strip it (and content-length)
  * `decompress: false` returns raw br bytes (alternative strategy)
  * fetch("…/search/Runes of Aldur") auto-encodes to %20; response.url shows the encoded form
  * response.headers.getSetCookie() returns the Set-Cookie list
  * custom UA "OmaExiled/0.1" was accepted for search (200)
```

---

## 16. SPEC — Bun backend `/proxy/` (normative; the renderer must work unchanged)

### 16.1 Route and target URL

* Handle any method on paths starting with `/proxy/`. Only `GET` and `POST` occur in practice.
  The route must live on the same `Bun.serve` instance and origin as the static renderer, `/config`,
  and `/events`.
* `const u = new URL(req.url); const rest = u.pathname.slice("/proxy/".length); const host = rest.split("/", 1)[0];`
* `target = "https://" + rest + u.search`.
  * **Do not decode or re-encode** the path. `%20` and friends must survive unchanged.
  * WHATWG `URL.pathname` keeps percent-escapes as received.
* The allowlist is identical to §2. Recommended: keep the `official` flag and use it to decide
  cookie attachment. A host that is not listed gets **403** with an empty body. EE2 reset the
  socket instead, but no renderer code depends on that.

### 16.2 Local-access guard (new; recommended because the jar can hold a real POESESSID)

The proxy is an open relay bound to 127.0.0.1 that attaches the user's cookies. Reject with 403
when any of these holds:
* `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defense). In dev, also
  allow the Vite dev host, because Vite's proxy keeps the original Host.
* `Origin` is present and is not the app origin.
* `Sec-Fetch-Site` is present and is not `same-origin` or `none`.

QtWebEngine sends `Sec-Fetch-Site: same-origin` for the renderer's own fetches.

### 16.3 Outgoing request headers

* Start from the incoming headers, then delete:
  * `host`, `origin`, `referer`, `cookie`, `content-length`
  * `connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`
  * `proxy-connection`, `proxy-authorization`
  * every `sec-*` header
  * `accept-encoding` (let Bun negotiate and decompress)
* Keep `accept`, `content-type` (including the multipart boundary), and `accept-language`.
* **Set `user-agent`** to the configured backend UA (§16.6). It must never come from the renderer.
* For official hosts, set `cookie` from the backend cookie jar (§16.6) using domain and path
  matching. Never forward the renderer's own `cookie` header.

### 16.4 Body and upstream call

* For methods other than GET/HEAD, forward `await req.arrayBuffer()`. Bodies are small: the largest
  are search JSON and multipart feedback. Streaming with `duplex:"half"` is also fine.
* `fetch(target, { method, headers, body, redirect: "follow", signal: AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]) })`.
* Client aborts must cancel the upstream request. `TradeData` and `Prices` abort superseded
  downloads.

### 16.5 Response to the renderer

* **Status**: pass `up.status` through unchanged, including 400, 403, 404, 429, and 5xx. Pass
  `statusText` through as well; the renderer never reads it. **Never** convert an upstream error
  into a different status or body.
* **Headers**: copy all upstream headers **except**:
  * `content-encoding`, `content-length`, `transfer-encoding`, `connection`, `keep-alive`. Bun has
    already decompressed the body but keeps these headers (verified). An alternative is
    `decompress:false` while keeping `content-encoding`, but then `content-length` must still be
    correct.
  * `set-cookie`. Store it in the jar first, after removing any `Partitioned` attribute (parity
    with `proxy.ts:77-90`). Do not forward it to the renderer.
  * `access-control-allow-origin` and `access-control-allow-credentials`. Strip them so a hostile
    web page can never read proxied responses.
  * Optional strips: `alt-svc`, `strict-transport-security`, `nel`, `report-to`.
* **Must be preserved verbatim**:
  * `content-type`
  * `x-rate-limit-policy`, `x-rate-limit-rules`, and every `x-rate-limit-<rule>` /
    `x-rate-limit-<rule>-state` header (for example `-ip`, `-ip-state`, `-account`,
    `-account-state`)
  * `retry-after`
  * Recommended for parity (§8.2): `cache-control`, `expires`, `etag`, `last-modified`, `date`
* **Body**: stream `up.body` unchanged and byte-exact. Never parse or re-serialize JSON (§10.2).
* **Do not add CORS headers.** The request is same-origin and no preflight occurs.

### 16.6 Identity: User-Agent and cookies

* **UA**: use a Chromium-style string with an app token. Recommended:
  * Have the Qt host report `QWebEngineProfile::httpUserAgent()` over stdio at startup.
  * The backend uses exactly that string plus ` OmaExiled/<version>`.
  * Benefit: if a Cloudflare clearance is ever obtained in a Qt window, the UA matches. The TLS
    fingerprint still differs, which is a risk (§20).
  * Fallback constant: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OmaExiled/<ver> Chrome/<ver> Safari/537.36`.
* **Cookie jar**:
  * Keep an RFC 6265-style jar in the backend: domain matching (`.pathofexile.com` covers
    `www.`, `ru.`, `jp.`, and the other language subdomains), path, `Secure`, and expiry. Use
    `tough-cookie` or `Bun.Cookie` parsing.
  * Persist it to the config directory (for example `~/.config/omaexiled/cookies.json`, mode
    `0600`), mirroring Electron's persistent session.
  * Ignore `Partitioned`.
  * Attach cookies to official hosts only. EE2 attached session cookies for all hosts, but
    official-only is safer.
* **Logged-in session** (replaces built-in browser login). Pick one or both:
  1. A backend-only setting **`poesessid`**, stored in a backend secrets file and **not** in the
     renderer config JSON served at `/config`. It is injected as `POESESSID=<v>` for
     `.pathofexile.com` and overrides the anonymous jar value. It needs a small settings UI
     field, or a CLI/bar-plugin command.
  2. A Qt "Sign in to trade site" window: a normal Qt window with a persistent
     `QWebEngineProfile` that loads `https://www.pathofexile.com/trade2`.
     `QWebEngineCookieStore::cookieAdded` sends cookies for `.pathofexile.com` (`POESESSID`,
     `cf_clearance`, `__cf_bm`) to the backend over stdio, for example
     `{"type":"cookies","cookies":[{name,value,domain,path,expires,secure,httpOnly}]}`. This also
     covers the "solve captcha" flow.
* Never log cookie values, and never send them to the renderer or to non-official hosts.

### 16.7 Upstream network failure (DNS, TLS, timeout, reset)

* EE2: the socket is destroyed and `fetch` rejects with `TypeError: Failed to fetch`.
* Port, recommended: log `error [proxy] <message> (<host>)` and return **502**,
  `content-type: application/json`, body `{"error":{"code":-1,"message":"OmaExiled proxy: <message>"}}`.
  Effect on each consumer:
  * search, fetch, and exchange show the message (better than "Failed to fetch")
  * leagues shows the headers JSON (`!ok`)
  * `TradeData` fails JSON shape access, which is caught and sets `error`
  * `Prices` fails parsing, which is caught with `console.warn`
  * Nothing breaks.

### 16.8 Optional server-side rate-limit safety net (recommended)

Reasons for a backend-side guard:
* The renderer ignores `Retry-After` and the penalty fields.
* Separate WebEngine pages, such as the overlay panel and the settings window, would each have
  their own limiter state.

Guard spec:
* Map the endpoint to a policy: `/api/trade2/search/` → search, `/api/trade2/fetch/` → fetch,
  `/api/trade2/exchange/` → exchange.
* Remember the last `x-rate-limit-*` headers per policy.
* On a **429**, record `blockedUntil = now + retry-after*1000`. If `Retry-After` is missing, use
  the maximum third field of the `-state` headers.
* While blocked, answer immediately without contacting GGG: status **429**, `retry-after:
  <remaining>`, the last-seen `x-rate-limit-*` headers, and body
  `{"error":{"code":3,"message":"Rate limit exceeded (wait Ns)"}}`.
* Do not delay or queue requests otherwise. The renderer's limiter remains the primary mechanism.
* Ensure only **one** WebEngine page issues trade requests. Price check runs only in the overlay
  panel page.

### 16.9 Logging

Mirror EE2: write `error [proxy] <msg> (<host>)` to the backend log. That log is forwarded to the
renderer as `MAIN->CLIENT::log-entry` by the logging area. Optionally log `429` and `403` with
`cf-mitigated` at warning level.

### 16.10 Reference implementation sketch (Bun)

```ts
const PROXY_HOSTS = new Map<string, boolean>([
  ["www.pathofexile.com", true], ["ru.pathofexile.com", true], ["pathofexile.tw", true],
  ["poe.kakaogames.com", true], ["jp.pathofexile.com", true], ["de.pathofexile.com", true],
  ["es.pathofexile.com", true], ["br.pathofexile.com", true], ["fr.pathofexile.com", true],
  ["poe.ninja", false], ["www.poeprices.info", false], ["api.exiledexchange2.dev", false],
]);
const DROP_REQ = new Set(["host","origin","referer","cookie","content-length","connection","keep-alive",
  "transfer-encoding","te","trailer","upgrade","proxy-connection","proxy-authorization","accept-encoding"]);
const DROP_RES = new Set(["content-encoding","content-length","transfer-encoding","connection","keep-alive",
  "set-cookie","access-control-allow-origin","access-control-allow-credentials","alt-svc"]);

export async function handleProxy(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const rest = u.pathname.slice("/proxy/".length);
  const host = rest.split("/", 1)[0];
  const official = PROXY_HOSTS.get(host);
  if (official === undefined || !isLocalSameOrigin(req)) return new Response(null, { status: 403 });
  const target = "https://" + rest + u.search;

  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!k.startsWith("sec-") && !DROP_REQ.has(k)) headers.set(k, v); });
  headers.set("user-agent", USER_AGENT);
  if (official) { const c = jar.cookieHeader(target); if (c) headers.set("cookie", c); }

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  let up: Response;
  try {
    up = await fetch(target, { method: req.method, headers, body, redirect: "follow",
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]) });
  } catch (e) {
    log(`error [proxy] ${(e as Error).message} (${host})`);
    return Response.json({ error: { code: -1, message: `OmaExiled proxy: ${(e as Error).message}` } }, { status: 502 });
  }
  if (official) for (const sc of up.headers.getSetCookie()) jar.store(target, stripPartitioned(sc));
  rateGuard.observe(target, up);                       // §16.8 (optional)
  const out = new Headers();
  up.headers.forEach((v, k) => { if (!DROP_RES.has(k)) out.append(k, v); });
  return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });
}
```

### 16.11 Backend tests to write (bun test)

* Path encoding: `/proxy/www.pathofexile.com/api/trade2/search/Runes%20of%20Aldur` reaches the
  upstream URL with `%20` intact.
* Host allowlist returns 403. The local-access guard rejects a foreign `Origin` or
  `Sec-Fetch-Site: cross-site`.
* Request headers: `user-agent` is overridden, `sec-*`, `origin`, `referer`, and `cookie` are
  stripped, and the jar cookie is added only for official hosts.
* Response: a 400 or 429 status and its JSON body pass through. `x-rate-limit-*` and `retry-after`
  are present. `content-encoding`, `content-length`, and `set-cookie` are absent. The body bytes
  equal upstream for a brotli/gzip upstream.
* Multipart POST passthrough (boundary preserved).
* Client abort cancels the upstream request.
* Network error returns 502 JSON.

---

## 17. Minimal renderer changes this area needs (everything else unchanged)

1. **`showBrowser` without `<webview>`** (`PriceCheckWindow.vue:413-426`): when the built-in browser
   is unavailable (`!Host.isElectron`, or a port flag), call `window.open(url)` instead of setting
   `has-browser`. This fixes:
   * `TradeListing.vue:268` ("Browser" in the trade error box)
   * `BackgroundInfo.vue:59` ("Browser" in the leagues-failed box)

   Optionally route the captcha and login case to the Qt sign-in window (§16.6) through a new WS
   event, for example `CLIENT->MAIN::open-trade-login {url}`.
2. **Hide or repurpose `builtinBrowser`** (`settings-price-check.vue:171-178`). `TradeLinks.vue`
   already ignores it when `!isElectron`. If the port spoofs `Electron` in the UA (a decision for
   another area), `TradeLinks.vue:50-55` and `TradeBulk.vue:278` must also be patched, because they
   would try to use `<webview>`.
3. **Optional**: remove the PricePrediction/poeprices UI and the `requestPricePrediction` setting
   (already inert).
4. **Optional**: add a "POESESSID" or "Sign in" control in price-check settings if §16.6 option 1
   or 2 is chosen.

Do **not** change `Host.proxy`, the trade modules, `RateLimiter`, `Cache`, `Prices.ts` parsing, or
`Leagues.ts`. With §16 implemented, they work as-is.

### Qt host requirements in this area

* Load the renderer from `http://127.0.0.1:<port>/index.html` (same origin as `/proxy`).
* `newWindowRequested` → `QDesktopServices::openUrl` (which uses xdg-open). This replaces Electron's
  `setWindowOpenHandler` → `shell.openExternal`.
* Optional: report the UA at startup, and provide the sign-in window with cookie export (§16.6).
* The overlay panel must be mouse-interactive so the link and Retry buttons work. This is already
  decided in the architecture.

---

## 18. Existing tests relevant here (renderer, vitest; keep them passing)

* `renderer/specs/web/useTradeApi.test.ts`: pagination call counts (§9.1). It mocks the trade module.
* `renderer/specs/web/prices.test.ts`: `parseXchg` and `splitJsonBlob` on compact JSON strings. It
  documents the byte-format dependency.
* `renderer/specs/web/price-check/trade/pathofexile-trade.test.ts`: `parseFetchResult` tier parsing
  using fixtures `renderer/specs/docs/fetchResponses.json` (and `fetchResponses2.json`), which are
  real fetch-API responses.

---

## 19. Config keys touched by this area (exact names, defaults)

Top level (`Config.ts:127-233`):

| key | default |
|---|---|
| `leagueId` | `undefined` |
| `accountName` | `""` |
| `language` | `"en"` |
| `preferredTradeSite` | `"default"` |
| `realm` | `"pc-ggg"` |

Widget `price-check` (`R/web/overlay/widgets.ts:38-64`, defaults in `PriceCheckWindow.vue:180-210`):

| key | default | effect |
|---|---|---|
| `apiLatencySeconds` | 2 | rate-limit window fudge |
| `showRateLimitState` | false | rate-limit panel visibility |
| `collapseListings` | `"api"` | `"api"` adds `trade_filters.collapse` |
| `builtinBrowser` | false | |
| `coreCurrency` | `"exalted"` | |
| `currencyVolume` | `"both"` | |
| `requestPricePrediction` | false | inert |
| `showSeller` | false | |
| `rememberCurrency` | false | |
| `rememberListingType` | false | |
| `smartInitialSearch` | true | |
| `lockedInitialSearch` | true | |
| `activateStockFilter` | false | |
| `searchStatRange` | 10 | |
| `defaultAllSelected` | false | |

Proposed new backend-only setting (not in renderer config): `poesessid` (§16.6).

---

## 20. Risks and open questions

* **Cloudflare bot checks at league launch.** Bun's TLS and HTTP fingerprint differs from Chromium.
  A `cf_clearance` obtained in QtWebEngine may not validate for Bun even with the same UA.
  * Fallback idea: run official trade requests through a hidden QtWebEngine page on the
    pathofexile.com origin (in-page `fetch`) and relay the results to the backend. This is heavier
    but uses Chromium's network stack.
  * The decision can wait until blocking is actually observed. Today, Bun with a custom UA works.
* **Dependency on `api.exiledexchange2.dev`**, a third-party server run by the EE2 maintainer, for
  all price and trend data. If it changes format (the `schemaVersion` gate is `1`) or blocks
  non-EE2 UAs, trends disappear silently. The open question is whether OmaExiled should
  self-source from poe.ninja's PoE2 API. That would require reproducing the exact compact
  `overviewData.json` format or rewriting `Prices.ts` parsing.
* **Multiple renderer contexts mean multiple limiter states.** Keep trade calls in one page, and
  use §16.8.
* **The renderer ignores `Retry-After`** and the penalty seconds, so repeated 429s are possible
  after a burst. §16.8 mitigates this.
* **POESESSID storage and threat model.** The proxy relays requests to an authenticated account
  from 127.0.0.1, so §16.2 is required. Keep the secret out of `/config`.
* **QtWebEngine HTTP cache** on `/proxy` GETs with `max-age=14400` gives parity with EE2, but can
  mask fresh league lists for up to 4 h. Decide whether to strip `cache-control` on `/proxy`
  responses.
* **xbox/sony realms** are not supported by EE2. The PoE2 console trade URL shapes are unknown, so
  this is out of scope unless requested.
* **Korean (`poe.kakaogames.com`) and Taiwanese (`pathofexile.tw`) hosts** are untested for PoE2
  `/api/trade2/*`. Parity means keeping them in the allowlist.

---

## 21. System packages for this area (checked on this machine, 2026-10-30)

Everything this area needs is **already installed**:
* `bun` 1.4.3 (fetch, brotli, zstd, AbortSignal.any)
* `ca-certificates`
* `xdg-utils` (`xdg-open`, used by `QDesktopServices::openUrl`)
* `qt6-webengine` 6.11.2
* `layer-shell-qt` 6.8.1
* `wl-clipboard`
* `hyprctl`

Optional: the npm package `tough-cookie` (installed with `bun add`) if a full RFC 6265 cookie jar
is preferred over a hand-written one. No system package is needed for it.
