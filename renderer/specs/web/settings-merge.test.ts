import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import type { Config } from "@/web/Config";
import { mergeConfigEdits } from "@/web/settings/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

// A minimal config: only the fields the merge looks at matter.
function config(): Config {
  return {
    configVersion: 37,
    leagueId: "Standard",
    fontSize: 16,
    gameCopyBind: false,
    widgets: [
      { wmId: 1, wmType: "menu", wmZorder: 1, wmFlags: [] },
      {
        wmId: 2,
        wmType: "price-check",
        wmZorder: "exclusive",
        wmFlags: [],
        showRateLimitState: false,
        searchStatRange: 10,
        savedAugments: {},
      },
      {
        wmId: 3,
        wmType: "stash-search",
        wmZorder: 2,
        wmFlags: [],
        entries: [{ id: "a", text: "one", hotkey: null }],
      },
    ],
  } as any;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function widget(cfg: Config, wmId: number): any {
  return cfg.widgets.find((w) => w.wmId === wmId);
}

describe("mergeConfigEdits", () => {
  it("keeps changes saved elsewhere since the clone", () => {
    const base = config();
    const edited = reactive(clone(base));
    edited.fontSize = 18;
    widget(edited, 2).searchStatRange = 5;

    const current = config();
    current.leagueId = "Rise of the Abyssal";
    widget(current, 2).showRateLimitState = true;
    widget(current, 2).savedAugments = { "Some Item": ["rune"] };
    widget(current, 3).entries.push({ id: "b", text: "two", hotkey: null });

    const merged = mergeConfigEdits(base, edited, current);
    expect(merged.fontSize).toBe(18);
    expect(merged.leagueId).toBe("Rise of the Abyssal");
    expect(widget(merged, 2)).toMatchObject({
      searchStatRange: 5,
      showRateLimitState: true,
      savedAugments: { "Some Item": ["rune"] },
    });
    expect(widget(merged, 3).entries).toHaveLength(2);
  });

  it("takes the window's value of a field changed on both sides", () => {
    const base = config();
    const edited = clone(base);
    edited.leagueId = "Hardcore";
    const current = config();
    current.leagueId = "Rise of the Abyssal";
    expect(mergeConfigEdits(base, edited, current).leagueId).toBe("Hardcore");
  });

  it("is the current config when nothing was edited", () => {
    const base = config();
    const current = config();
    current.fontSize = 20;
    widget(current, 2).showRateLimitState = true;
    expect(mergeConfigEdits(base, clone(base), current)).toEqual(current);
  });

  it("applies widgets added and removed in the window", () => {
    const base = config();
    const edited = clone(base);
    edited.widgets = edited.widgets.filter((w) => w.wmId !== 3);
    edited.widgets.push({ ...clone(widget(base, 3)), wmId: 4 });

    const current = config();
    // the overlay added a widget with the same id meanwhile
    current.widgets.push({ ...clone(widget(base, 3)), wmId: 4, wmTitle: "x" });

    const merged = mergeConfigEdits(base, edited, current);
    expect(merged.widgets.map((w) => w.wmId)).toEqual([1, 2, 4, 5]);
    expect(widget(merged, 4).wmTitle).toBe("x");
  });

  it("removes keys the window removed and does not share objects", () => {
    const base = config();
    const edited = clone(base);
    delete edited.leagueId;
    const current = config();
    const merged = mergeConfigEdits(base, edited, current);
    expect("leagueId" in merged).toBe(false);
    expect(merged.widgets).not.toBe(current.widgets);
    expect(widget(merged, 2)).not.toBe(widget(current, 2));
  });
});
