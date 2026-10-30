import { reactive as deepReactive, shallowRef, toRaw } from "vue";
import isDeepEqual from "fast-deep-equal";
import { Host } from "@/web/background/IPC";
import { HostConfig, ShortcutAction } from "@ipc/types";
import type * as widget from "./overlay/widgets";
import type { StashSearchWidget } from "./stash-search/widget";
import type { ItemCheckWidget } from "./item-check/widget";
import { registry as widgetRegistry } from "./overlay/widget-registry.js";

const _config = shallowRef<Config | null>(null);
let _lastSavedConfig: Config | null = null;

export function AppConfig(): Config;
export function AppConfig<T extends widget.Widget>(type: string): T | undefined;
export function AppConfig(type?: string) {
  if (!type) {
    return _config.value!;
  } else {
    return _config.value!.widgets.find((w) => w.wmType === type);
  }
}

export function updateConfig(updates: Config) {
  _config.value = deepReactive(JSON.parse(JSON.stringify(updates)));
  document.documentElement.style.fontSize = `${_config.value!.fontSize}px`;
}

// OmaExiled: `force` saves even while an exclusive widget is shown (settings
// Save, which must not wait for a later save trigger).
export function saveConfig(opts?: { isTemporary?: boolean; force?: boolean }) {
  const rawConfig = toRaw(_config.value!);
  if (
    !opts?.force &&
    rawConfig.widgets.some(
      (w) => w.wmZorder === "exclusive" && w.wmWants === "show",
    )
  ) {
    return;
  }

  if (!isDeepEqual(rawConfig, _lastSavedConfig)) {
    _lastSavedConfig = JSON.parse(JSON.stringify(rawConfig));
    Host.sendEvent({
      name: "CLIENT->MAIN::save-config",
      payload: {
        contents: JSON.stringify(AppConfig()),
        isTemporary: opts?.isTemporary ?? false,
      },
    });
  }
}

export function pushHostConfig() {
  Host.sendEvent({
    name: "CLIENT->MAIN::update-host-config",
    payload: getConfigForHost(),
  });
}

export async function initConfig() {
  Host.onEvent("MAIN->CLIENT::config-changed", (e) => {
    _lastSavedConfig = JSON.parse(e.contents); // should be a deep copy
    updateConfig(JSON.parse(e.contents));
  });

  const contents = await Host.getConfig();
  if (!contents) {
    updateConfig(defaultConfig());
    return;
  }

  let config: Config;
  try {
    config = JSON.parse(contents);
  } catch {
    updateConfig(defaultConfig());
    saveConfig({ isTemporary: true });
    return;

    // TODO
    // dialog.showErrorBox(
    //   'Exiled Exchange 2 - Incompatible configuration',
    //   // ----------------------
    //   'You are trying to use an older version of Exiled Exchange 2 with a newer incompatible configuration file.\n' +
    //   'You need to install the latest version to continue using it.'
    // )
  }

  updateConfig(upgradeConfig(config));
}

export function poeWebApi() {
  const { realm, preferredTradeSite, language } = AppConfig();
  if (preferredTradeSite === "www") {
    return "www.pathofexile.com";
  }
  switch (language) {
    case "en":
      return "www.pathofexile.com";
    case "ru":
      return "ru.pathofexile.com";
    case "cmn-Hant":
      return realm === "pc-garena" ? "pathofexile.tw" : "www.pathofexile.com";
    case "ko":
      return "poe.kakaogames.com";
    case "ja":
      return "jp.pathofexile.com";
    case "de":
      return "de.pathofexile.com";
    case "es":
      return "es.pathofexile.com";
    case "pt":
      return "br.pathofexile.com";
    case "fr":
      return "fr.pathofexile.com";
  }
}

export enum TipsFrequency {
  Always = 1,
  MoreOften = 2,
  Normal = 3,
  Rarely = 4,
  VeryRarely = 5,
  Never = 6,
}

