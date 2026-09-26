import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import type { IntegrationError, IntegrationService } from 'shared/types';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@vibe/ui/components/Popover';

const SERVICE_LABEL: Record<IntegrationService, string> = {
  mem0: 'Mem0',
  laya: 'Laya',
  jev: 'Jev',
};

/** How many balloon rows to render; the rest are summarized. */
const VISIBLE = 4;

function formatTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface IntegrationErrorBalloonProps {
  /** Shown in the balloon header, e.g. "Mem0" or "RLCD (Laya · Jev)". */
  title: string;
  errors: IntegrationError[];
  onDismiss: () => void;
  /** The status indicator the balloon is anchored to. */
  children: ReactNode;
}

/**
 * Error balloon for a sidebar status indicator. A health dot only says whether
 * a service answers a probe; this surfaces what actually failed (a memory
 * write that was not queued, a classifier call that errored). It opens by
 * itself when a new error arrives and keeps a count badge on the icon until
 * the operator dismisses the errors.
 */
export function IntegrationErrorBalloon({
  title,
  errors,
  onDismiss,
  children,
}: IntegrationErrorBalloonProps) {
  const [open, setOpen] = useState(false);
  const lastAnnouncedSeq = useRef(0);
  const newest = errors[errors.length - 1]?.seq ?? 0;

  useEffect(() => {
    if (newest > lastAnnouncedSeq.current) {
      lastAnnouncedSeq.current = newest;
      setOpen(true);
    }
  }, [newest]);

  const count = errors.length;
  const visible = errors.slice(-VISIBLE).reverse();

  return (
    <Popover open={open && count > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span className="relative inline-flex">
          {children}
          {count > 0 && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label={`${title}: ${count} error${count === 1 ? '' : 's'}`}
              className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#ef4444] px-0.5 text-[9px] font-semibold leading-none text-white"
            >
              {count > 9 ? '9+' : count}
            </button>
          )}
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-80"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-half pb-half">
          <WarningCircleIcon
            className="size-icon-sm shrink-0 text-[#ef4444]"
            weight="fill"
          />
          <span className="flex-1 text-base font-medium text-high">
            {title}: {count} error{count === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="text-low hover:text-normal"
          >
            <XIcon className="size-icon-xs" weight="bold" />
          </button>
        </div>
        <ul className="flex flex-col gap-half">
          {visible.map((error) => (
            <li
              key={error.seq}
              className="rounded-sm bg-secondary px-half py-half"
            >
              <div className="flex items-center justify-between gap-half text-sm text-low">
                <span>
                  {SERVICE_LABEL[error.service]} · {error.operation}
                </span>
                <span>{formatTime(error.at)}</span>
              </div>
              <p className="break-words text-sm text-normal">{error.message}</p>
            </li>
          ))}
        </ul>
        {count > VISIBLE && (
          <p className="pt-half text-sm text-low">+{count - VISIBLE} older</p>
        )}
        <div className="flex justify-end pt-half">
          <button
            type="button"
            onClick={() => {
              onDismiss();
              setOpen(false);
            }}
            className="rounded-sm px-half py-0.5 text-sm text-normal hover:bg-secondary"
          >
            Dismiss
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
