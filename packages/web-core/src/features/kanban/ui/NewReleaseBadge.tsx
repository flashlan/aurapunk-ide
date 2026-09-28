import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowCircleUpIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/Dialog';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { getResolvedTheme, useTheme } from '@/shared/hooks/useTheme';
import { cn } from '@/shared/lib/utils';
import {
  fetchReleaseStatus,
  RELEASE_CHECK_INTERVAL_MS,
  type ReleaseStatus,
} from '../model/releaseCheck';

/**
 * Surfaces a badge beside Agent Activity when the running build is older than
 * the latest stable GitHub release, and opens a modal with the new version's
 * notes. Polls GitHub hourly while the app is open.
 */
export function NewReleaseBadge() {
  const [open, setOpen] = useState(false);
  const { theme } = useTheme();
  const { data, isLoading, isError } = useQuery<ReleaseStatus>({
    queryKey: ['latest-release'],
    queryFn: fetchReleaseStatus,
    refetchInterval: RELEASE_CHECK_INTERVAL_MS,
    refetchOnWindowFocus: false,
    staleTime: RELEASE_CHECK_INTERVAL_MS,
    retry: 1,
  });

  if (isLoading || isError || !data?.hasUpdate) return null;

  const { latest, currentVersion } = data;
  const resolvedTheme = getResolvedTheme(theme);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // One compact line beside Agent Activity: it must not add a row to
        // the board header.
        className={cn(
          'flex shrink-0 items-center gap-quarter whitespace-nowrap rounded-sm border px-half py-quarter text-xs transition-colors',
          'border-warning/40 bg-warning/5 text-normal hover:border-warning/70'
        )}
        aria-label={`New release v${latest.version} available`}
        title={`AuraPunk ADE v${latest.version} is available — click for the release notes`}
      >
        <ArrowCircleUpIcon
          className="size-icon-xs shrink-0 text-warning"
          weight="fill"
        />
        <span className="font-medium">v{latest.version}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-half">
              <ArrowCircleUpIcon
                className="size-icon-sm shrink-0 text-warning"
                weight="fill"
              />
              New release available
            </DialogTitle>
            <DialogDescription>
              {`AuraPunk ADE v${latest.version} is available. You are running v${currentVersion}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto rounded-sm border border-border bg-panel p-base">
            {latest.notes ? (
              <MarkdownPreview
                content={latest.notes}
                theme={resolvedTheme}
                className="text-sm"
              />
            ) : (
              <p className="text-sm text-low">
                No release notes were published for this version.
              </p>
            )}
          </div>
          <DialogFooter>
            {latest.url && (
              <Button variant="secondary" size="sm" asChild>
                <a href={latest.url} target="_blank" rel="noreferrer">
                  View on GitHub
                  <ArrowSquareOutIcon className="ml-1 size-icon-xs" />
                </a>
              </Button>
            )}
            <Button size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