export interface Config {
  configVersion: number;
  leagueId?: string;
  overlayKey: string;
  overlayBackground: string;
  overlayBackgroundClose: boolean;
  hideOverlayOnBlur: boolean;
  restoreClipboard: boolean;
  commands: Array<{
    text: string;
    hotkey: string | null;
    send: boolean;
  }>;
  clientLog: string | null;
  gameConfig: string | null;
  windowTitle: string;
  logKeys: boolean;
  accountName: string;
  stashScroll: boolean;
  language: "en" | "ru" | "cmn-Hant" | "ko" | "ja" | "de" | "es" | "pt" | "fr";
  preferredTradeSite: "default" | "www";
  realm: "pc-ggg" | "pc-garena";
  widgets: widget.Widget[];
  fontSize: number;
  showAttachNotification: boolean;
  overlayAlwaysClose: boolean;
  enableAlphas: boolean;
  alphas: Array<"library">;
  tipsFrequency: TipsFrequency;
  readClientLog: boolean; // default to false, opt-in only
  // OmaExiled: more price check triggers, see HostConfig
  gameCopyBind: boolean;
  clipboardWatch: boolean;
}

export const defaultConfig = (): Config => ({
  configVersion: 38,
  overlayKey: "Shift + Space",
  overlayBackground: "rgba(129, 139, 149, 0.15)",
  overlayBackgroundClose: true,
  overlayAlwaysClose: false,
  hideOverlayOnBlur: false,
  restoreClipboard: false,
  showAttachNotification: true,
  commands: [
    {
      text: "/hideout",
      hotkey: "F5",
      send: true,
    },
    {
      text: "/exit",
      hotkey: "F9",
      send: true,
    },
    {
      text: "@last ty",
      hotkey: null,
      send: true,
    },
    {
      text: "/invite @last",
      hotkey: null,
      send: true,
    },
    {
      text: "/tradewith @last",
      hotkey: null,
      send: true,
    },
    {
      text: "/hideout @last",
      hotkey: null,
      send: true,
    },
  ],
  clientLog: null,
  gameConfig: null,
  windowTitle: "Path of Exile 2",
  logKeys: false,
  accountName: "",
  stashScroll: true,
  language: "en",
  preferredTradeSite: "default",
  realm: "pc-ggg",
  fontSize: 16,
  widgets: widgetRegistry.widgets.reduce<widget.Widget[]>(
    (widgets, { widget }) => {
      const res: widget.Widget[] = [];
      if (widget.instances === "single") {
        res.push(widget.initInstance!());
      } else if (
        widget.instances === "multi" &&
        widget.defaultInstances != null
      ) {
        res.push(...widget.defaultInstances());
      }
      for (const config of res) {
        config.wmId = widgets.length + 1;
        widgets.push(config);
      }
      return widgets;
    },
    [],
  ),
  enableAlphas: false, // default to false, opt-in only
  alphas: [],
  tipsFrequency: TipsFrequency.Normal,
  readClientLog: false, // default to false, opt-in only
  gameCopyBind: false,
  clipboardWatch: false,
});

// Defaults of the EE2 widgets that are not ported, as EE2 defines them. Only
// the EE2 steps in upgradeConfig() use them; the widgets are removed from
// the config right after those steps.
/* eslint-disable @typescript-eslint/no-explicit-any */
function droppedWidgetDefaults(): Array<Record<string, any>> {
  return [
    {
      wmId: 0,
      wmType: "item-search",
      wmTitle: "{icon=fa-search}",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["invisible-on-blur"],
      anchor: { pos: "tl", x: 10, y: 20 },
      ocrGemsKey: null,
    },
    {
      wmId: 0,
      wmType: "experience-tracker",
      wmTitle: "XP",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: [],
      anchor: { pos: "bc", x: 68, y: 98 },
      showExp: true,
    },
    {
      wmId: 0,
      wmType: "image-strip",
      wmTitle: "Cheat sheets",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["invisible-on-blur"],
      anchor: { pos: "tc", x: 50, y: 10 },
      images: [{ id: 1, url: "syndicate.jpg" }],
    },
    {
      wmId: 0,
      wmType: "delve-grid",
      wmTitle: "",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["hide-on-focus", "menu::skip"],
      toggleKey: null,
    },
    {
      wmId: 0,
      wmType: "library",
      wmTitle: "{icon=fa-book}",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["invisible-on-blur", "menu::skip"],
      anchor: { pos: "tl", x: 20, y: 20 },
      logItemKey: null,
      libraryOutputPath: null,
      selectedProfile: "chaos",
      profiles: {
        chaos: {
          refName: true,
          itemLevel: true,
          rarity: true,
          sockets: true,
          mods: true,
          addedMods: true,
          removedMods: true,
          keep: {
            explicit: true,
            implicit: false,
            enchant: false,
            augment: false,
          },
          modOpts: {
            name: true,
            tier: true,
            roll: true,
            ref: true,
            type: true,
            generation: true,
          },
        },
      },
    },
  ];
}

