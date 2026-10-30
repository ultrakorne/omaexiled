import { describe, expect, test } from "bun:test";
import { HostClipboard, LANGUAGE_DETECTOR, isPoeItem, type ClipboardIO } from "../src/clipboard";
import { Logger } from "../src/logger";

function logger() {
  const lines: string[] = [];
  const l = new Logger();
  l.write = (m: string) => {
    lines.push(m);
  };
  return { l, lines };
}

// In-memory clipboard; `onWrite` lets a test play the game.
function fakeClipboard(initial = "") {
  const state = { text: initial, writes: [] as string[] };
  const io: ClipboardIO = {
    async read() {
      return state.text;
    },
    async write(text) {
      state.writes.push(text);
      state.text = text;
    },
  };
  return { io, state };
}

describe("isPoeItem", () => {
  const markers = LANGUAGE_DETECTOR.flatMap((l) => [l.firstLine, l.uncutSkillGemLine]);

  test("22 markers from EE2 HostClipboard.ts", () => {
    expect(markers).toHaveLength(22);
    expect(LANGUAGE_DETECTOR.map((l) => l.lang)).toEqual([
      "en", "ru", "fr", "de", "pt", "es", "th", "ko", "cmn-Hant", "cmn-Hans", "ja",
    ]);
  });

  test.each([
    "Item Class: Rings\nRarity: Rare",
    "Rarity: Unique\nUncut Skill Gem",
    "Класс предмета: Кольца",
    "Редкость: Редкий",
    "Classe d'objet: Anneaux",
    "Rareté: Rare",
    "Gegenstandsklasse: Ringe",
    "Seltenheit: Selten",
    "Classe do Item: Anéis",
    "Raridade: Raro",
    "Clase de objeto: Anillos",
    "Rareza: Raro",
    "ชนิดไอเทม: แหวน",
    "아이템 종류: 반지",
    "아이템 희귀도: 희귀",
    "物品種類: 戒指",
    "稀有度: 稀有",
    "物品类别: 戒指",
    "アイテムクラス: 指輪",
    "レアリティ: レア",
  ])("detects %s", (text) => {
    expect(isPoeItem(text)).toBeTruthy();
  });

  test.each([
    "",
    "__EE2_FORCE_EMPTY_1700000000000",
    " Item Class: Rings",
    "Item Class:Rings", // the trailing space is significant
    "item class: rings",
    "Some text\nItem Class: Rings",
  ])("rejects %j", (text) => {
    expect(isPoeItem(text)).toBeFalsy();
  });
});

const ITEM = "Item Class: Rings\nRarity: Rare\nDire Loop\nRuby Ring";

describe("HostClipboard.readItemText", () => {
  test("writes the sentinel before pressing, then finds the item", async () => {
    const { io, state } = fakeClipboard("password");
    const cb = new HostClipboard(logger().l, io);
    cb.updateDelay(5);
    let sentinelAtPress = "";
    const text = await cb.readItemText(async () => {
      sentinelAtPress = state.text;
      setTimeout(() => (state.text = ITEM), 20);
    });
    expect(text).toBe(ITEM);
    expect(sentinelAtPress).toMatch(/^__EE2_FORCE_EMPTY_\d+$/);
    // restoreClipboard is off by default: the item stays on the clipboard
    expect(state.text).toBe(ITEM);
  });

  test("restores the previous clipboard when enabled", async () => {
    const { io, state } = fakeClipboard("password");
    const cb = new HostClipboard(logger().l, io);
    cb.updateDelay(5);
    cb.updateOptions(true);
    await cb.readItemText(async () => {
      state.text = ITEM;
    });
    await Bun.sleep(5);
    expect(state.text).toBe("password");
  });

  test("an item already on the clipboard is not restored", async () => {
    const { io, state } = fakeClipboard(ITEM);
    const cb = new HostClipboard(logger().l, io);
    cb.updateDelay(5);
    cb.updateOptions(true);
    await cb.readItemText(async () => {
      state.text = ITEM;
    });
    await Bun.sleep(5);
    expect(state.text).toBe("");
  });

  test("times out after ~500 ms with EE2's warning", async () => {
    const { io } = fakeClipboard("x");
    const { l, lines } = logger();
    const cb = new HostClipboard(l, io);
    cb.updateDelay(5);
    const t0 = Date.now();
    await expect(cb.readItemText(async () => {})).rejects.toThrow("Reading clipboard timed out");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(480);
    expect(lines).toEqual(["warn [ClipboardPoller] No item text found."]);
    expect(cb.isPolling).toBe(false);
  });

  test("a second press while polling shares the poll and presses again", async () => {
    const { io, state } = fakeClipboard("");
    const cb = new HostClipboard(logger().l, io);
    cb.updateDelay(30);
    let presses = 0;
    const press = async () => {
      presses++;
    };
    const a = cb.readItemText(press);
    await Bun.sleep(10);
    const b = cb.readItemText(press);
    state.text = ITEM;
    expect(await a).toBe(ITEM);
    expect(await b).toBe(ITEM);
    expect(presses).toBe(2);
  });
});

describe("HostClipboard.restoreShortly", () => {
  test("throttles a second action and restores after 300 ms", async () => {
    const { io, state } = fakeClipboard("mine");
    const cb = new HostClipboard(logger().l, io);
    cb.updateOptions(true);
    const ran: string[] = [];
    const first = cb.restoreShortly(async (write) => {
      ran.push("first");
      await write("/hideout");
    });
    const second = cb.restoreShortly(async () => {
      ran.push("second");
    });
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(ran).toEqual(["first"]);
    expect(state.text).toBe("/hideout");
    // still throttled right after
    expect(await cb.restoreShortly(async () => {})).toBe(false);
    await Bun.sleep(320);
    expect(state.text).toBe("mine");
  });

  test("a new action keeps the original text when a restore is pending", async () => {
    const { io, state } = fakeClipboard("mine");
    const cb = new HostClipboard(logger().l, io);
    cb.updateOptions(true);
    await cb.restoreShortly((write) => write("/hideout"));
    await Bun.sleep(150); // past the throttle, before the restore
    await cb.restoreShortly((write) => write("/exit"));
    expect(state.text).toBe("/exit");
    await Bun.sleep(320);
    expect(state.text).toBe("mine");
    expect(state.writes).toEqual(["/hideout", "/exit", "mine"]);
  });

  test("no restore by default", async () => {
    const { io, state } = fakeClipboard("mine");
    const cb = new HostClipboard(logger().l, io);
    await cb.restoreShortly((write) => write("/hideout"));
    await Bun.sleep(320);
    expect(state.text).toBe("/hideout");
  });
});

describe("HostClipboard.waitForGameCopy", () => {
  test("takes the new item", async () => {
    const { io, state } = fakeClipboard("old");
    const cb = new HostClipboard(logger().l, io);
    cb.updateDelay(5);
    setTimeout(() => (state.text = ITEM), 30);
    expect(await cb.waitForGameCopy()).toBe(ITEM);
  });

  test("a re-copy of the same item is accepted at the end of the window", async () => {
    const { io } = fakeClipboard(ITEM);
    const cb = new HostClipboard(logger().l, io);
    cb.updateDelay(5);
    expect(await cb.waitForGameCopy()).toBe(ITEM);
  });
});
