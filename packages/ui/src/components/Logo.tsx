import { cn } from '../lib/cn';
import { GithubLogo, Star } from '@phosphor-icons/react';

/**
 * Feather Caret — the Vibe Kanban Indie brand mark.
 *
 * Stacked chevron barbs read as a feather and also as a terminal
 * fast-forward `>>>` caret. Strokes use `currentColor` so the mark
 * inherits whatever accent the surrounding theme provides.
 */
export function FeatherCaret({
  size = 22,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={(size * 100) / 124}
      height={size}
      viewBox="0 0 100 124"
      fill="none"
      aria-hidden="true"
      className={cn('flex-none', className)}
    >
      <g
        stroke="currentColor"
        strokeWidth={8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M50 12 L50 112" />
        <path d="M50 42 L30 25 M50 42 L70 25" />
        <path d="M50 72 L26 51 M50 72 L74 51" />
        <path d="M50 102 L24 80 M50 102 L76 80" />
      </g>
    </svg>
  );
}

/**
 * The VIBE KANBAN wordmark with the ALTERNATIVE tag, on a single line.
 * Sizes are fixed in px (matching the original design lockup) so the
 * wordmark keeps its size even when the app's root font scale changes.
 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span
      data-brand-wordmark
      className={cn(
        'flex items-baseline gap-2.5 font-ibm-plex-mono select-none',
        className
      )}
    >
      <span
        data-brand-word="vibe"
        className="text-xl font-extrabold leading-none tracking-[0.14em] text-high"
      >
        VIBE
      </span>
      <span
        data-brand-word="kanban"
        className="text-xl font-extrabold leading-none tracking-[0.14em] text-brand"
      >
        KANBAN
      </span>
      <span className="self-center rounded-[3px] border border-border px-1.5 py-0.5 text-micro font-semibold leading-none tracking-[0.16em] text-low">
        ALTERNATIVE
      </span>
    </span>
  );
}

/** AuraPunk IDE logo used in the desktop application's top bar. */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <img
      src="/aurapunk-ide-logo.png"
      alt="AuraPunk IDE"
      className={cn(
        'block h-8 w-auto max-w-[220px] object-contain object-left',
        className
      )}
    />
  );
}

/** Small call-to-action displayed beside the application wordmark. */
export function GitHubStarBanner({ className }: { className?: string }) {
  return (
    <a
      href="https://github.com/flashlan/vibe-kanban-alternative"
      target="_blank"
      rel="noreferrer"
      aria-label="Give Vibe Kanban Alternative a star on GitHub"
      className={cn(
        'flex items-center gap-1.5 rounded border border-brand/40 px-2 py-1',
        'font-ibm-plex-mono text-micro font-semibold tracking-[0.08em] text-brand',
        'transition-colors hover:border-brand hover:bg-brand/10 hover:text-high',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
        className
      )}
    >
      <GithubLogo className="size-icon-sm" weight="fill" />
      <span>GIVE US A STAR</span>
      <Star className="size-icon-sm" weight="fill" />
    </a>
  );
}
