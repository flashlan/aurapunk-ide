import { GearIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { SidebarBarButton } from '@vibe/ui/components/SidebarBarButton';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { Mem0StatusIndicator } from '@/shared/components/Mem0StatusIndicator';
import { LayaStatusIndicator } from '@/shared/components/LayaStatusIndicator';
import { CloudAuthActions } from '@/shared/components/CloudAuthActions';
import { LocalMobilePairingAction } from '@/shared/components/LocalMobilePairingAction';

/**
 * Bottom sidebar bar content (ADR-010). ADR-019: the kanban notifications
 * bell/badge was removed (the User entity it surfaced has been excised).
 * Only Settings remains here, plus the always-visible mem0 and Laya health
 * dots.
 */
export function SidebarBottomActions() {
  const { t } = useTranslation('common');

  return (
    <>
      <Mem0StatusIndicator />
      <LayaStatusIndicator />
      <LocalMobilePairingAction />
      <CloudAuthActions />
      <SidebarBarButton
        label={t('sidebar.settings')}
        icon={GearIcon}
        onClick={() => SettingsDialog.show()}
      />
    </>
  );
}
