import { describe, expect, it, vi } from "vitest";
import type { Config } from "@/web/Config";

// the real Config.ts and widget registry (vitest.setup.ts mocks Config)
vi.unmock("@/web/Config");
// apexcharts needs `window` on import
vi.mock("vue3-apexcharts", () => ({ default: {} }));

// same import order as main.ts: widgets before Config.ts
const { registry } = await import("@/web/overlay/widget-registry");
const ConfigModule = await import("@/web/Config");
const { defaultConfig, updateConfig } = ConfigModule;
const { upgradeConfig, getConfigForHost } = ConfigModule.__testExports;

/* eslint-disable @typescript-eslint/no-explicit-any */

// An EE2 0.16 config (configVersion 34) with EE2's default widgets.
function ee2Config(): any {
  const kept = defaultConfig().widgets as any[];
  const find = (type: string) => kept.filter((w) => w.wmType === type);
  const widgets = [
    ...find("menu"),
    ...find("settings"),
    {
      wmType: "item-search",
      wmTitle: "{icon=fa-search}",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["invisible-on-blur"],
      anchor: { pos: "tl", x: 10, y: 20 },
      ocrGemsKey: null,
    },
    {
      wmType: "experience-tracker",
      wmTitle: "XP",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["menu::skip"],
      anchor: { pos: "bc", x: 68, y: 98 },
      showExp: true,
    },
    ...find("stash-search"),
    {
      ...find("price-check")[0],
      requestPricePrediction: false,
      autoFillEmptyRuneSockets: false,
      openItemEditorAbove: false,
    },
    { ...find("item-check")[0], hotkey: null },
    {
      wmType: "image-strip",
      wmTitle: "Cheat sheets",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["invisible-on-blur"],
      anchor: { pos: "tc", x: 50, y: 10 },
      images: [{ id: 1, url: "syndicate.jpg" }],
    },
    {
      wmType: "delve-grid",
      wmTitle: "",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["hide-on-focus", "menu::skip"],
      toggleKey: "Ctrl + G",
    },
    {
      wmType: "library",
      wmTitle: "{icon=fa-book}",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["invisible-on-blur", "menu::skip"],
      anchor: { pos: "tl", x: 20, y: 20 },
      logItemKey: "Ctrl + L",
      libraryOutputPath: null,
      selectedProfile: "chaos",
      profiles: { chaos: { modOpts: { generation: true } } },
    },
    {
      wmType: "timer",
      wmTitle: "",
      wmWants: "hide",
      wmZorder: 2,
      wmFlags: ["invisible-on-blur"],
      anchor: { pos: "tl", x: 50, y: 50 },
      toggleKey: "Ctrl + T",
      resetKey: null,
    },
  ].map((w, idx) => ({ ...w, wmId: idx + 1 }));

  return {
    ...defaultConfig(),
    configVersion: 34,
    hideOverlayOnBlur: null,
    leagueId: "Standard",
    widgets,
  };
}

function itemCheck(config: Config): any {
  return config.widgets.find((w) => w.wmType === "item-check");
}

function expectValid(config: Config) {
  const types = registry.widgets.map((c) => c.widget.type);
  for (const w of config.widgets) {
    expect(types).toContain(w.wmType);
  }
  for (const type of ["menu", "settings", "price-check", "item-check"]) {
    expect(config.widgets.filter((w) => w.wmType === type)).toHaveLength(1);
  }
  const ids = config.widgets.map((w) => w.wmId);
  expect(new Set(ids).size).toBe(ids.length);
  // OverlayWindow's topmostWidget needs a numeric z-order
  expect(config.widgets.some((w) => typeof w.wmZorder === "number")).toBe(true);
  expect(config.configVersion).toBe(38);
}

function hostConfig(config: Config) {
  vi.stubGlobal("document", { documentElement: { style: {} } });
  updateConfig(config);
  const host = getConfigForHost();
  vi.unstubAllGlobals();
  return host;
}

describe("defaultConfig", () => {
  it("has only the ported widgets", () => {
    const config = defaultConfig();
    expect(config.widgets.map((w) => [w.wmId, w.wmType])).toEqual([
      [1, "menu"],
      [2, "settings"],
      [3, "stash-search"],
      [4, "stash-search"],
      [5, "price-check"],
      [6, "item-check"],
    ]);
    expect(itemCheck(config).hotkey).toBe("Alt + D");
    expect(config.gameCopyBind).toBe(false);
    expect(config.clipboardWatch).toBe(false);
    expectValid(upgradeConfig(config));
  });
});

