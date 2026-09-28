import {
  GearIcon,
  ListIcon,
  QrCodeIcon,
  SignInIcon,
  SignOutIcon,
  UserCircleIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/Dropdown';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { LocalMobilePairingDialog } from '@/shared/dialogs/mobile/LocalMobilePairingDialog';
import { Mem0StatusIndicator } from '@/shared/components/Mem0StatusIndicator';
import { LayaStatusIndicator } from '@/shared/components/LayaStatusIndicator';
import { useCloudAccount } from '@/shared/hooks/useCloudAccount';
import { makeRequest, handleApiResponse } from '@/shared/lib/api';

interface CloudSyncStatus {
  connected: boolean;
  pending: number;
  last_error: string | null;
}

type SyncTone = 'ok' | 'busy' | 'error' | 'off';

// Same palette as the Mem0 / RLCD health dots.
const TONE_DOT: Record<SyncTone, string> = {
  ok: '#22c55e',
  busy: '#eab308',
  error: '#ef4444',
  off: '#9ca3af',
};

/** Initials for the avatar: first letters of the first two words, or of the
 *  email's local part. */
export function accountInitials(name: string | undefined, email: string) {
  const source = name?.trim() || email.split('@')[0] || '?';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    words.length >= 2 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export function syncSummary(
  signedIn: boolean,
  status: CloudSyncStatus | undefined
): { tone: SyncTone; label: string; detail?: string } {
  if (!signedIn) return { tone: 'off', label: 'Local only' };
  if (!status) return { tone: 'busy', label: 'Connecting…' };
  if (status.last_error) {
    return { tone: 'error', label: 'Sync error', detail: status.last_error };
  }
  if (status.pending > 0) {
    return { tone: 'busy', label: `Syncing ${status.pending}…` };
  }
  if (!status.connected) return { tone: 'busy', label: 'Connecting…' };
  return { tone: 'ok', label: 'Cloud synced' };
}

/**
 * Bottom of the left sidebar: the account (avatar, name or "Account", cloud
 * sync state), the Mem0 and RLCD health indicators, and a menu with the
 * account, mobile pairing and settings actions.
 */
export function SidebarAccountFooter() {
  const { t } = useTranslation('common');
  const { account, pending, requestCloudAuth, openDashboard, signOut } =
    useCloudAccount();
  const { data: syncStatus } = useQuery<CloudSyncStatus | undefined>({
    queryKey: ['cloud-sync-status'],
    queryFn: async () =>
      handleApiResponse<CloudSyncStatus>(
        await makeRequest('/api/cloud-sync/status', { cache: 'no-store' })
      ),
    enabled: Boolean(account),
    refetchInterval: 30_000,
    retry: false,
  });
  const sync = syncSummary(Boolean(account), syncStatus);
  const name = account
    ? account.displayName?.trim() || account.email
    : t('sidebar.account');

  return (
    <div className="flex w-full min-w-0 items-center gap-half rounded-md border border-border bg-secondary/40 p-half">
      <button
        type="button"
        onClick={() => (account ? openDashboard() : void requestCloudAuth())}
        disabled={pending}
        title={account ? account.email : t('sidebar.cloudAuthTitle')}
        className="flex min-w-0 flex-1 items-center gap-half rounded-sm text-left hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/25 text-xs font-semibold text-high"
        >
          {account ? (
            accountInitials(account.displayName, account.email)
          ) : (
            <UserCircleIcon className="size-5" weight="bold" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-high">
            {name}
          </span>
          <span
            className="flex items-center gap-1.5 truncate text-xs text-low"
            title={sync.detail}
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: TONE_DOT[sync.tone] }}
            />
            <span className="truncate">{sync.label}</span>
          </span>
        </span>
      </button>

      <Mem0StatusIndicator />
      <LayaStatusIndicator />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account and settings menu"
            title="Account and settings"
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-low hover:bg-accent hover:text-normal focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <ListIcon className="size-icon-sm" weight="bold" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="min-w-[220px]">
          {account ? (
            <>
              <DropdownMenuLabel className="truncate">
                {account.email}
              </DropdownMenuLabel>
              <DropdownMenuItem icon={UserCircleIcon} onClick={openDashboard}>
                {t('sidebar.accountDashboard')}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              icon={SignInIcon}
              disabled={pending}
              onClick={() => void requestCloudAuth()}
            >
              {t('sidebar.logIn')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            icon={QrCodeIcon}
            onClick={() => void LocalMobilePairingDialog.show({})}
          >
            Connect AuraPunk Mobile
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={GearIcon}
            onClick={() => SettingsDialog.show()}
          >
            {t('sidebar.settings')}
          </DropdownMenuItem>
          {account && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon={SignOutIcon}
                variant="destructive"
                onClick={signOut}
              >
                {t('signOut')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
