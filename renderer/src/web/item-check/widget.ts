import type { Widget } from "../overlay/widgets.js";

export interface ItemCheckWidget extends Widget {
  hotkey: string | null;
  wikiKey: string | null;
  poedbKey: string | null;
  craftOfExileKey: string | null;
  stashSearchKey: string | null;
  samePricedKey: string | null;
  samePricedType: "price" | "both";
  maps: MapCheckConfig;
}

// Map check is not ported; its settings stay in the config so that imported
// EE2 configs keep them.
export interface MapCheckConfig {
  profile: number;
  showNewStats: boolean;
  selectedStats: Array<{
    matcher: string;
    decision: string;
  }>;
}
