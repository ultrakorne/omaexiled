<template>
  <div
    style="top: 0; left: 0; height: 100%; width: 100%; position: absolute"
    class="flex grow h-full pointer-events-none"
    :class="{
      'flex-row': clickPosition === 'stash',
      'flex-row-reverse': clickPosition === 'inventory',
    }"
  >
    <div class="layout-column shrink-0" style="width: var(--game-panel)"></div>
    <div
      id="price-window"
      class="layout-column shrink-0 text-gray-200 pointer-events-auto"
      style="width: 28.75rem"
    >
      <AppTitleBar
        @close="closePriceCheck"
        @click="openLeagueSelection"
        :title="title"
      >
        <ui-popover
          v-if="stableOrbCost && xchgRateCurrency?.id"
          trigger="click"
          boundary="#price-window"
        >
          <template #target>
            <button>
              <i class="fas fa-exchange-alt" /> {{ stableOrbCost }}
            </button>
          </template>
          <template #content>
            <item-quick-price
              class="text-base"
              :price="{
                min: stableOrbCost,
                max: stableOrbCost,
                currency: xchgRateCurrency.id,
              }"
              item-img="/images/divine.png"
            />
            <div v-for="i in 9" :key="i">
              <div class="pl-1">
                {{ i / 10 }} div ⇒ {{ Math.round((stableOrbCost * i) / 10) }}
                {{ xchgRateCurrency.abbrev }}
              </div>
            </div>
          </template>
        </ui-popover>
        <i v-else-if="xchgRateLoading()" class="fas fa-dna fa-spin px-2" />
        <div v-else class="w-8" />
      </AppTitleBar>
      <div class="grow layout-column min-h-0 bg-gray-800">
        <background-info />
        <check-position-circle
          v-if="showCheckPos"
          :position="checkPosition"
          style="z-index: -1"
        />
        <template v-if="item?.isErr()">
          <ui-error-box class="m-4">
            <template #name>{{ t(item.error.name) }}</template>
            <template #actions
              ><reload-trade-data
                :item-text="item.error.rawText"
                :pos="checkPosition"
            /></template>
            <p>
              {{
                item.error.format
                  ? t(item.error.message, item.error.format)
                  : t(item.error.message)
              }}
            </p>
          </ui-error-box>
          <pre class="bg-gray-900 rounded m-4 overflow-x-hidden p-2">{{
            item.error.rawText
          }}</pre>
        </template>
        <template v-else-if="item?.isOk()">
          <unidentified-resolver
            :item="item.value"
            @identify="handleIdentification($event)"
          />
          <checked-item
            v-if="isLeagueSelected"
            :item="item.value"
            :advanced-check="advancedCheck"
          />
        </template>
      </div>
    </div>
    <div class="layout-column flex-1 min-w-0">
      <div
        class="flex"
        :class="{
          'flex-row': clickPosition === 'stash',
          'flex-row-reverse': clickPosition === 'inventory',
        }"
      >
        <related-items
          v-if="item?.isOk()"
          class="pointer-events-auto"
          :item="item.value"
          :click-position="clickPosition"
        />
        <rate-limiter-state class="pointer-events-auto" />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import {
  defineComponent,
  inject,
  PropType,
  shallowRef,
  watch,
  computed,
  nextTick,
  provide,
  ref,
} from "vue";
import { Result, ok, err } from "neverthrow";
import { useI18n } from "vue-i18n";
import UiErrorBox from "@/web/ui/UiErrorBox.vue";
import UiPopover from "@/web/ui/Popover.vue";
import CheckedItem from "./CheckedItem.vue";
import BackgroundInfo from "./BackgroundInfo.vue";
import { MainProcess, Host } from "@/web/background/IPC";
import { usePoeninja } from "../background/Prices";
import { useLeagues } from "@/web/background/Leagues";
import { AppConfig } from "@/web/Config";
import { ItemCategory, ItemRarity, parseClipboard, ParsedItem } from "@/parser";
import RelatedItems from "./related-items/RelatedItems.vue";
import RateLimiterState from "./trade/RateLimiterState.vue";
import UnidentifiedResolver from "./unidentified-resolver/UnidentifiedResolver.vue";
import CheckPositionCircle from "./CheckPositionCircle.vue";
import AppTitleBar from "@/web/ui/AppTitlebar.vue";
import ItemQuickPrice from "@/web/ui/ItemQuickPrice.vue";
import {
  PriceCheckWidget,
  WidgetManager,
  WidgetSpec,
} from "../overlay/interfaces";
import { loadUltraLateItems } from "@/assets/data";
import ReloadTradeData from "./fallback/ReloadTradeData.vue";

