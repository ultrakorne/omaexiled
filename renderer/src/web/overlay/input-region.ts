import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { hideAll } from "tippy.js";
import type { InputRect } from "@ipc/types";
import { Host } from "@/web/background/IPC";

// OmaExiled: the overlay layer surface covers the whole game window but only
// takes pointer input inside its input region; the rest goes to the game.
// This reports that region as `OVERLAY->MAIN::input-region`: the boxes of the
// visible interactive UI in surface CSS px, and `full` while the overlay is
// active (then the whole surface takes input, like EE2's focused overlay).
//
// Interactive UI:
// - every visible widget. A widget whose root has `pointer-events: none`
//   (the price check spans the whole surface) contributes its outermost
//   `.pointer-events-auto` parts: price column, related items, rate-limit
//   tab. Other widgets contribute their boxes, including absolutely
//   positioned parts outside them (the widget action panel).
// - open interactive tippy poppers (popovers, item editor), which may
//   overflow their widget.
//
// Recomputed on the next frame after DOM, size, animation or `active`
// changes; sent only when it differs from the last send.
//
// An interactive tippy hides only on a mousemove outside it, which the page
// no longer gets once the pointer is over the game (outside the region), so
// while inactive the poppers are hidden when the pointer has left the
// surface. The delay lets the pointer cross a gap between a reference and
// its popper that lies outside the region.
export function useInputRegion(
  root: Ref<HTMLElement | null>,
  active: Ref<boolean>,
) {
  let lastSent: string | null = null;
  let scheduled = false;
  let frame = 0;
  let timer = 0;
  let observed = new Set<Element>();

  const resizeObserver = new ResizeObserver(schedule);
  const mutationObserver = new MutationObserver(schedule);

  let leaveTimer = 0;
  function onMouseOut(e: MouseEvent) {
    // no relatedTarget: the pointer left the page
    if (e.relatedTarget != null || active.value) return;
    clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      if (!active.value) hideAll({ duration: 0 });
    }, 300);
  }
  function onMouseOver() {
    clearTimeout(leaveTimer);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    frame = requestAnimationFrame(run);
    // rAF does not run while the page is hidden (surface unmapped)
    timer = window.setTimeout(run, 100);
  }

  function run() {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    if (!scheduled) return;
    scheduled = false;
    flush(false);
  }

  function flush(force: boolean) {
    const elements = new Set<Element>();
    const rects = collect(elements);
    observe(elements);

    const payload = { rects, full: active.value };
    const key = JSON.stringify(payload);
    if (!force && key === lastSent) return;
    Host.sendEvent({ name: "OVERLAY->MAIN::input-region", payload });
    lastSent = key;
  }

  function collect(elements: Set<Element>): InputRect[] {
    const rects: InputRect[] = [];
    if (!root.value) return rects;

    for (const widget of root.value.querySelectorAll(
      ":scope > [id^='widget-']",
    )) {
      elements.add(widget);
      const style = getComputedStyle(widget);
      if (style.display === "none") continue;
      if (style.pointerEvents === "none") {
        for (const part of widget.querySelectorAll(".pointer-events-auto")) {
          if (part.parentElement?.closest(".pointer-events-auto")) continue;
          addBox(part, rects, elements);
        }
      } else {
        addBox(widget, rects, elements);
      }
    }

    for (const popper of document.querySelectorAll("[data-tippy-root]")) {
      // non-interactive tooltips and hiding poppers have pointer-events: none
      addBox(popper, rects, elements, false);
    }

    return withoutContained(rects);
  }

  function addBox(
    el: Element,
    rects: InputRect[],
    elements: Set<Element>,
    descend = true,
  ) {
    elements.add(el);
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.pointerEvents === "none"
    ) {
      return;
    }

    const rect = toInputRect(el.getBoundingClientRect());
    if (rect) rects.push(rect);
    if (!descend) return;

    for (const child of el.children) {
      // an empty box (e.g. a wrapper of absolutely positioned content) has
      // its interactive parts in its children
      if (!rect || isOutOfFlow(child)) {
        addBox(child, rects, elements);
      }
    }
  }

  function observe(elements: Set<Element>) {
    for (const el of observed) {
      if (!elements.has(el)) resizeObserver.unobserve(el);
    }
    for (const el of elements) {
      // observing reports the current size once, so only observe new ones
      if (!observed.has(el)) resizeObserver.observe(el);
    }
    observed = elements;
  }

  // a restarted backend has not seen the region yet
  const stopReconnect = Host.onReconnect(() => flush(true));

  onMounted(() => {
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("mouseover", onMouseOver);
    schedule();
  });

  onBeforeUnmount(() => {
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener("animationend", schedule, true);
    document.removeEventListener("transitionend", schedule, true);
    document.removeEventListener("mouseout", onMouseOut);
    document.removeEventListener("mouseover", onMouseOver);
    stopReconnect();
    scheduled = false;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    clearTimeout(leaveTimer);
  });

  watch(active, schedule);
}

function isOutOfFlow(el: Element) {
  const { position } = getComputedStyle(el);
  return position === "absolute" || position === "fixed";
}

// Whole CSS px covering the box, clipped to the surface.
function toInputRect(r: DOMRect): InputRect | null {
  const x = Math.max(0, Math.floor(r.left));
  const y = Math.max(0, Math.floor(r.top));
  const right = Math.min(window.innerWidth, Math.ceil(r.right));
  const bottom = Math.min(window.innerHeight, Math.ceil(r.bottom));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function withoutContained(rects: InputRect[]): InputRect[] {
  const contains = (a: InputRect, b: InputRect) =>
    a.x <= b.x &&
    a.y <= b.y &&
    a.x + a.width >= b.x + b.width &&
    a.y + a.height >= b.y + b.height;

  return rects.filter(
    (rect, i) =>
      !rects.some(
        (other, j) =>
          j !== i &&
          contains(other, rect) &&
          // of two equal boxes keep the first
          (!contains(rect, other) || j < i),
      ),
  );
}