function upgradeDefaultWidgets(): Array<Record<string, any>> {
  return [...defaultConfig().widgets, ...droppedWidgetDefaults()];
}
/* eslint-enable */

function upgradeConfig(_config: Config): Config {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const config = _config as Omit<Config, "widgets"> & {
    widgets: Array<Record<string, any>>;
  };

  if (config.configVersion < 3) {
    config.widgets.push({
      ...upgradeDefaultWidgets().find((w) => w.wmType === "image-strip")!,
      wmId: Math.max(0, ...config.widgets.map((_) => _.wmId)) + 1,
      wmZorder: null,
    });

    config.widgets.push({
      ...upgradeDefaultWidgets().find((w) => w.wmType === "delve-grid")!,
      wmId: Math.max(0, ...config.widgets.map((_) => _.wmId)) + 1,
      wmZorder: null,
    });

    config.widgets.find((w) => w.wmType === "menu")!.alwaysShow = false;

    config.configVersion = 3;
  }

  if (config.configVersion < 4) {
    config.widgets.find(
      (w) => w.wmType === "price-check",
    )!.chaosPriceThreshold = 0.05;

    const mapCheck = config.widgets.find((w) => w.wmType === "map-check");
    mapCheck?.selectedStats.forEach((e: any) => {
      e.matcher = e.matchRef;
      e.matchRef = undefined;
    });

    {
      const widgets = config.widgets.filter((w) => w.wmType === "image-strip")!;
      widgets.forEach((imgStrip: any) => {
        imgStrip.images.forEach((e: any, idx: number) => {
          e.id = idx;
        });
      });
    }

    config.configVersion = 4;
  }

  if (config.configVersion < 5) {
    config.commands.forEach((cmd) => {
      cmd.send = true;
    });

    config.configVersion = 5;
  }

  if (config.configVersion < 6) {
    config.widgets.find((w) => w.wmType === "price-check")!.showRateLimitState =
      (config as any).logLevel === "debug";
    config.widgets.find((w) => w.wmType === "price-check")!.apiLatencySeconds =
      2;

    config.configVersion = 6;
  }

  if (config.configVersion < 7) {
    const mapCheck = config.widgets.find((w) => w.wmType === "map-check");
    if (mapCheck) {
      mapCheck.wmType = "item-check";
      mapCheck.maps = { selectedStats: mapCheck.selectedStats };
      mapCheck.selectedStats = undefined;
    }
    (config as any).itemCheckKey = (config as any).mapCheckKey || null;
    (config as any).mapCheckKey = undefined;

    config.configVersion = 7;
  }

  if (config.configVersion < 8) {
    const itemCheck = config.widgets.find((w) => w.wmType === "item-check")!;
    (itemCheck as ItemCheckWidget).maps.showNewStats = false;
    itemCheck.maps.selectedStats = (
      itemCheck as ItemCheckWidget
    ).maps.selectedStats.map((entry) => ({
      matcher: entry.matcher,
      decision: (entry as any).valueDanger
        ? "danger"
        : (entry as any).valueWarning
          ? "warning"
          : (entry as any).valueDesirable
            ? "desirable"
            : "seen",
    }));

    config.configVersion = 8;
  }

  if (config.configVersion < 9) {
    config.widgets.find((w) => w.wmType === "price-check")!.collapseListings =
      "api";

    config.widgets.find((w) => w.wmType === "price-check")!.smartInitialSearch =
      true;
    config.widgets.find(
      (w) => w.wmType === "price-check",
    )!.lockedInitialSearch = true;

    config.widgets.find(
      (w) => w.wmType === "price-check",
    )!.activateStockFilter = false;

    config.configVersion = 9;
  }

  if (config.configVersion < 10) {
    config.widgets.push({
      ...upgradeDefaultWidgets().find((w) => w.wmType === "settings")!,
      wmId: Math.max(0, ...config.widgets.map((_) => _.wmId)) + 1,
    });

    const priceCheck = config.widgets.find((w) => w.wmType === "price-check")!;
    priceCheck.hotkey = (config as any).priceCheckKey;
    priceCheck.hotkeyHold = (config as any).priceCheckKeyHold;
    priceCheck.hotkeyLocked = (config as any).priceCheckLocked;
    priceCheck.showSeller = (config as any).showSeller;
    priceCheck.searchStatRange = (config as any).searchStatRange;
    priceCheck.showCursor = (config as any).priceCheckShowCursor;

    if (priceCheck.chaosPriceThreshold === 0.05) {
      priceCheck.chaosPriceThreshold = 0;
    }

    config.configVersion = 10;
  }

  if (config.configVersion < 11) {
    config.widgets.find(
      (w) => w.wmType === "price-check",
    )!.requestPricePrediction = false;

    config.configVersion = 11;
  }

  if (config.configVersion < 12) {
    const afterSettings = config.widgets.findIndex(
      (w) => w.wmType === "settings",
    );
    config.widgets.splice(afterSettings + 1, 0, {
      ...upgradeDefaultWidgets().find((w) => w.wmType === "item-search")!,
      wmWants: "show",
      wmId: Math.max(0, ...config.widgets.map((_) => _.wmId)) + 1,
    });

    config.realm = "pc-ggg";
    if (config.language === ("zh_TW" as string)) {
      config.language = "cmn-Hant";
    }

    config.configVersion = 12;
  }

  if (config.configVersion < 13) {
    config.showAttachNotification = true;

    config.configVersion = 13;
  }

  if (config.configVersion < 14) {
    const imgWidgets = config.widgets.filter(
      (w) => w.wmType === "image-strip",
    ) as widget.ImageStripWidget[];
    imgWidgets.forEach((imgStrip) => {
      imgStrip.images.forEach((e) => {
        e.url = e.url.startsWith("app-file://")
          ? e.url.slice("app-file://".length)
          : e.url;
      });
    });

    const itemCheck = config.widgets.find(
      (w) => w.wmType === "item-check",
    ) as ItemCheckWidget;
    itemCheck.wikiKey = (config as any).wikiKey;
    itemCheck.poedbKey = null;
    itemCheck.craftOfExileKey = (config as any).craftOfExileKey;
    itemCheck.stashSearchKey = null;

    config.configVersion = 14;
  }

  if (config.configVersion < 15) {
    const priceCheck = config.widgets.find(
      (w) => w.wmType === "price-check",
    ) as widget.PriceCheckWidget;
    priceCheck.builtinBrowser = false;

    const itemSearch = config.widgets.find((w) => w.wmType === "item-search");
    if (itemSearch) {
      itemSearch.ocrGemsKey = null;
    }

    const itemCheck = config.widgets.find(
      (w) => w.wmType === "item-check",
    ) as ItemCheckWidget;
    itemCheck.maps.profile = 1;
    for (const stat of itemCheck.maps.selectedStats) {
      const p1decision =
        stat.decision === "danger"
          ? "d"
          : stat.decision === "warning"
            ? "w"
            : stat.decision === "desirable"
              ? "g"
              : "s";

      stat.decision = `${p1decision}--`;
    }

    config.configVersion = 15;
  }

  if (config.configVersion < 16) {
    const delve = config.widgets.find((w) => w.wmType === "delve-grid");
    if (delve) {
      delve.toggleKey = (config as any).delveGridKey;
    }

    const itemCheck = config.widgets.find(
      (w) => w.wmType === "item-check",
    ) as ItemCheckWidget;
    itemCheck.hotkey = (config as any).itemCheckKey;

    if (itemCheck.maps.profile === undefined) {
      itemCheck.maps.profile = 1;
      itemCheck.maps.selectedStats = [];
    }

    config.configVersion = 16;
  }

  if (config.configVersion < 17) {
    // config.preferredTradeSite = config.language;
    config.configVersion = 17;
  }

  if (config.configVersion < 18) {
    config.enableAlphas = false;
    config.alphas = [];
    config.preferredTradeSite = "default";
    config.configVersion = 18;
  }

  if (config.configVersion < 19) {
    config.widgets.find((w) => w.wmType === "price-check")!.defaultAllSelected =
      false;
    config.configVersion = 19;
  }

  if (config.configVersion < 21) {
    config.widgets.find((w) => w.wmType === "price-check")!.itemHoverTooltip =
      "keybind";

    config.alphas = [];

    config.configVersion = 21;
  }

  const priceCheck = config.widgets.find(
    (w) => w.wmType === "price-check",
  ) as widget.PriceCheckWidget;
  if (priceCheck.rememberCurrency === undefined) {
    priceCheck.rememberCurrency = false;
  }

  for (const widget of config.widgets) {
    if (widget.wmType === "stash-search") {
      (widget as StashSearchWidget).enableHotkeys ??= true;
    }
  }

  if (config.logKeys === undefined) {
    config.logKeys = false;
  }

  if (config.configVersion < 22) {
    // NOTE: v0.7.0
    config.widgets.find(
      (w) => w.wmType === "price-check",
    )!.autoFillEmptyRuneSockets = false;

    config.tipsFrequency = TipsFrequency.Normal;

    config.configVersion = 22;
  }

  if (config.configVersion < 23) {
    for (const widget of config.widgets) {
      for (let i = 0; i < widget.wmFlags.length; ++i) {
        if (widget.wmFlags[i] === "skip-menu") {
          widget.wmFlags[i] = "menu::skip";
        }
      }
      if (widget.wmType === "settings") {
        widget.wmFlags = widget.wmFlags.filter(
          (flag: string) => !flag.startsWith("settings::"),
        );
      }
    }

    const itemSearch = config.widgets.find((w) => w.wmType === "item-search");
    if (itemSearch) {
      itemSearch.wmTitle = "{icon=fa-search}";
    }
    const settings = config.widgets.find(
      (w) => w.wmType === "settings",
    ) as widget.Widget;
    settings.wmTitle = "{icon=fa-cog}";

    // make sure icon for settings comes first in the widget menu
    config.widgets.sort((a, b) => {
      if (a.wmType === "settings") return -1;
      if (b.wmType === "settings") return 1;
      return 0;
    });

    config.configVersion = 23;
  }
  if (config.configVersion < 24) {
    // NOTE: v0.8.0
    config.widgets.find((w) => w.wmType === "price-check")!.alwaysShowTier =
      false;

    config.configVersion = 24;
  }
  if (config.configVersion < 25) {
    // NOTE: v0.9.0 || poe0.2.0
    config.widgets.find(
      (w) => w.wmType === "price-check",
    )!.openItemEditorAbove = false;

    config.configVersion = 25;
  }

  if (config.configVersion < 26) {
    // NOTE: v0.11.0 || poe0.3.0
    // Removes item filter generator
    config.widgets = config.widgets.filter(
      (w) => w.wmType !== "filter-generator",
    );

    config.configVersion = 26;
  }
  if (config.configVersion < 27) {
    // NOTE: v0.12.4 || poe0.3.0c

    const itemCheck = config.widgets.find(
      (w) => w.wmType === "item-check",
    ) as ItemCheckWidget;
    itemCheck.samePricedKey = null;

    config.configVersion = 27;
  }
  if (config.configVersion < 28) {
    // NOTE: v0.12.7 || poe0.3.0c

    const itemCheck = config.widgets.find(
      (w) => w.wmType === "item-check",
    ) as ItemCheckWidget;
    itemCheck.samePricedType = "both";

    config.configVersion = 28;
  }
  if (config.configVersion < 29) {
    // NOTE: v0.13.0 || poe0.4.0
    const itemSearchId: number =
      config.widgets.find((w) => w.wmType === "item-search")?.wmId ??
      config.widgets.length;
    // splicing to insert after the item-search widget, for positioning on the main overlay
    config.widgets.splice(itemSearchId, 0, {
      ...upgradeDefaultWidgets().find(
        (w) => w.wmType === "experience-tracker",
      )!,
      wmId: Math.max(0, ...config.widgets.map((_) => _.wmId)) + 1,
    });

    config.tipsFrequency = TipsFrequency.Never;

    const priceCheck = config.widgets.find(
      (w) => w.wmType === "price-check",
    ) as widget.PriceCheckWidget;
    priceCheck.coreCurrency = "exalted";
    priceCheck.currencyVolume = "both";

    config.readClientLog = false; // default to false, opt-in only

    config.configVersion = 29;
  }

  if (config.configVersion < 30) {
    // NOTE: v0.14.0 || poe0.4.0d
    const itemSearchId: number =
      config.widgets.find((w) => w.wmType === "item-search")?.wmId ??
      config.widgets.length;
    // splicing to insert after the item-search widget, for positioning on the main overlay
    config.widgets.splice(itemSearchId, 0, {
      ...upgradeDefaultWidgets().find((w) => w.wmType === "library")!,
      wmId: Math.max(0, ...config.widgets.map((_) => _.wmId)) + 1,
    });

    config.configVersion = 30;
  }

  if (config.configVersion < 31) {
    // NOTE: v0.15.0 || poe0.4.0k
    const priceCheck = config.widgets.find(
      (w) => w.wmType === "price-check",
    ) as widget.PriceCheckWidget;
    priceCheck.rememberListingType = false;

    config.configVersion = 31;
  }

  if (config.configVersion < 32) {
    // NOTE: v0.15.0 || poe0.5.1
    const priceCheck = config.widgets.find(
      (w) => w.wmType === "price-check",
    ) as widget.PriceCheckWidget;
    priceCheck.initialDelay = 48;

    config.configVersion = 32;
  }

  if (config.configVersion < 33) {
    // NOTE: v0.15.6 || poe0.5.2
    const libraryWidget = config.widgets.find((w) => w.wmType === "library");
    if (libraryWidget) {
      libraryWidget.selectedProfile = "chaos";
      libraryWidget.profiles.chaos.modOpts.generation = true;
    }

    // why is this one higher?
    config.configVersion = 34;
  }

  if (config.configVersion < 35) {
    // NOTE: v0.16.0 || poe0.5.5
    const priceCheck = config.widgets.find(
      (w) => w.wmType === "price-check",
    ) as widget.PriceCheckWidget;
    priceCheck.savedAugments = {};

    config.hideOverlayOnBlur = false;

    config.configVersion = 35;
  }

  // OmaExiled: drop the widgets of EE2 features that are not ported, and
  // repair the single-instance widgets the app relies on (exactly one each;
  // the menu also keeps the overlay's numeric z-order invariant).
  config.widgets = config.widgets.filter((w, idx) => {
    const component = widgetRegistry.getWidgetComponent(w.wmType);
    if (!component) return false;
    return (
      component.widget.instances !== "single" ||
      config.widgets.findIndex((_) => _.wmType === w.wmType) === idx
    );
  });
  for (const { widget } of widgetRegistry.widgets) {
    if (
      widget.instances === "single" &&
      !config.widgets.some((w) => w.wmType === widget.type)
    ) {
      config.widgets.push({
        ...widget.initInstance!(),
        wmId: Math.max(0, ...config.widgets.map((_) => _.wmId)) + 1,
      });
    }
  }

  if (config.configVersion < 36) {
    // NOTE: OmaExiled, item check gets a default hotkey (none in EE2)
    const itemCheck = config.widgets.find(
      (w) => w.wmType === "item-check",
    ) as ItemCheckWidget;
    if (
      itemCheck.hotkey == null &&
      !configHotkeys(config as unknown as Config).includes("Alt + D")
    ) {
      itemCheck.hotkey = "Alt + D";
    }

    config.configVersion = 36;
  }

  if (config.configVersion < 37) {
    // NOTE: OmaExiled, price check on the game's copy chord or on any
    // copied item (both off)
    config.gameCopyBind = false;
    config.clipboardWatch = false;

    config.configVersion = 37;
  }

  if (config.configVersion < 38) {
    // NOTE: OmaExiled, search only on click (EE2 also searched when the
    // mouse moved from the filters onto the Search button)
    const priceCheck = config.widgets.find((w) => w.wmType === "price-check");
    if (priceCheck) (priceCheck as widget.PriceCheckWidget).searchOnHover = false;

    config.configVersion = 38;
  }
  /* eslint-enable */

  return config as unknown as Config;
}

