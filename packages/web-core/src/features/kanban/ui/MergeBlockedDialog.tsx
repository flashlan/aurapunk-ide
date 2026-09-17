import { create, useModal } from '@ebay/nice-modal-react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { defineModal } from '@/shared/lib/modals';

export type MergeBlockedAction =
  | 'stash-retry'
  | 'delegate'
  | 'move-without-merge'
  | 'cancel';

export interface DirtyWorktreeBlock {
  branch: string;
  modified: string[];
  untracked: string[];
  message: string;
}

/**
 * Narrow an API error payload to the Integration Guard dirty-worktree
 * refusal. The Rust enum serializes internally tagged
 * (`#[serde(tag = "type", rename_all = "snake_case")]`), so a successful
 * match looks like `{ type: "dirty_worktree", branch, modified, ... }`.
 * Anything else returns null and the caller keeps the legacy dialog.
 */
export function getDirtyWorktreeBlock(
  error: unknown
): DirtyWorktreeBlock | null {
  const data =
    typeof error === 'object' && error !== null
      ? (error as { error_data?: unknown }).error_data
      : undefined;
  if (typeof data !== 'object' || data === null) return null;
  // The Rust enum serializes internally tagged
  // (`#[serde(tag = "type", rename_all = "snake_case")]`), so a match looks
  // like `{ type: "dirty_worktree", branch, modified, untracked, ... }`.
  const record = data as Record<string, unknown>;
  if (record.type !== 'dirty_worktree') return null;
  const { branch, modified, untracked, message } = record;
  if (typeof branch !== 'string' || !Array.isArray(modified)) return null;
  return {
    branch,
    modified: modified.filter(
      (file): file is string => typeof file === 'string'
    ),
    untracked: Array.isArray(untracked)
      ? untracked.filter((file): file is string => typeof file === 'string')
      : [],
    message: typeof message === 'string' ? message : 'Working tree is dirty.',
  };
}

export interface MergeBlockedDialogProps {
  branch: string;
  modified: string[];
  untracked: string[];
  message: string;
}

const MAX_LISTED_FILES = 12;

function FileList({ title, files }: { title: string; files: string[] }) {
  if (files.length === 0) return null;
  const listed = files.slice(0, MAX_LISTED_FILES);
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-normal">
        {title} ({files.length})
      </p>
      <ul className="mt-1 max-h-28 list-none overflow-y-auto rounded-sm bg-sunken p-2 text-xs text-low">
        {listed.map((file) => (
          <li key={file} className="truncate font-mono">
            {file}
          </li>
        ))}
        {files.length > listed.length && (
          <li className="text-low">+{files.length - listed.length} more</li>
        )}
      </ul>
    </div>
  );
}

const MergeBlockedDialogImpl = create<MergeBlockedDialogProps>((props) => {
  const modal = useModal();
  const { branch, modified, untracked, message } = props;

  const resolve = (action: MergeBlockedAction) => () => {
    modal.resolve(action);
    modal.hide();
  };

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => {
        if (!open) resolve('cancel')();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-warning" />
            Merge blocked — dirty {branch}
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <FileList title="Uncommitted tracked files" files={modified} />
        <FileList
          title="Untracked files (informational, never block)"
          files={untracked}
        />
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button className="w-full" onClick={resolve('stash-retry')}>
            Stash changes &amp; retry merge
          </Button>
          <Button
            className="w-full"
            variant="secondary"
            onClick={resolve('delegate')}
          >
            Delegate cleanup to agent
          </Button>
          <div className="flex w-full gap-2">
            <Button
              className="flex-1"
              variant="outline"
              onClick={resolve('move-without-merge')}
            >
              Move without merging
            </Button>
            <Button
              className="flex-1"
              variant="ghost"
              onClick={resolve('cancel')}
            >
              Cancel
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const MergeBlockedDialog = defineModal<
  MergeBlockedDialogProps,
  MergeBlockedAction
>(MergeBlockedDialogImpl);
