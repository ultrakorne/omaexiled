<template>
  <div class="p-2 flex flex-col h-full items-center">
    <div class="flex flex-col items-center p-2 mb-4">
      <img class="w-12 h-12" src="/images/jeweler.png" />
      <p class="text-base">OmaExiled</p>
      <p class="">{{ t("app.version", [version]) }}</p>
      <p class="text-gray-500 mt-2">
        Based on
        <a
          class="border-b"
          href="https://github.com/Kvan7/exiled-exchange-2"
          target="_blank"
          >Exiled Exchange 2</a
        >
      </p>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Host } from "@/web/background/IPC";

export default defineComponent({
  name: "settings.about",
  inheritAttrs: false,
  setup() {
    const { t } = useI18n();

    return {
      t,
      version: Host.version,
    };
  },
});
</script>