type ParseError = {
  name: string;
  message: string;
  rawText: ParsedItem["rawText"];
  format?: string[];
};

export default defineComponent({
  widget: {
    type: "price-check",
    instances: "single",
    initInstance: (): PriceCheckWidget => {
      return {
        wmId: 0,
        wmType: "price-check",
        wmTitle: "",
        wmWants: "hide",
        wmZorder: "exclusive",
        wmFlags: ["hide-on-blur", "menu::skip"],
        showRateLimitState: false,
        apiLatencySeconds: 2,
        collapseListings: "api",
        smartInitialSearch: true,
        lockedInitialSearch: true,
        searchOnHover: false,
        activateStockFilter: false,
        builtinBrowser: false,
        hotkey: "D",
        hotkeyHold: "Ctrl",
        hotkeyLocked: "Ctrl + Alt + D",
        showSeller: false,
        searchStatRange: 10,
        showCursor: true,
        rememberCurrency: false,
        // New Settings EE2
        defaultAllSelected: false,
        itemHoverTooltip: "keybind",
        alwaysShowTier: false,
        coreCurrency: "exalted",
        currencyVolume: "both",
        rememberListingType: false,
        initialDelay: 48,
        savedAugments: {},
      };
    },
  } satisfies WidgetSpec,
  components: {
    AppTitleBar,
    CheckedItem,
    UnidentifiedResolver,
    BackgroundInfo,
    RelatedItems,
    RateLimiterState,
    CheckPositionCircle,
    ItemQuickPrice,
    UiErrorBox,
    UiPopover,
    ReloadTradeData,
  },
  props: {
    config: {
      type: Object as PropType<PriceCheckWidget>,
      required: true,
    },
  },
  setup(props) {
    const leagueId = computed(() => AppConfig().leagueId);

    watch(
      () => leagueId.value,
      () => {
        // still need this for when leagueId changes
        loadUltraLateItems();
      },
      { immediate: true },
    );

    const wm = inject<WidgetManager>("wm")!;
    const {
      xchgRate,
      xchgRateCurrency,
      initialLoading: xchgRateLoading,
      queuePricesFetch,
    } = usePoeninja();

    nextTick(() => {
      props.config.wmWants = "hide";
      props.config.wmFlags = ["hide-on-blur", "menu::skip"];
    });

    const item = ref<null | Result<ParsedItem, ParseError>>(null);
    const advancedCheck = shallowRef(false);
    const checkPosition = shallowRef({ x: 1, y: 1 });

    // OmaExiled: the hidden overlay page can still have the size of its
    // previous mapping when item-text arrives (the surface is resized to the
    // game window only when it is shown), so the panel side and the tracked
    // area use the reactive surface size, and the area is sent again when
    // that size changes while a hold-mode check is shown.
    let trackFrom: { x: number; y: number } | null = null;

    function sendTrackArea(from: { x: number; y: number }) {
      // everything in CSS pixels
      // OmaExiled: overlay surface coordinates (Host.screenX/Y are 0)
      const { width: innerWidth, height: innerHeight } = wm.size.value;
      const width = 28.75 * AppConfig().fontSize;
      const screenX =
        from.x - Host.screenX > innerWidth / 2
          ? Host.screenX + innerWidth - wm.poePanelWidth.value - width
          : Host.screenX + wm.poePanelWidth.value;
      MainProcess.sendEvent({
        name: "OVERLAY->MAIN::track-area",
        payload: {
          holdKey: props.config.hotkeyHold,
          closeThreshold: 2.5 * AppConfig().fontSize,
          from,
          area: {
            x: screenX,
            y: Host.screenY,
            width,
            height: innerHeight,
          },
          dpr: window.devicePixelRatio,
        },
      });
    }

    watch(wm.size, () => {
      if (trackFrom && props.config.wmWants === "show") {
        sendTrackArea(trackFrom);
      }
    });
    watch(
      () => props.config.wmWants,
      (wmWants) => {
        if (wmWants !== "show") trackFrom = null;
      },
    );

    MainProcess.onEvent("MAIN->CLIENT::item-text", (e) => {
      if (e.target !== "price-check") return;
      performance.mark("price-check-event");

      trackFrom = null;
      if (Host.isOverlay && !e.focusOverlay) {
        trackFrom = e.position;
        sendTrackArea(e.position);
      }
      wm.show(props.config.wmId);
      checkPosition.value = e.position;
      advancedCheck.value = e.focusOverlay;
      performance.mark("price-check-start-handling-item");
      item.value = handleItemPaste({
        clipboard: e.clipboard,
        item: e.item as ParsedItem,
      });

      if (item.value.isOk()) {
        queuePricesFetch();
      }
      performance.mark("price-check-event-end");
    });

    function handleItemPaste(e: { clipboard: string; item: ParsedItem }) {
      const newItem = (e.item ? ok(e.item) : parseClipboard(e.clipboard))
        .andThen((item) =>
          (item.category === ItemCategory.HeistContract &&
            item.rarity !== ItemRarity.Unique) ||
          (item.category === ItemCategory.Sentinel &&
            item.rarity !== ItemRarity.Unique)
            ? err("item.unknown")
            : ok(item),
        )
        .mapErr((err) => {
          if (err.startsWith("item.wrong_language")) {
            const [errName, gameLang, eeLang] = err.split("|");
            return {
              name: `${errName}`,
              message: `${errName}_help`,
              rawText: e.clipboard,
              format: [gameLang, eeLang],
            };
          }

          return {
            name: `${err}`,
            message: `${err}_help`,
            rawText: e.clipboard,
          };
        });
      performance.mark("price-check-parse-end");
      return newItem;
    }

    function handleIdentification(identified: ParsedItem) {
      item.value = ok(identified);
    }

    MainProcess.onEvent("MAIN->OVERLAY::hide-exclusive-widget", () => {
      wm.hide(props.config.wmId);
    });

    const leagues = useLeagues();
    const title = computed(() => leagues.selectedId.value || "OmaExiled");
    const stableOrbCost = computed(() =>
      xchgRate.value ? Math.round(xchgRate.value) : null,
    );
    const showCheckPos = computed(
      () => wm.active.value && props.config.showCursor,
    );
    const isLeagueSelected = computed(() => Boolean(leagues.selectedId.value));
    const clickPosition = computed(() => {
      // OmaExiled: reactive surface size, see sendTrackArea
      return checkPosition.value.x > Host.screenX + wm.size.value.width / 2
        ? "inventory"
        : "stash";
      // or {chat, vendor, center of screen}
    });

    function closePriceCheck() {
      if (Host.isOverlay && !wm.active.value) {
        // OmaExiled: the panel takes clicks while the overlay is inactive
        // (quick check), when focus-game would not hide it
        wm.hide(props.config.wmId);
      } else if (AppConfig().overlayAlwaysClose) {
        Host.sendEvent({
          name: "OVERLAY->MAIN::focus-game",
          payload: undefined,
        });
      } else if (!Host.isOverlay) {
        wm.hide(props.config.wmId);
      } else {
        Host.sendEvent({
          name: "OVERLAY->MAIN::focus-game",
          payload: undefined,
        });
      }
    }

    function openLeagueSelection() {
      if (Host.isOverlay && !wm.active.value) {
        // OmaExiled: the panel takes clicks while the overlay is inactive
        // (quick check), where the settings widget would stay invisible;
        // open the settings window instead
        Host.sendEvent({ name: "CLIENT->MAIN::open-settings", payload: {} });
        return;
      }
      const settings = wm.widgets.value.find((w) => w.wmType === "settings")!;
      wm.setFlag(settings.wmId, `settings::widget=${props.config.wmId}`, true);
      wm.show(settings.wmId);
    }

    // OmaExiled: EE2's <webview> is replaced by the host's in-app browser
    // window, which shares its cookies (captcha, login) with the proxy.
    function showBrowser(url: string) {
      Host.sendEvent({ name: "CLIENT->MAIN::open-browser", payload: { url } });
    }

    provide<(url: string) => void>("builtin-browser", showBrowser);

    const { t } = useI18n();

    return {
      t,
      clickPosition,
      closePriceCheck,
      title,
      stableOrbCost,
      xchgRateCurrency,
      xchgRateLoading,
      showCheckPos,
      checkPosition,
      item,
      advancedCheck,
      handleIdentification,
      isLeagueSelected,
      openLeagueSelection,
    };
  },
});
</script>
