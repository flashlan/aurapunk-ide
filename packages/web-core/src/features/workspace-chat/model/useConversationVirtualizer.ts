/**
 * Conversation Virtualizer Hook
 *
 * Shared TanStack Virtual configuration for the conversation list.
 * Owns the virtualizer instance, measurement, and imperative scroll helpers.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  useVirtualizer,
  measureElement as defaultMeasureElement,
} from '@tanstack/react-virtual';
import type { Virtualizer, VirtualItem } from '@tanstack/react-virtual';

import {
  type ConversationRow,
  SIZE_ESTIMATE_PX,
  estimateSizeForRow,
  findPreviousUserMessageIndex,
} from './conversation-row-model';
import {
  NEAR_BOTTOM_THRESHOLD_PX,
  isNearBottom,
  shouldReleaseBottomLock,
  shouldResumeFollow,
} from './conversation-scroll-commands';

// TanStack Virtual's ScrollBehavior ('auto' | 'smooth' | 'instant') shadows
// the DOM ScrollBehavior. Use a narrow type to avoid TS2322 mismatches.
type ScrollToOptionsBehavior = 'auto' | 'smooth';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of items to render beyond the visible area in each direction. */
const OVERSCAN = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationVirtualizerOptions {
  /** The semantic row model driving the list (virtualized head only). */
  rows: ConversationRow[];

  /**
   * Total number of conversation rows (virtualized + unvirtualized tail).
   * The bottom-lock correction must fire when ANY row is added — including
   * unvirtualized tail rows that don't change `rows.length` or `totalSize`.
   * Without this, streaming entries appended to the tail silently grow the
   * scroll container while the correction never fires.
   */
  totalRowCount: number;

  /** Ref to the scrollable container element. */
  scrollContainerRef: RefObject<HTMLDivElement | null>;

  /**
   * Called when the at-bottom state changes. Shells use this to show/hide
   * the scroll-to-bottom affordance.
   */
  onAtBottomChange?: (atBottom: boolean) => void;

  shouldSuppressSizeAdjustment?: () => boolean;
}

export interface ConversationVirtualizerResult {
  /** The TanStack Virtual virtualizer instance. */
  virtualizer: Virtualizer<HTMLDivElement, Element>;

  /** Virtual items currently in the render window (including overscan). */
  virtualItems: VirtualItem[];

  /** Total pixel size of all items (for the scroll spacer). */
  totalSize: number;

  /**
   * Ref callback for row DOM elements. Attach to each rendered row's
   * container element alongside `data-index={virtualItem.index}`.
   * TanStack Virtual uses this to measure real DOM heights and attach
   * a ResizeObserver for automatic re-measurement on size changes.
   */
  measureElement: (node: Element | null) => void;

  /** Scroll to the absolute bottom of the list. */
  scrollToBottom: (behavior?: ScrollToOptionsBehavior, force?: boolean) => void;

  /** Scroll to a specific row index. */
  scrollToIndex: (
    index: number,
    options?: {
      align?: 'start' | 'center' | 'end';
      behavior?: ScrollToOptionsBehavior;
    }
  ) => void;

  /**
   * Scroll to the previous user message relative to the first visible item.
   * Returns true if a target was found and scrolled to, false otherwise.
   */
  scrollToPreviousUserMessage: () => boolean;

  /**
   * Whether the scroll container is currently near the bottom.
   * Reactive — updates via scroll event listener, not just point-in-time.
   */
  isAtBottom: boolean;

  /** Point-in-time check (non-reactive). Reads DOM directly. */
  checkIsAtBottom: () => boolean;

  /**
   * Release the bottom-lock. Call when navigating away from the
   * bottom (e.g., scrollToPreviousUserMessage).
   */
  releaseBottomLock: () => void;

  /**
   * Look up the ConversationRow index for a given virtual item.
   * Since our virtualizer uses identity mapping (no lane reordering),
   * this is simply `virtualItem.index`.
   */
  rowIndexForVirtualItem: (item: VirtualItem) => number;

