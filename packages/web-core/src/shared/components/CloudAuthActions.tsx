import { SignInIcon, SignOutIcon, UserCircleIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { SidebarBarButton } from '@vibe/ui/components/SidebarBarButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/Dropdown';
import { useCloudUrl, useIsCloudMode } from '@/shared/hooks/useAppMode';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { makeRequest } from '@/shared/lib/remoteApi';
import { CloudMemoryDialog } from '@/shared/dialogs/auth/CloudMemoryDialog';
import { CloudAuthDialog } from '@/shared/dialogs/auth/CloudAuthDialog';

/**
 * Cloud authentication entry points. Authentication is completed by the
 * AuraPunk Cloud website so the desktop app never handles a provider password
 * or stores a browser session itself.
 */
export function CloudAuthActions() {
  const { t } = useTranslation('common');
  const cloudUrl = useCloudUrl();
  const isCloudMode = useIsCloudMode();
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [pending, setPending] = useState(false);

  const persistAccount = useCallback(async (nextAccount: CloudAccount) => {
    window.localStorage.setItem(
      CLOUD_ACCOUNT_STORAGE_KEY,
      JSON.stringify(nextAccount)
    );
    window.dispatchEvent(new Event('aurapunk-cloud-account-changed'));
    if ('__TAURI_INTERNALS__' in window) {
      await invoke('write_cloud_account', {
        account: JSON.stringify(nextAccount),
      });
    }
  }, []);

  const clearPersistedAccount = useCallback(async () => {
    window.localStorage.removeItem(CLOUD_ACCOUNT_STORAGE_KEY);
    if ('__TAURI_INTERNALS__' in window) {
      await invoke('clear_cloud_account');
    }
  }, []);

  const syncMem0Account = useCallback(async (account: CloudAccount | null) => {
    try {
      const connectionResponse = await makeRequest(
        '/api/usage/mem0-connection',
        {
          method: 'PUT',
          body: JSON.stringify(
            account?.memory?.enabled
              ? {
                  source: 'cloud',
                  adapter: 'mem0_vk',
                  enabled: true,
                  url: account.memory.gatewayUrl,
                  cloud_vector_only: account.memory.plan === 'free',
                  mem0_api_key: account.accessToken,
                }
              : {
                  disconnect_cloud: true,
                }
          ),
        }
      );
      if (!connectionResponse.ok) {
        throw new Error(
          `Mem0 connection handoff failed (HTTP ${connectionResponse.status})`
        );
      }
      const accountResponse = await makeRequest('/api/usage/mem0-account', {
        method: 'PUT',
        body: JSON.stringify({ account_id: account?.userId ?? null }),
      });
      if (!accountResponse.ok) {
        throw new Error(
          `Mem0 account handoff failed (HTTP ${accountResponse.status})`
        );
      }
      window.dispatchEvent(new Event('mem0-connection-changed'));
    } catch (error) {
      console.warn('AuraPunk Cloud memory handoff failed', error);
      // The desktop app remains usable when its optional local backend is not
      // available; hosted Mem0 will simply reject requests without identity.
    }
  }, []);

  const offerCloudMemory = useCallback(
    async (nextAccount: CloudAccount, alwaysAsk = false) => {
      const memory = nextAccount.memory;
      if (!memory?.enabled) return;
      const preferenceKey = `${CLOUD_MEMORY_PREFERENCE_PREFIX}:${nextAccount.userId}`;
      // The WebView localStorage can be recreated after an app update. Keep
      // the choice inside the native account file as the durable source, with
      // localStorage retained as a browser/dev fallback.
      const savedChoice =
        nextAccount.memoryPreference ??
        window.localStorage.getItem(preferenceKey);
      if (!alwaysAsk && savedChoice === 'cloud') {
        await syncMem0Account(nextAccount);
        return;
      }
      if (!alwaysAsk && savedChoice === 'self-hosted') return;

      const choice = await CloudMemoryDialog.show({
        plan: memory.plan,
        memories: memory.quota.memories,
        writesPerMonth: memory.quota.writesPerMonth,
        searchesPerMonth: memory.quota.searchesPerMonth,
      });
      window.localStorage.setItem(preferenceKey, choice);
      await persistAccount({ ...nextAccount, memoryPreference: choice });
      if (choice === 'cloud') await syncMem0Account(nextAccount);
    },
    [persistAccount, syncMem0Account]
  );

  // The backend publishes local changes to Cloud from its own outbox
  // (ADR-047 phase 2); the UI only hands over the account to publish as.
  const linkCloudSync = useCallback(
    async (nextAccount: CloudAccount | null) => {
      try {
        const response = await makeRequest('/api/cloud-sync/account', {
          method: 'PUT',
          body: JSON.stringify({
            account: nextAccount?.accessToken
              ? {
                  cloud_url: cloudUrl.replace(/\/$/, ''),
                  access_token: nextAccount.accessToken,
                  user_id: nextAccount.userId,
                }
              : null,
          }),
        });
        if (!response.ok) {
          console.warn('AuraPunk Cloud sync link failed', response.status);
        }
      } catch (error) {
        console.warn('AuraPunk Cloud sync link failed', error);
      }
    },
    [cloudUrl]
  );

  const syncCloudSnapshot = useCallback(
    async (nextAccount: CloudAccount) => {
      if (!nextAccount.accessToken) return null;

      try {
        const response = await fetch(
          `${cloudUrl.replace(/\/$/, '')}/api/sync?view=snapshot&exclude=chat_command,job,executor_options,pipeline,instance`,
          {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${nextAccount.accessToken}`,
            },
            cache: 'no-store',
          }
        );
        if (!response.ok) {
          console.warn(
            'AuraPunk Cloud snapshot pull failed',
            response.status,
            await response.text()
          );
          return null;
        }

        const body = (await response.json()) as {
          revision?: number;
          events?: Array<{
            entityType?: string;
            entityId?: string;
            operation?: string;
            payload?: unknown;
          }>;
        };
        const records = (body.events ?? [])
          .filter(
            (event): event is Required<typeof event> =>
              (event.entityType === 'project' ||
                event.entityType === 'status' ||
                event.entityType === 'issue' ||
                event.entityType === 'workspace' ||
                event.entityType === 'issue_workspace' ||
                event.entityType === 'workspace_context' ||
                event.entityType === 'chat') &&
              typeof event.entityId === 'string' &&
              event.operation === 'upsert'
          )
          .map((event) => ({
            entity_type: event.entityType,
            entity_id: event.entityId,
            operation: event.operation,
            payload: event.payload ?? null,
          }));
        if (records.length === 0) {
          return {
            revision: Number(body.revision ?? 0),
            imported: 0,
          };
        }

        const localResponse = await makeLocalApiRequest(
          '/api/mobile/import-context',
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ records }),
          }
        );
        if (!localResponse.ok) {
          console.warn(
            'AuraPunk Cloud snapshot import failed',
            localResponse.status,
            await localResponse.text()
          );
          return null;
        }

        const localBody = (await localResponse.json()) as {
          data?: { imported?: number };
        };
        return {
          revision: Number(body.revision ?? 0),
          imported: Number(localBody.data?.imported ?? records.length),
        };
      } catch (error) {
        console.warn('AuraPunk Cloud snapshot pull failed', error);
        return null;
      }
    },
    [cloudUrl]
  );

  const syncCloudCommands = useCallback(
    async (nextAccount: CloudAccount, signal?: AbortSignal) => {
      if (!nextAccount.accessToken) return;

      // Prompts and workspace requests from Mobile are claimed and run by
      // the backend from the Cloud command queue (ADR-047 phase 3). This
      // loop only mirrors card moves made on other instances until the
      // board becomes multi-writer (phase 5).
      const cursorKey = `${CLOUD_COMMAND_CURSOR_PREFIX}:${nextAccount.userId}`;
      const cursor = Number(window.localStorage.getItem(cursorKey) ?? '0');
      try {
        const response = await fetch(
          `${cloudUrl.replace(/\/$/, '')}/api/sync?after_revision=${Math.max(0, cursor)}&limit=200&wait_ms=25000`,
          {
            headers: { Authorization: `Bearer ${nextAccount.accessToken}` },
            cache: 'no-store',
            signal,
          }
        );
        if (!response.ok) {
          await new Promise((resolve) => window.setTimeout(resolve, 2500));
          return;
        }
        const body = (await response.json()) as { events?: CloudSyncEvent[] };
        let nextCursor = cursor;
        for (const event of body.events ?? []) {
          nextCursor = Math.max(nextCursor, event.revision ?? nextCursor);
          if (event.operation !== 'upsert') continue;
          if (event.entityType === 'issue') {
            const payload = event.payload as {
              status_id?: string;
              updated_at?: string;
            };
            if (!payload.status_id || !event.entityId) continue;
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
            };
            // Carry the source row's timestamp so the Desktop can keep its
            // own newer edit: a replayed/stale Cloud event must never drag a
            // locally moved card back to its previous column.
            if (payload.updated_at) {
              headers['X-Client-Updated-At'] = payload.updated_at;
            }
            const localResponse = await makeLocalApiRequest(
              `/api/issues/${event.entityId}`,
              {
                method: 'PATCH',
                headers,
                // A mirrored remote move is the operator acting on another
                // device: it carries the same unmerged-Done override as every
                // interactive surface, so a reflected Done is never refused by
                // the integration guard (agents never set it).
                body: JSON.stringify({
                  status_id: payload.status_id,
                  allow_unmerged_done: true,
                }),
                signal,
              }
            );
            if (!localResponse.ok) {
              console.warn(
                'Cloud issue update was rejected by Desktop',
                event.entityId,
                await localResponse.text()
              );
            }
          }
        }
        window.localStorage.setItem(cursorKey, String(nextCursor));
      } catch {
        if (signal?.aborted) return;
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    },
    [cloudUrl]
  );

  const watchCloudCommands = useCallback(
    async (nextAccount: CloudAccount, signal: AbortSignal) => {
      while (!signal.aborted) {
        await syncCloudCommands(nextAccount, signal);
      }
    },
    [syncCloudCommands]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let saved = window.localStorage.getItem(CLOUD_ACCOUNT_STORAGE_KEY);
        if ('__TAURI_INTERNALS__' in window) {
          saved = (await invoke<string | null>('read_cloud_account')) ?? saved;
        }

        // A Cloud IDE is opened through a tenant subdomain with the Better
        // Auth session cookie bridged by the launch redirect. Bootstrap the
        // same device token used by Desktop so a fresh container does not
        // wait for a second manual authorization or start disconnected.
        if (!saved && isCloudMode) {
          const response = await fetch(
            `${cloudUrl.replace(/\/$/, '')}/api/cloud-ide/session`,
            {
              headers: { Accept: 'application/json' },
              credentials: 'include',
              cache: 'no-store',
            }
          );
          if (response.ok) {
            const body = (await response.json()) as {
              account?: CloudAccount;
            };
            const cloudAccount = body.account;
            if (cloudAccount?.accessToken && !cancelled) {
              const nextAccount: CloudAccount = {
                ...cloudAccount,
                memoryPreference: 'cloud',
              };
              setAccount(nextAccount);
              window.dispatchEvent(new Event('aurapunk-cloud-account-changed'));
              await persistAccount(nextAccount);
              await syncMem0Account(nextAccount);
              const snapshot = await syncCloudSnapshot(nextAccount);
              // The board/workspace streams are initialized while the app is
              // mounting. Reload once after the first import so those streams
              // see the materialized SQLite rows instead of their original
              // empty snapshot. The persisted account prevents a reload loop.
              if (snapshot?.imported) {
                window.sessionStorage.setItem(
                  `${CLOUD_SNAPSHOT_RELOAD_PREFIX}:${nextAccount.userId}`,
                  String(snapshot.revision)
                );
                window.location.reload();
              }
              return;
            }
          } else {
            console.warn(
              'AuraPunk Cloud IDE session bootstrap failed',
              response.status
            );
          }
        }

        if (!saved) return;
        const parsed = JSON.parse(saved) as CloudAccount;
        if (!cancelled && parsed.accessToken) {
          // A Cloud account remains valid for Desktop -> Mobile board sync even
          // when its token predates hosted memory or the plan does not include
          // it. Memory is an optional capability: discarding the whole account
          // over a missing `memory` scope also killed board/command sync and
          // left hosted Mem0 looking offline. Keep the account; only skip the
          // memory handoff when the gateway is unavailable.
          const hasHostedMemory =
            Boolean(parsed.memory?.enabled) &&
            (parsed.scopes ?? []).includes('memory');
          setAccount(parsed);
          window.dispatchEvent(new Event('aurapunk-cloud-account-changed'));
          void persistAccount(parsed);
          if (hasHostedMemory) {
            void offerCloudMemory(parsed);
          } else {
            // Drop a stale hosted binding so the status reflects the missing
            // scope. A self-hosted/local memory config (source !== "cloud") is
            // left untouched by the backend.
            void syncMem0Account(null);
          }
          if (isCloudMode) {
            const snapshot = await syncCloudSnapshot(parsed);
            if (snapshot?.imported) {
              const reloadKey = `${CLOUD_SNAPSHOT_RELOAD_PREFIX}:${parsed.userId}`;
              if (
                window.sessionStorage.getItem(reloadKey) !==
                String(snapshot.revision)
              ) {
                window.sessionStorage.setItem(
                  reloadKey,
                  String(snapshot.revision)
                );
                window.location.reload();
                return;
              }
            }
          }
        }
      } catch {
        // Ignore malformed or unavailable device-local account state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearPersistedAccount,
    cloudUrl,
    isCloudMode,
    offerCloudMemory,
    persistAccount,
    syncCloudSnapshot,
    syncMem0Account,
  ]);

  useEffect(() => {
    if (!account?.accessToken) return;
    const controller = new AbortController();
    void watchCloudCommands(account, controller.signal);
    void linkCloudSync(account);

    return () => {
      controller.abort();
    };
  }, [account, linkCloudSync, watchCloudCommands]);

  const openExternal = useCallback(async (url: string) => {
    if ('__TAURI_INTERNALS__' in window) {
      await invoke('open_external_url', { url });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const openCloudAuth = useCallback(
    async (mode?: 'login' | 'signup') => {
      const state = crypto.randomUUID().replaceAll('-', '');
      try {
        const url = new URL('/desktop-auth', cloudUrl);
        url.searchParams.set('state', state);
        // Hint the hosted flow so the browser can open the login or the
        // create-account form directly; the state handoff is unchanged.
        if (mode) url.searchParams.set('mode', mode);
        setPending(true);
        await openExternal(url.toString());

        const deadline = Date.now() + 2 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          const response = await fetch(
            `${url.origin}/api/desktop-auth/status?state=${state}`,
            { cache: 'no-store' }
          );
          if (!response.ok) continue;
          const result = (await response.json()) as DesktopAuthStatus;
          if (result.status !== 'complete') continue;

          setAccount(result.account);
          // Persist the device authorization before opening any optional
          // follow-up dialog. If the memory prompt is dismissed or fails, the
          // browser authorization must still remain connected to this app.
          try {
            await persistAccount(result.account);
          } catch (error) {
            console.warn('Could not persist AuraPunk Cloud account', error);
          }
          try {
            await offerCloudMemory(result.account, true);
          } catch (error) {
            console.warn('Could not open AuraPunk Cloud memory prompt', error);
          }
          break;
        }
      } catch (error) {
        console.warn('Could not start AuraPunk Cloud sign-in', error);
        // Do not redirect to the dashboard here: that hides an authorization
        // failure and looks like a successful login. The native opener has its
        // own platform fallback, so this branch is only for a real failure.
      } finally {
        setPending(false);
      }
    },
    [cloudUrl, offerCloudMemory, openExternal, persistAccount]
  );

  useEffect(() => {
    const handleLoginRequest = () => void openCloudAuth();
    window.addEventListener('aurapunk-cloud-login-request', handleLoginRequest);
    return () =>
      window.removeEventListener(
        'aurapunk-cloud-login-request',
        handleLoginRequest
      );
  }, [openCloudAuth]);

  const requestCloudAuth = useCallback(async () => {
    const choice = await CloudAuthDialog.show({});
    if (choice) await openCloudAuth(choice);
  }, [openCloudAuth]);

  const openDashboard = useCallback(() => {
    void openExternal(`${cloudUrl.replace(/\/$/, '')}/dashboard`);
  }, [cloudUrl, openExternal]);

  const signOut = useCallback(() => {
    void clearPersistedAccount();
    setAccount(null);
    window.dispatchEvent(new Event('aurapunk-cloud-account-changed'));
    void syncMem0Account(null);
    void linkCloudSync(null);
  }, [clearPersistedAccount, linkCloudSync, syncMem0Account]);

  return (
    <>
      {account ? (
        // Account and sign-out share one entry: the account button opens a
        // menu with the dashboard link and the sign-out action.
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarBarButton
              label={t('sidebar.account')}
              icon={UserCircleIcon}
              title={account.email}
              aria-label={`${t('sidebar.account')} — ${account.email}`}
              className="text-normal"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="min-w-[220px]"
          >
            <DropdownMenuLabel className="truncate">
              {account.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={UserCircleIcon} onClick={openDashboard}>
              {t('sidebar.accountDashboard')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={SignOutIcon}
              variant="destructive"
              onClick={signOut}
            >
              {t('signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // Login and sign-up share one entry: the button opens a modal with
        // links into both sides of the hosted account flow.
        <SidebarBarButton
          label={t('sidebar.logIn')}
          icon={SignInIcon}
          onClick={() => void requestCloudAuth()}
          title={t('sidebar.cloudAuthTitle')}
          aria-label={t('sidebar.logIn')}
          className="text-normal"
          disabled={pending}
        />
      )}
    </>
  );
}

type CloudAccount = {
  userId: string;
  displayName: string;
  email: string;
  accessToken: string;
  deviceId: string;
  scopes: string[];
  expiresAt: number;
  memoryPreference?: 'cloud' | 'self-hosted';
  memory?: {
    enabled: boolean;
    gatewayUrl: string;
    plan: 'free' | 'personal' | 'enterprise';
    quota: {
      memories: number;
      writesPerMonth: number;
      searchesPerMonth: number;
    };
  };
};

const CLOUD_MEMORY_PREFERENCE_PREFIX = 'aurapunk-cloud-memory';

type DesktopAuthStatus =
  | { status: 'pending' }
  | { status: 'complete'; account: CloudAccount };

type CloudSyncEvent = {
  entityType?: string;
  entityId?: string;
  operation?: string;
  payload?: unknown;
  revision?: number;
};

const CLOUD_ACCOUNT_STORAGE_KEY = 'aurapunk-cloud-account';
const CLOUD_SNAPSHOT_RELOAD_PREFIX = 'aurapunk-cloud-snapshot-reload';
const CLOUD_COMMAND_CURSOR_PREFIX = 'aurapunk-cloud-command-cursor';
