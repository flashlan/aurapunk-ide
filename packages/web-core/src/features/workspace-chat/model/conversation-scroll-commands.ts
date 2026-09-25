/**
 * Conversation Scroll Commands
 *
 * Declarative scroll intent model for the conversation list.
 */

import type { AddEntryType } from '@/shared/hooks/useConversationHistory/types';

// ---------------------------------------------------------------------------
// Near-Bottom Threshold
// ---------------------------------------------------------------------------

/**
 * Pixel distance from bottom within which the user is considered "at bottom".
 * Accounts for sub-pixel rounding, scroll inertia, and minor content growth.
 */
export const NEAR_BOTTOM_THRESHOLD_PX = 64;

// ---------------------------------------------------------------------------
// Scroll Intent
// ---------------------------------------------------------------------------

/**
 * Jump to bottom on first load and invalidate estimated sizes.
 */
export interface InitialBottomIntent {
  readonly type: 'initial-bottom';
  readonly purgeEstimatedSizes: true;
}

/**
 * Follow the bottom while streaming if the user is already there.
 */
export interface FollowBottomIntent {
  readonly type: 'follow-bottom';
  readonly behavior: ScrollBehavior;
}

/**
 * Preserve the current viewport while history changes above it.
 */
export interface PreserveAnchorIntent {
  readonly type: 'preserve-anchor';
}

/** Scroll so the last item's top is visible (plan presentation). */
export interface PlanRevealIntent {
  readonly type: 'plan-reveal';
  readonly align: 'start';
}

/** Explicit user action to return to bottom (scroll-to-bottom button). */
export interface JumpToBottomIntent {
  readonly type: 'jump-to-bottom';
  readonly behavior: ScrollBehavior;
}

/** Scroll to a specific row index (previous-user-message, jump-to-item). */
export interface JumpToIndexIntent {
  readonly type: 'jump-to-index';
  readonly index: number;
  readonly align: 'start' | 'center' | 'end';
  readonly behavior: ScrollBehavior;
}

export type ScrollIntent =
  | InitialBottomIntent
  | FollowBottomIntent
  | PreserveAnchorIntent
  | PlanRevealIntent
  | JumpToBottomIntent
  | JumpToIndexIntent;

// ---------------------------------------------------------------------------
// Scroll State
// ---------------------------------------------------------------------------

/**
 * Single source of truth for conversation scroll behaviour.
 */
export interface ScrollState {
  /** Whether the user is at (or near) the bottom of the list. */
  readonly isAtBottom: boolean;

  /** Intent waiting to be applied after virtualizer measurement. */
  readonly pendingIntent: ScrollIntent | null;

  /** Last successfully applied intent (for deduplication). */
  readonly lastAppliedIntent: ScrollIntent | null;
}

// ---------------------------------------------------------------------------
// State Factory
// ---------------------------------------------------------------------------

export function createInitialScrollState(): ScrollState {
  return {
    isAtBottom: true,
    pendingIntent: null,
    lastAppliedIntent: null,
  };
}

// ---------------------------------------------------------------------------
// Intent Resolution
// ---------------------------------------------------------------------------

/**
 * Map a data update to the scroll intent that should be applied next.
 */
export function resolveScrollIntent(
  addType: AddEntryType,
  isInitialLoad: boolean,
  isAtBottom: boolean
): ScrollIntent {
  if (isInitialLoad) {
    return { type: 'initial-bottom', purgeEstimatedSizes: true };
  }

  // Older history is inserted above the current conversation. Keep the
  // existing viewport/anchor while the virtualizer accounts for that growth;
  // issuing a new follow-bottom command for every history batch fights manual
  // scrolling and is unnecessary while the initial bottom lock is active.
  if (addType === 'historic') {
    return { type: 'preserve-anchor' };
  }

  if (addType === 'plan') {
    return isAtBottom
      ? { type: 'plan-reveal', align: 'start' }
      : { type: 'preserve-anchor' };
  }

  if (addType === 'running') {
    return isAtBottom
      ? { type: 'follow-bottom', behavior: 'auto' }
      : { type: 'preserve-anchor' };
  }

  return isAtBottom
    ? { type: 'follow-bottom', behavior: 'auto' }
    : { type: 'preserve-anchor' };
}

// ---------------------------------------------------------------------------
// Auto-Follow Predicate
// ---------------------------------------------------------------------------