describe("upgradeConfig", () => {
  it("imports an EE2 config and drops the widgets that are not ported", () => {
    const config = upgradeConfig(ee2Config());
    expectValid(config);
    expect(config.widgets.map((w) => [w.wmId, w.wmType])).toEqual([
      [1, "menu"],
      [2, "settings"],
      [5, "stash-search"],
      [6, "stash-search"],
      [7, "price-check"],
      [8, "item-check"],
    ]);
    expect(config.hideOverlayOnBlur).toBe(false);
    expect(itemCheck(config).hotkey).toBe("Alt + D");
    expect(config.gameCopyBind).toBe(false);
    expect(config.clipboardWatch).toBe(false);
  });

  it("adds the copy triggers to a configVersion 36 config, off", () => {
    const v36: any = defaultConfig();
    v36.configVersion = 36;
    delete v36.gameCopyBind;
    delete v36.clipboardWatch;
    const config = upgradeConfig(v36);
    expectValid(config);
    expect(config.gameCopyBind).toBe(false);
    expect(config.clipboardWatch).toBe(false);
  });

  it("turns off search on hover for older configs (search only on click)", () => {
    const v37: any = defaultConfig();
    v37.configVersion = 37;
    const pc = v37.widgets.find((w: any) => w.wmType === "price-check");
    delete pc.searchOnHover;
    const config = upgradeConfig(v37);
    expectValid(config);
    const upgraded: any = config.widgets.find((w) => w.wmType === "price-check");
    expect(upgraded.searchOnHover).toBe(false);
  });

  it("keeps the copy triggers of its own configs", () => {
    const config = defaultConfig();
    config.gameCopyBind = true;
    config.clipboardWatch = true;
    const upgraded = upgradeConfig(config);
    expect(upgraded.gameCopyBind).toBe(true);
    expect(upgraded.clipboardWatch).toBe(true);
  });

  it("keeps the item check hotkey of an EE2 config", () => {
    const ee2 = ee2Config();
    itemCheck(ee2).hotkey = "Ctrl + I";
    expect(itemCheck(upgradeConfig(ee2)).hotkey).toBe("Ctrl + I");
  });

  it("does not take Alt + D from another action", () => {
    const ee2 = ee2Config();
    ee2.commands[2].hotkey = "Alt + D";
    expect(itemCheck(upgradeConfig(ee2)).hotkey).toBe(null);

    const ee2Hold = ee2Config();
    ee2Hold.widgets.find((w: any) => w.wmType === "price-check").hotkeyHold =
      "Alt";
    expect(itemCheck(upgradeConfig(ee2Hold)).hotkey).toBe(null);
  });

  it("does not set Alt + D again on its own configs", () => {
    const config = defaultConfig();
    itemCheck(config).hotkey = null;
    expect(itemCheck(upgradeConfig(config)).hotkey).toBe(null);
  });

  it.each(Array.from({ length: 37 }, (_, v) => v))(
    "runs from configVersion %i, with and without the EE2 widgets",
    (version) => {
      const ee2 = ee2Config();
      ee2.configVersion = version;
      expectValid(upgradeConfig(ee2));

      const trimmed = defaultConfig();
      trimmed.configVersion = version;
      expectValid(upgradeConfig(trimmed));
    },
  );

  it("repairs missing and duplicate single-instance widgets", () => {
    const config = defaultConfig();
    const priceCheck = config.widgets.find((w) => w.wmType === "price-check")!;
    config.widgets = config.widgets.filter((w) => w.wmType !== "menu");
    config.widgets.push({ ...priceCheck, wmId: 99 });
    const upgraded = upgradeConfig(config);
    expectValid(upgraded);
    expect(upgraded.widgets.find((w) => w.wmType === "menu")!.wmZorder).toBe(1);
  });
});

describe("getConfigForHost", () => {
  it("registers only the ported actions", () => {
    const host = hostConfig(upgradeConfig(ee2Config()));
    expect(host.shortcuts.map((s) => [s.shortcut, s.action.type])).toEqual([
      ["Ctrl + D", "copy-item"],
      ["Ctrl + Alt + D", "copy-item"],
      ["Shift + Space", "toggle-overlay"],
      ["Alt + D", "copy-item"],
      ["F5", "paste-in-chat"],
      ["F9", "paste-in-chat"],
    ]);
    expect(host.libraryAlpha).toBe(false);
    expect(host.libraryOutputPath).toBe(null);
    expect(host.clientLog).toBe(null);
    expect(host.readClientLog).toBe(false);
    expect(host.gameCopyBind).toBe(false);
    expect(host.clipboardWatch).toBe(false);
  });

  it("passes the copy triggers", () => {
    const config = defaultConfig();
    config.gameCopyBind = true;
    const host = hostConfig(config);
    expect(host.gameCopyBind).toBe(true);
    expect(host.clipboardWatch).toBe(false);

    config.gameCopyBind = false;
    config.clipboardWatch = true;
    const host2 = hostConfig(config);
    expect(host2.gameCopyBind).toBe(false);
    expect(host2.clipboardWatch).toBe(true);
  });
});