// Hotkeys of the ported features, as getConfigForHost() registers them.
function configHotkeys(config: Config): string[] {
  const keys: Array<string | null> = [config.overlayKey];
  for (const w of config.widgets) {
    if (w.wmType === "price-check") {
      const priceCheck = w as widget.PriceCheckWidget;
      if (priceCheck.hotkey) {
        keys.push(`${priceCheck.hotkeyHold} + ${priceCheck.hotkey}`);
      }
      keys.push(priceCheck.hotkeyLocked);
    } else if (w.wmType === "item-check") {
      const itemCheck = w as ItemCheckWidget;
      keys.push(
        itemCheck.hotkey,
        itemCheck.wikiKey,
        itemCheck.craftOfExileKey,
        itemCheck.poedbKey,
        itemCheck.stashSearchKey,
        itemCheck.samePricedKey,
      );
    } else if (w.wmType === "stash-search") {
      const entries = (w as StashSearchWidget).entries ?? [];
      keys.push(...entries.map((e) => e.hotkey));
    }
  }
  keys.push(...config.commands.map((c) => c.hotkey));
  return keys.filter((key): key is string => Boolean(key));
}

function getConfigForHost(): HostConfig {
  const actions: ShortcutAction[] = [];

  const config = AppConfig();
  const priceCheck = AppConfig("price-check") as widget.PriceCheckWidget;
  if (priceCheck.hotkey) {
    actions.push({
      shortcut: `${priceCheck.hotkeyHold} + ${priceCheck.hotkey}`,
      action: { type: "copy-item", target: "price-check", focusOverlay: false },
      keepModKeys: true,
    });
  }
  if (priceCheck.hotkeyLocked) {
    actions.push({
      shortcut: priceCheck.hotkeyLocked,
      action: { type: "copy-item", target: "price-check", focusOverlay: true },
    });
  }
  actions.push({
    shortcut: config.overlayKey,
    action: { type: "toggle-overlay" },
  });
  const itemCheck = AppConfig("item-check") as ItemCheckWidget;
  if (itemCheck.wikiKey) {
    actions.push({
      shortcut: itemCheck.wikiKey,
      action: { type: "copy-item", target: "open-wiki" },
    });
  }
  if (itemCheck.craftOfExileKey) {
    actions.push({
      shortcut: itemCheck.craftOfExileKey,
      action: { type: "copy-item", target: "open-craft-of-exile" },
    });
  }
  if (itemCheck.poedbKey) {
    actions.push({
      shortcut: itemCheck.poedbKey,
      action: { type: "copy-item", target: "open-poedb" },
    });
  }
  if (itemCheck.stashSearchKey) {
    actions.push({
      shortcut: itemCheck.stashSearchKey,
      action: { type: "copy-item", target: "search-similar" },
    });
  }
  if (itemCheck.samePricedKey) {
    actions.push({
      shortcut: itemCheck.samePricedKey,
      action: { type: "copy-item", target: "search-same-priced" },
    });
  }
  if (itemCheck.hotkey) {
    actions.push({
      shortcut: itemCheck.hotkey,
      action: { type: "copy-item", target: "item-check", focusOverlay: true },
    });
  }
  for (const command of config.commands) {
    if (command.hotkey) {
      actions.push({
        shortcut: command.hotkey,
        action: {
          type: "paste-in-chat",
          text: command.text,
          send: command.send,
        },
      });
    }
  }
  for (const widget of config.widgets) {
    if (widget.wmType === "stash-search") {
      const stashSearch = widget as StashSearchWidget;
      if (!stashSearch.enableHotkeys) continue;

      for (const entry of stashSearch.entries) {
        if (entry.hotkey) {
          actions.push({
            shortcut: entry.hotkey,
            action: { type: "stash-search", text: entry.text },
          });
        }
      }
    }
  }

  return {
    shortcuts: actions,
    restoreClipboard: config.restoreClipboard,
    // client log, library: not ported
    clientLog: null,
    gameConfig: config.gameConfig,
    stashScroll: config.stashScroll,
    overlayKey: config.overlayKey,
    logKeys: config.logKeys,
    windowTitle: config.windowTitle,
    language: config.language,
    readClientLog: false,
    libraryAlpha: false,
    libraryOutputPath: null,
    initialDelay: priceCheck.initialDelay,
    hideOverlayOnBlur: config.hideOverlayOnBlur,
    gameCopyBind: config.gameCopyBind,
    clipboardWatch: config.clipboardWatch,
  };
}

// Disable since this is export for tests
// eslint-disable-next-line @typescript-eslint/naming-convention
export const __testExports = {
  upgradeConfig,
  getConfigForHost,
};
