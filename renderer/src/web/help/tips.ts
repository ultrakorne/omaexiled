import { TipsFrequency } from "../Config";

export const TIP_COUNT = 29; // v0.7.0

// Tips about features that are not ported: 1 cheat sheets, 15 and 22 map
// check, 19 stopwatch, 23 stash tab scrolling.
const UNPORTED_TIPS = [1, 15, 19, 22, 23];
export const TIPS = Array.from({ length: TIP_COUNT }, (_, i) => i + 1).filter(
  (tip) => !UNPORTED_TIPS.includes(tip),
);

export function randomTip(): number {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

export const TIP_FREQUENCY_MAP: Record<TipsFrequency, number> = {
  [TipsFrequency.Always]: 1,
  [TipsFrequency.MoreOften]: 7,
  [TipsFrequency.Normal]: 20,
  [TipsFrequency.Rarely]: 50,
  [TipsFrequency.VeryRarely]: 100,
  [TipsFrequency.Never]: -1,
};
