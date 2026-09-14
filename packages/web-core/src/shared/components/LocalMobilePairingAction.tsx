import { QrCodeIcon } from '@phosphor-icons/react';
import { SidebarBarButton } from '@vibe/ui/components/SidebarBarButton';
import { LocalMobilePairingDialog } from '@/shared/dialogs/mobile/LocalMobilePairingDialog';

export function LocalMobilePairingAction() {
  return (
    <SidebarBarButton
      label="Conectar celular"
      icon={QrCodeIcon}
      onClick={() => void LocalMobilePairingDialog.show({})}
      title="Parear AuraPunk Mobile pela rede local"
      aria-label="Conectar AuraPunk Mobile pela rede local"
      className="text-normal"
    />
  );
}
