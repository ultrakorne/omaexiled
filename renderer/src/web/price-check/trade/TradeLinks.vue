<template>
  <div class="flex gap-px">
    <!-- OmaExiled: no built-in browser; links open in the user's browser -->
    <button @click="open" class="bg-gray-700 text-gray-400 rounded px-2">
      {{ t(text) }} <i class="fas fa-external-link-alt text-xs" />
    </button>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from "vue";
import { useI18n } from "vue-i18n";

export default defineComponent({
  props: {
    getLink: {
      type: Function as PropType<() => string>,
      required: true,
    },
    text: {
      type: String,
      default: "Trade",
    },
  },
  setup(props) {
    const { t } = useI18n();

    return {
      t,
      open() {
        window.open(props.getLink());
      },
    };
  },
});
</script>
