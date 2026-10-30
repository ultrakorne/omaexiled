<template>
  <div class="max-w-md p-2">
    <div class="mb-2 bg-gray-700 rounded px-2 py-1 leading-none">
      <i class="fas fa-info-circle"></i> {{ t("settings.clear_hotkey") }}
    </div>
    <div class="flex flex-col gap-4 mb-8">
      <HotkeysGeneric :hotkeys="hotkeys" />
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: "settings.hotkeys",
};
</script>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { configProp, _configModelValue, findWidget } from "./utils";
import { PriceCheckWidget } from "@/web/overlay/interfaces";
import { ItemCheckWidget } from "../item-check/widget.js";

import HotkeysGeneric, { HotkeySchema } from "../settings/HotkeysGeneric.vue";

const props = defineProps(configProp());

const hotkeys = computed<HotkeySchema[]>(() => {
  const priceCheckWidget = findWidget<PriceCheckWidget>(
    "price-check",
    props.config,
  )!;
  const itemCheckWidget = findWidget<ItemCheckWidget>(
    "item-check",
    props.config,
  )!;
  return [
    {
      translationKey: "price_check.name",
      items: [
        {
          translationKey: "price_check.hotkey",
          config: {
            modKey: _configModelValue(priceCheckWidget, "hotkeyHold"),
            nonModKey: _configModelValue(priceCheckWidget, "hotkey"),
          },
        },
        {
          translationKey: "price_check.hotkey_locked",
          config: _configModelValue(priceCheckWidget, "hotkeyLocked"),
        },
      ],
    },
    {
      translationKey: "settings.overlay",
      config: _configModelValue(props.config, "overlayKey"),
      required: true,
    },
    {
      translationKey: "item.info",
      config: _configModelValue(itemCheckWidget, "hotkey"),
    },
  ];
});

const { t } = useI18n();
</script>
