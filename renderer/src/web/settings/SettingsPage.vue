<template>
  <div id="settings-window" class="overflow-hidden relative w-full h-full">
    <SettingsWindow :config="config" standalone />
  </div>
</template>

<script setup lang="ts">
// OmaExiled: the page of the settings window (?mode=settings). Only the
// settings UI, filling the window; no widgets, so no price checks here.
import { computed } from "vue";
import { AppConfig } from "@/web/Config";
import type { Widget } from "@/web/overlay/interfaces";
import { usePoeninja } from "@/web/background/Prices";
import { useLeagues } from "@/web/background/Leagues";
import SettingsWindow from "./SettingsWindow.vue";

// the price check settings list the leagues and core currencies
usePoeninja();
useLeagues().load();

document.title = "OmaExiled Settings";

const config = computed(() => AppConfig<Widget>("settings")!);
</script>