  /**
   * Look up the ConversationRow for a given virtual item.
   * Returns undefined if the index is out of bounds.
   */
  rowForVirtualItem: (item: VirtualItem) => ConversationRow | undefined;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Configure and return a TanStack Virtual virtualizer for the conversation list.
 *
 * This hook is the single source of virtualizer configuration. It is consumed
 * by `ConversationListContainer` and must not be duplicated across shells.
 */
export function useConversationVirtualizer({
  rows,
  totalRowCount,
  scrollContainerRef,
  onAtBottomChange,
  shouldSuppressSizeAdjustment,
}: ConversationVirtualizerOptions): ConversationVirtualizerResult {
  const bottomLockedRef = useRef(false);
  const userScrollPausedRef = useRef(false);
  const smoothScrollDeadlineRef = useRef(0);
  const lastScrollBehaviorRef = useRef<ScrollToOptionsBehavior>('auto');

  const isBottomScrollCorrectionActive = useCallback(
    () => bottomLockedRef.current,
    []
  );

  // -------------------------------------------------------------------------
  // Virtualizer instance
  // -------------------------------------------------------------------------

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return SIZE_ESTIMATE_PX.medium;
      const containerWidth = scrollContainerRef.current?.clientWidth ?? null;
      return estimateSizeForRow(row, containerWidth);
    },
    getItemKey: (index) => {
      const row = rows[index];
      return row ? row.semanticKey : index;
    },
    overscan: OVERSCAN,
    measureElement: defaultMeasureElement,
    useAnimationFrameWithResizeObserver: false,
  });

  // -------------------------------------------------------------------------
  // shouldAdjustScrollPositionOnItemSizeChange
  //
  // Preserve the reader's position only when a row fully above the viewport
  // changes size. Mid-list flicker happens when we compensate for rows that
  // are still visible or below the viewport, because those corrections can
  // move the render window and trigger another measurement pass.
  // -------------------------------------------------------------------------

  useEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item,
      _delta,
      instance
    ) => {
      const scrollElement = scrollContainerRef.current;
      const viewportHeight =
        scrollElement?.clientHeight ?? instance.scrollRect?.height ?? 0;
      const scrollOffset =
        scrollElement?.scrollTop ?? instance.scrollOffset ?? 0;
      const totalScrollableSize =
        scrollElement?.scrollHeight ?? instance.getTotalSize();
      const remainingDistance =
        totalScrollableSize - (scrollOffset + viewportHeight);
      const isItemFullyAboveViewport = item.end <= scrollOffset;
      const isBottomLocked = bottomLockedRef.current;
      // Only compensate the item that sits at the top edge of the viewport.
      // Without this band, a single measurement pass can cascade: compensating
      // one resized row above shifts `scrollOffset`, which makes the next
      // resized row above it look "at the edge" too, triggering another
      // compensation in the same batch — the continuous scroll jumps during
      // streaming. Compensating only the boundary row breaks the cascade: the
      // rest measure silently and only move the viewport when the user scrolls.
      // ~1-3 typical rows above the fold.
      const TOP_EDGE_COMPENSATION_BAND_PX = 120;
      const atViewportEdge =
        Math.abs(item.end - scrollOffset) < TOP_EDGE_COMPENSATION_BAND_PX;

      const shouldAdjust =
        !isBottomLocked &&
        !shouldSuppressSizeAdjustment?.() &&
        isItemFullyAboveViewport &&
        atViewportEdge &&
        remainingDistance > NEAR_BOTTOM_THRESHOLD_PX;

      return shouldAdjust;
    };

    return () => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [shouldSuppressSizeAdjustment, virtualizer]);

  // -------------------------------------------------------------------------
  // Reactive isAtBottom state
  // -------------------------------------------------------------------------

  const [isAtBottomState, setIsAtBottomState] = useState(true);
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  onAtBottomChangeRef.current = onAtBottomChange;
  const lastAtBottomRef = useRef(true);

  const syncIsAtBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    const nextValue = isBottomScrollCorrectionActive()
      ? true
      : el
        ? isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
        : true;

    if (nextValue !== lastAtBottomRef.current) {
      lastAtBottomRef.current = nextValue;
      setIsAtBottomState(nextValue);
      onAtBottomChangeRef.current?.(nextValue);
      return;
    }

    setIsAtBottomState((current) =>
      current === nextValue ? current : nextValue
    );
  }, [isBottomScrollCorrectionActive, scrollContainerRef]);

  const prevScrollTopRef = useRef(0);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    prevScrollTopRef.current = el.scrollTop;

    const handleScroll = () => {
      const currentScrollTop = el.scrollTop;
      const prevScrollTop = prevScrollTopRef.current;

      // Release the terminal lock on ANY user scroll that leaves the bottom
      // — wheel capture already does this, but scrollbar drags and keyboard
      // scrolling only pass through here. Pause follow at the same time: a
      // streaming follow-bottom must not yank the reader straight back down
      // (the old time-based guard was re-armed by every emit, so release was
      // starved while streaming and every scroll snapped to the end).
      if (
        shouldReleaseBottomLock(
          bottomLockedRef.current,
          prevScrollTop,
          currentScrollTop,
          el.scrollHeight - el.clientHeight,
          shouldSuppressSizeAdjustment?.() ?? false
        )
      ) {
        bottomLockedRef.current = false;
        userScrollPausedRef.current = true;
      }

      prevScrollTopRef.current = currentScrollTop;

      // Resume live follow only when the user actively scrolls BACK DOWN
      // into the near-bottom band. Merely crossing that band while scrolling
      // up must not re-arm follow — the reader always starts a climb within
      // it, and re-arming there is what produced the snap-to-end loop.
      if (
        shouldResumeFollow(
          userScrollPausedRef.current,
          prevScrollTop,
          currentScrollTop,
          el.clientHeight,
          el.scrollHeight
        )
      ) {
        userScrollPausedRef.current = false;
      }

      syncIsAtBottom();
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      el.removeEventListener('scroll', handleScroll);
    };
  }, [scrollContainerRef, shouldSuppressSizeAdjustment, syncIsAtBottom]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const correctBottomLock = useCallback(() => {
    if (!bottomLockedRef.current) return;
    // Only defer to an in-progress SMOOTH scroll animation (jumping the
    // scrollTop mid-animation would visibly cancel/snap it). An 'auto'
    // (instant) scrollToBottom has no animation to protect.
    if (
      lastScrollBehaviorRef.current === 'smooth' &&
      performance.now() < smoothScrollDeadlineRef.current
    ) {
      return;
    }

    const el = scrollContainerRef.current;
    if (!el) return;

    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll > 0 && Math.abs(maxScroll - el.scrollTop) > 1) {
      el.scrollTop = maxScroll;
    }
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    syncIsAtBottom();
    correctBottomLock();
  }, [
    rows.length,
    totalRowCount,
    totalSize,
    syncIsAtBottom,
    correctBottomLock,
  ]);

  // Short conversations put every row in the unvirtualized tail (see
  // ALWAYS_UNVIRTUALIZED_TAIL_ROWS in ConversationListContainer) — those
  // rows are plain React children, not TanStack-measured, so `totalSize`
  // stays 0 and the effect above never reruns once the DOM actually grows
  // (e.g. markdown/code rendering finishing a beat after the commit that
  // set bottomLockedRef). A MutationObserver catches that growth directly
  // from the DOM regardless of which render caused it.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const observer = new MutationObserver(() => {
      correctBottomLock();
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [scrollContainerRef, correctBottomLock]);

  // -------------------------------------------------------------------------
  // Imperative helpers
  // -------------------------------------------------------------------------

  const scrollToBottom = useCallback(
    (behavior: ScrollToOptionsBehavior = 'smooth', force = false) => {
      const el = scrollContainerRef.current;
      if (!el) return;
      if (userScrollPausedRef.current && !force) return;

      userScrollPausedRef.current = false;
      bottomLockedRef.current = true;
      lastScrollBehaviorRef.current = behavior;

      // Guard the follow-bottom scroll from being misread as a
      // user-initiated upward scroll in the scroll handler, which would
      // falsely release the bottom lock and leave the stream "stuck"
      // mid-list. The deadline is set for BOTH behaviors — streaming uses
      // 'auto', so it previously had no guard at all. (The size-driven
      // correction effect above only honors this deadline for 'smooth', to
      // avoid canceling an in-progress animation — an 'auto' jump has no
      // animation to protect and must be free to correct immediately once
      // rows finish measuring.)
      smoothScrollDeadlineRef.current = performance.now() + 500;

      if (behavior === 'smooth') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      } else {
        el.scrollTop = el.scrollHeight - el.clientHeight;
      }
    },
    [scrollContainerRef, virtualizer]
  );

  const scrollToIndex = useCallback(
    (
      index: number,
      options?: {
        align?: 'start' | 'center' | 'end';
        behavior?: ScrollToOptionsBehavior;
      }
    ) => {
      userScrollPausedRef.current = true;
      bottomLockedRef.current = false;

      virtualizer.scrollToIndex(index, {
        align: options?.align ?? 'start',
        behavior: options?.behavior ?? 'smooth',
      });
    },
    [virtualizer]
  );

  const scrollToPreviousUserMessage = useCallback((): boolean => {
    const scrollEl = scrollContainerRef.current;
    const items = virtualizer.getVirtualItems();
    if (items.length === 0 || rows.length === 0 || !scrollEl) return false;

    const firstVisibleIndex =
      virtualizer.getVirtualItemForOffset(scrollEl.scrollTop)?.index ??
      items[0].index;
    const targetIndex = findPreviousUserMessageIndex(rows, firstVisibleIndex);

    if (targetIndex < 0) return false;

    virtualizer.scrollToIndex(targetIndex, {
      align: 'start',
      behavior: 'smooth',
    });
    return true;
  }, [scrollContainerRef, virtualizer, rows]);

  const checkIsAtBottom = useCallback((): boolean => {
    const el = scrollContainerRef.current;
    if (!el) return !userScrollPausedRef.current;
    const atBottom = isNearBottom(
      el.scrollTop,
      el.clientHeight,
      el.scrollHeight
    );
    return atBottom && !userScrollPausedRef.current;
  }, [scrollContainerRef]);

  const releaseBottomLock = useCallback(() => {
    userScrollPausedRef.current = true;
    bottomLockedRef.current = false;
  }, []);

  // -------------------------------------------------------------------------
  // Row ↔ VirtualItem mapping
  // -------------------------------------------------------------------------

  const rowIndexForVirtualItem = useCallback(
    (item: VirtualItem): number => item.index,
    []
  );

  const rowForVirtualItem = useCallback(
    (item: VirtualItem): ConversationRow | undefined => rows[item.index],
    [rows]
  );

  const measureElement = useCallback(
    (node: Element | null) => {
      virtualizer.measureElement(node);
    },
    [virtualizer]
  );

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    virtualizer,
    virtualItems,
    totalSize,
    measureElement,
    scrollToBottom,
    scrollToIndex,
    scrollToPreviousUserMessage,
    isAtBottom: isAtBottomState,
    checkIsAtBottom,
    releaseBottomLock,
    rowIndexForVirtualItem,
    rowForVirtualItem,
  };
}