/**
 * Whether a new update should auto-follow the bottom.
 */
export function shouldAutoFollow(
  state: ScrollState,
  addType: AddEntryType
): boolean {
  if (!state.isAtBottom) return false;
  if (addType === 'plan') return false;
  return true;
}

// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------

/** Set a new pending intent, replacing any existing one. */
export function setPendingIntent(
  state: ScrollState,
  intent: ScrollIntent
): ScrollState {
  return { ...state, pendingIntent: intent };
}

/** Mark pending intent as applied and move it to `lastAppliedIntent`. */
export function markIntentApplied(state: ScrollState): ScrollState {
  return {
    ...state,
    lastAppliedIntent: state.pendingIntent,
    pendingIntent: null,
  };
}

/** Update `isAtBottom` from a scroll event. */
export function updateIsAtBottom(
  state: ScrollState,
  isAtBottom: boolean
): ScrollState {
  if (state.isAtBottom === isAtBottom) return state;
  return { ...state, isAtBottom };
}

/** Clear pending intent without marking it as applied (intent went stale). */
export function clearPendingIntent(state: ScrollState): ScrollState {
  if (state.pendingIntent === null) return state;
  return { ...state, pendingIntent: null };
}

// ---------------------------------------------------------------------------
// Near-Bottom Detection
// ---------------------------------------------------------------------------

/**
 * Check whether a scroll container is within `NEAR_BOTTOM_THRESHOLD_PX`
 * of the bottom. Returns true for non-finite inputs (unmounted containers).
 */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number
): boolean {
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(clientHeight) ||
    !Number.isFinite(scrollHeight)
  ) {
    return true;
  }

  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
}

// ---------------------------------------------------------------------------
// Bottom-Lock Release / Follow Resume
// ---------------------------------------------------------------------------

/**
 * Whether a scroll event should release the terminal bottom-lock.
 *
 * Requires a deliberate upward move that leaves the bottom: programmatic
 * writes land exactly on `maxScroll` (correctBottomLock / scrollToBottom) or
 * run while suppressed by `shouldSuppressSizeAdjustment` (anchor corrections,
 * composer-resize compensation), so they never qualify. The time-based guard
 * that used to live here — a `smoothScrollDeadline` re-armed by every
 * streaming follow-bottom — starved release during active streaming:
 * scrollbar and keyboard scrolling could never escape the lock and kept
 * snapping back to the end.
 */
export function shouldReleaseBottomLock(
  bottomLocked: boolean,
  prevScrollTop: number,
  currentScrollTop: number,
  maxScroll: number,
  suppressed: boolean
): boolean {
  if (!bottomLocked || suppressed) return false;
  if (prevScrollTop - currentScrollTop <= 1) return false;
  return currentScrollTop < maxScroll - 1;
}

/**
 * Whether a scroll event should resume live follow after the user paused it.
 *
 * Only an ACTIVE downward scroll back into the near-bottom band re-arms
 * follow. Merely crossing that band while scrolling up must not: the reader
 * starts every upward climb within `NEAR_BOTTOM_THRESHOLD_PX` of the end, so
 * an unpause keyed only on distance let the next streaming emit yank them
 * straight back down.
 */
export function shouldResumeFollow(
  userScrollPaused: boolean,
  prevScrollTop: number,
  currentScrollTop: number,
  clientHeight: number,
  scrollHeight: number
): boolean {
  if (!userScrollPaused) return false;
  if (currentScrollTop - prevScrollTop <= 1) return false;
  return isNearBottom(currentScrollTop, clientHeight, scrollHeight);
}

// ---------------------------------------------------------------------------
// Intent Equality (for deduplication)
// ---------------------------------------------------------------------------

/** Structural equality check for scroll intents. */
export function intentsEqual(
  a: ScrollIntent | null,
  b: ScrollIntent | null
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;

  switch (a.type) {
    case 'initial-bottom':
    case 'preserve-anchor':
    case 'plan-reveal':
      return true;
    case 'follow-bottom':
      return (b as FollowBottomIntent).behavior === a.behavior;
    case 'jump-to-bottom':
      return (b as JumpToBottomIntent).behavior === a.behavior;
    case 'jump-to-index': {
      const bIdx = b as JumpToIndexIntent;
      return (
        bIdx.index === a.index &&
        bIdx.align === a.align &&
        bIdx.behavior === a.behavior
      );
    }
  }
}
