import { describe, expect, test } from "bun:test";
import { Actions, chatKeySequence, copyChord, stashSearchSequence, type KeyStep } from "../src/actions";
import { HostClipboard } from "../src/clipboard";
import { Logger } from "../src/logger";

const fmt = (keys: KeyStep[]) => keys.map((k) => (k.mods ? `${k.mods}+${k.key}` : k.key));
const SEND_TAIL = ["Return", "Return", "Up", "Up", "Escape"];

// EE2 main/src/shortcuts/text-box.ts typeInChat
describe("chatKeySequence", () => {
  describe("branch A: text starts with @last", () => {
    test.each([true, false])("send=%p", (send) => {
      const seq = chatKeySequence("@last ty", send);
      expect(seq.clipboard).toBe("ty");
      expect(fmt(seq.keys)).toEqual(["CTRL+Return", "CTRL+V", ...(send ? SEND_TAIL : [])]);
    });
  });

  describe("branch B: text ends with @last", () => {
    test.each([true, false])("send=%p", (send) => {
      const seq = chatKeySequence("/invite @last", send);
      expect(seq.clipboard).toBe("/invite ");
      expect(fmt(seq.keys)).toEqual([
        "CTRL+Return",
        "Home",
        "Home",
        "Delete",
        "CTRL+V",
        ...(send ? SEND_TAIL : []),
      ]);
    });

    test("tradewith / hideout @last keep the trailing space", () => {
      expect(chatKeySequence("/tradewith @last", true).clipboard).toBe("/tradewith ");
      expect(chatKeySequence("/hideout @last", true).clipboard).toBe("/hideout ");
    });
  });

  describe("branch C: plain text", () => {
    test.each([true, false])("command (auto-clear prefix), send=%p", (send) => {
      const seq = chatKeySequence("/hideout", send);
      expect(seq.clipboard).toBe("/hideout");
      expect(fmt(seq.keys)).toEqual(["Return", "CTRL+V", ...(send ? SEND_TAIL : [])]);
    });

    test.each([true, false])("plain text selects the channel text first, send=%p", (send) => {
      const seq = chatKeySequence("hello world", send);
      expect(seq.clipboard).toBe("hello world");
      expect(fmt(seq.keys)).toEqual(["Return", "CTRL+A", "CTRL+V", ...(send ? SEND_TAIL : [])]);
    });

    test.each(["#", "%", "@", "$", "&", "/"])("prefix %s needs no Ctrl+A", (p) => {
      expect(fmt(chatKeySequence(`${p}x`, false).keys)).toEqual(["Return", "CTRL+V"]);
    });
  });
});

test("stashSearchSequence", () => {
  const seq = stashSearchSequence('"Exalted Orb"');
  expect(seq.clipboard).toBe('"Exalted Orb"');
  expect(fmt(seq.keys)).toEqual(["CTRL+F", "CTRL+V", "Return"]);
});

test("copyChord", () => {
  expect(copyChord("Alt")).toEqual({ mods: "CTRL ALT", key: "C" });
  expect(copyChord("Shift")).toEqual({ mods: "CTRL SHIFT", key: "C" });
  expect(copyChord("Ctrl")).toEqual({ mods: "CTRL", key: "C" });
});

describe("Actions (keys sent over the request socket)", () => {
  function setup(game: { address: string } | null) {
    const sent: { t: number; expr: string }[] = [];
    const clip = { text: "mine", writes: [] as string[] };
    const logger = new Logger();
    logger.write = () => {};
    const clipboard = new HostClipboard(logger, {
      read: async () => clip.text,
      write: async (t) => {
        clip.writes.push(t);
        clip.text = t;
      },
    });
    clipboard.updateDelay(5);
    const events: any[] = [];
    const overlay = {
      game,
      tracker: { stop() {} },
      wasUsedRecently: true,
      cursorInSurface: async () => ({ x: 5, y: 6 }),
      sendItemText: (p: any) => events.push(p),
      assertOverlayActive: () => events.push("active"),
      assertGameActive: () => events.push("game"),
    };
    const actions = new Actions({
      hypr: {
        dispatch: async (expr: string) => {
          sent.push({ t: Date.now(), expr });
          // the fake game copies on the copy chord
          if (expr.includes('key = "C"')) clip.text = "Item Class: Rings\nRarity: Rare";
        },
      } as any,
      logger,
      clipboard,
      gameConfig: { showModsKey: "Alt" } as any,
      overlay: overlay as any,
      logKeys: () => false,
      refreshGameConfig: () => {},
      broadcast: () => {},
    });
    return { actions, sent, clip, events };
  }

  const ks = (mods: string, key: string, state: string) =>
    `hl.dsp.send_key_state({ mods = "${mods}", key = "${key}", state = "${state}", window = "address:0xabc" })`;
  const tap = (key: string) => [ks("", key, "down"), ks("", key, "up")];

  test("chat: clipboard first, then each step as key presses to the game window, ~30 ms apart", async () => {
    const { actions, sent, clip } = setup({ address: "0xabc" });
    await actions.typeInChat("/hideout", true);
    expect(clip.writes[0]).toBe("/hideout");
    expect(sent.map((s) => s.expr)).toEqual([
      ...tap("Return"),
      // Wine only sees Ctrl when it is pressed as a key of its own
      ks("CTRL", "Control_L", "down"),
      ks("CTRL", "V", "down"),
      ks("CTRL", "V", "up"),
      ks("", "Control_L", "up"),
      ...tap("Return"),
      ...tap("Return"),
      ...tap("Up"),
      ...tap("Up"),
      ...tap("Escape"),
    ]);
    // steps are ~30 ms apart; a key stays down for a moment
    const downs = sent.filter((s) => s.expr.includes('state = "down"') && !s.expr.includes("Control_L"));
    for (let i = 1; i < downs.length; i++) expect(downs[i].t - downs[i - 1].t).toBeGreaterThanOrEqual(25);
  });

  test("stash search gives the game focus back first", async () => {
    const { actions, sent, events } = setup({ address: "0xabc" });
    await actions.stashSearch("rings");
    expect(events).toEqual(["game"]);
    // Ctrl+F, Ctrl+V (4 events each), Return (2)
    expect(sent).toHaveLength(10);
  });

  test("copy-item: copy chord, item-text, locked activates", async () => {
    const { actions, sent, events } = setup({ address: "0xabc" });
    const text = await actions.copyItem({ type: "copy-item", target: "price-check", focusOverlay: true });
    expect(text).toStartWith("Item Class: Rings");
    expect(sent.map((s) => s.expr)).toEqual([
      ks("CTRL", "Control_L", "down"),
      ks("CTRL ALT", "Alt_L", "down"),
      ks("CTRL ALT", "C", "down"),
      ks("CTRL ALT", "C", "up"),
      ks("CTRL", "Alt_L", "up"),
      ks("", "Control_L", "up"),
    ]);
    expect(events).toEqual([
      { target: "price-check", clipboard: text, position: { x: 5, y: 6 }, focusOverlay: true },
      "active",
    ]);
  });

  test("no PoE2 window: nothing is typed and the clipboard is untouched", async () => {
    const { actions, sent, clip } = setup(null);
    await expect(actions.typeInChat("/hideout", true)).rejects.toThrow("Path of Exile 2 window not found");
    await expect(actions.stashSearch("x")).rejects.toThrow();
    await expect(actions.copyItem({ type: "copy-item", target: "price-check" })).rejects.toThrow();
    expect(sent).toEqual([]);
    expect(clip.writes).toEqual([]);
  });
});
