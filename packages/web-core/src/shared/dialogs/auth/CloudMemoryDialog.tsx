import { create, useModal } from '@ebay/nice-modal-react';
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

export type CloudMemoryChoice = 'cloud' | 'self-hosted';

export interface CloudMemoryDialogProps {
  plan: string;
  memories: number;
  writesPerMonth: number;
  searchesPerMonth: number;
}

const CloudMemoryDialogImpl = create<CloudMemoryDialogProps>((props) => {
  const modal = useModal();
  const finish = (choice: CloudMemoryChoice) => {
    modal.resolve(choice);
    modal.hide();
  };

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => !open && finish('self-hosted')}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Choose your project memory</DialogTitle>
          <DialogDescription className="space-y-3 text-left">
            <span className="block">
              Your AuraPunk account includes hosted project memory. Nothing is
              connected until you confirm this choice.
            </span>
            <span className="block rounded-sm border border-border bg-panel p-3 text-normal">
              <strong className="block text-high">{props.plan} plan</strong>
              {props.memories.toLocaleString()} stored memories ·{' '}
              {props.writesPerMonth.toLocaleString()} writes/month ·{' '}
              {props.searchesPerMonth.toLocaleString()} searches/month
            </span>
            <span className="block">
              You can instead keep Mem0 disabled or configure your own Docker
              endpoint later in Settings → Memory.
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => finish('self-hosted')}>
            Use my own Mem0
          </Button>
          <Button onClick={() => finish('cloud')}>Connect Cloud Mem0</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const CloudMemoryDialog = defineModal<
  CloudMemoryDialogProps,
  CloudMemoryChoice
>(CloudMemoryDialogImpl);
