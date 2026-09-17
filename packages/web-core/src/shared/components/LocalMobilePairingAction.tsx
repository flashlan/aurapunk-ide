import { QrCodeIcon } from '@phosphor-icons/react';
import { SidebarBarButton } from '@vibe/ui/components/SidebarBarButton';
import { LocalMobilePairingDialog } from '@/shared/dialogs/mobile/LocalMobilePairingDialog';

export function LocalMobilePairingAction() {
  return (
    <SidebarBarButton
      label="Connect"
      icon={QrCodeIcon}
      onClick={() => void LocalMobilePairingDialog.show({})}
      title="Pair AuraPunk Mobile over the local network"
      aria-label="Connect AuraPunk Mobile over the local network"
      className="text-normal"
    />
  );
}
