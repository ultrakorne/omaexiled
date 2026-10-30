import { computed } from "vue";
import type { PropType } from "vue";
import isDeepEqual from "fast-deep-equal";
import type { Config } from "@/web/Config";
import type { Widget } from "@/web/overlay/interfaces";

export function configProp<T = undefined>() {
  return {
    config: {
      type: Object as PropType<Config>,
      required: true as const,
    },
    configWidget: {
      type: Object as PropType<T>,
      default: undefined as unknown as T,
    },
  };
}

export function configModelValue<
  ObjectT extends object,
  KeyT extends keyof ObjectT,
>(getObj: () => ObjectT, key: KeyT) {
  return computed<ObjectT[KeyT]>({
    get() {
      return getObj()[key];
    },
    set(value) {
      getObj()[key] = value;
    },
  });
}

export function _configModelValue<
  ObjectT extends object,
  KeyT extends keyof ObjectT,
>(obj: ObjectT, key: KeyT) {
  return {
    get value(): ObjectT[KeyT] {
      return obj[key];
    },
    set value(value: ObjectT[KeyT]) {
      obj[key] = value;
    },
  };
}

export function findWidget<T extends Widget>(type: string, config: Config) {
  return config.widgets.find((w) => w.wmType === type) as T | undefined;
}

// OmaExiled: the settings window is a long-lived page, and the overlay keeps
// saving its own changes while it is open (item editor augments, the rate
// limit toggle, stash search widgets). Its Save applies only what was edited
// in the window (`edited` vs `base`, the config it was cloned from) on top of
// the `current` config: top-level keys, widget fields by wmId, and widgets
// added or removed in the window. A field changed on both sides takes the
// window's value.
export function mergeConfigEdits(
  base: Config,
  edited: Config,
  current: Config,
): Config {
  const merged = clone(current);
  mergeFields(merged, base, edited, "widgets");

  const baseWidgets = new Map(base.widgets.map((w) => [w.wmId, w]));
  const editedWidgets = new Map(edited.widgets.map((w) => [w.wmId, w]));
  merged.widgets = merged.widgets.filter(
    (w) => !baseWidgets.has(w.wmId) || editedWidgets.has(w.wmId),
  );
  for (const w of merged.widgets) {
    const baseWidget = baseWidgets.get(w.wmId);
    const editedWidget = editedWidgets.get(w.wmId);
    if (baseWidget && editedWidget) {
      mergeFields(w, baseWidget, editedWidget);
    }
  }
  for (const w of edited.widgets) {
    if (baseWidgets.has(w.wmId)) continue;
    const added = clone(w);
    if (merged.widgets.some((_) => _.wmId === added.wmId)) {
      added.wmId = Math.max(0, ...merged.widgets.map((_) => _.wmId)) + 1;
    }
    merged.widgets.push(added);
  }
  return merged;
}

function mergeFields(
  target: object,
  base: object,
  edited: object,
  skipKey?: string,
) {
  const t = target as Record<string, unknown>;
  const b = base as Record<string, unknown>;
  const e = edited as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(e)])) {
    if (key === skipKey || isDeepEqual(b[key], e[key])) continue;
    if (e[key] === undefined) {
      Reflect.deleteProperty(t, key);
    } else {
      t[key] = clone(e[key]);
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
