import { create, useModal } from '@ebay/nice-modal-react';
import { SignInIcon, UserPlusIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@vibe/ui/components/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { defineModal, type NoProps } from '@/shared/lib/modals';

export type CloudAuthChoice = 'login' | 'signup';

/**
 * Single sign-in entry point. Login and sign-up share one modal with direct
 * links into the hosted account flow, so the sidebar only exposes one button.
 */
const CloudAuthDialogImpl = create<NoProps>(() => {
  const { t } = useTranslation('common');
  const modal = useModal();

  const finish = (choice: CloudAuthChoice | null) => {
    modal.resolve(choice);
    modal.hide();
  };

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => !open && finish(null)}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('cloudAuth.title')}</DialogTitle>
          <DialogDescription className="text-left">
            {t('cloudAuth.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => finish('signup')}>
            <UserPlusIcon className="mr-2 size-icon-xs" weight="bold" />
            {t('cloudAuth.createAccount')}
          </Button>
          <Button onClick={() => finish('login')}>
            <SignInIcon className="mr-2 size-icon-xs" weight="bold" />
            {t('cloudAuth.logIn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const CloudAuthDialog = defineModal<NoProps, CloudAuthChoice | null>(
  CloudAuthDialogImpl
);
