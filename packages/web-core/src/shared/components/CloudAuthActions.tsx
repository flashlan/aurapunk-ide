import {
  SignInIcon,
  SignOutIcon,
  UserCircleIcon,
  UserPlusIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { SidebarBarButton } from '@vibe/ui/components/SidebarBarButton';
import { useCloudUrl, useIsCloudMode } from '@/shared/hooks/useAppMode';
import {
  makeLocalApiRequest,
  openLocalApiWebSocket,
} from '@/shared/lib/localApiTransport';
import { makeRequest } from '@/shared/lib/remoteApi';
import { CloudMemoryDialog } from '@/shared/dialogs/auth/CloudMemoryDialog';

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

  const syncCloudContext = useCallback(
    async (nextAccount: CloudAccount) => {
      if (!nextAccount.accessToken) return;

      try {
        const localResponse = await makeLocalApiRequest('/api/mobile/context', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!localResponse.ok) return;
        const localBody = (await localResponse.json()) as {
          success?: boolean;
          data?: { records?: CloudSyncRecord[] };
        };
        const records = localBody.data?.records ?? [];
        // Older Desktop context exporters may include the relationship only
        // inside the issue payload. Publish the normalized relation as well so
        // Mobile can open an existing workspace instead of offering to create
        // a duplicate one.
        const derivedRelations = records.flatMap((record) => {
          if (record.entity_type !== 'issue' || record.operation !== 'upsert') {
            return [];
          }
          const payload = record.payload as {
            workspace_id?: unknown;
            project_id?: unknown;
          };
          if (
            typeof payload.workspace_id !== 'string' ||
            payload.workspace_id.length === 0
          ) {
            return [];
          }
          return [
            {
              entity_type: 'issue_workspace' as const,
              entity_id: `${record.entity_id}:${payload.workspace_id}`,
              operation: 'upsert' as const,
              payload: {
                issue_id: record.entity_id,
                workspace_id: payload.workspace_id,
                ...(typeof payload.project_id === 'string'
                  ? { project_id: payload.project_id }
                  : {}),
              },
            },
          ];
        });
        const publishedRecords = [...records, ...derivedRelations].filter(
          (record, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.entity_type === record.entity_type &&
                candidate.entity_id === record.entity_id
            ) === index
        );

        const publish = async (operations: CloudSyncRecord[]) => {
          let lastError: Error | null = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const response = await fetch(
                `${cloudUrl.replace(/\/$/, '')}/api/sync`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${nextAccount.accessToken}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    source: 'desktop',
                    operations: operations.map((record) => ({
                      entityType: record.entity_type,
                      entityId: record.entity_id,
                      operation: record.operation,
                      payload: record.payload,
                    })),
                  }),
                }
              );
              if (response.ok) return;
              lastError = new Error(
                `Cloud sync returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`
              );
            } catch (error) {
              lastError =
                error instanceof Error ? error : new Error(String(error));
            }
            if (attempt < 2) {
              await new Promise((resolve) =>
                window.setTimeout(resolve, 500 * (attempt + 1))
              );
            }
          }
          throw lastError ?? new Error('Cloud sync failed');
        };

        // The catalog is independently useful to Mobile. Do not let a stale
        // board record or a transient Cloud failure prevent models/pipelines
        // from being published, and do not let a catalog failure hide cards.
        const catalogRecords = publishedRecords.filter(
          (record) =>
            record.entity_type === 'pipeline' ||
            record.entity_type === 'executor_options'
        );
        const boardRecords = publishedRecords.filter(
          (record) =>
            record.entity_type !== 'pipeline' &&
            record.entity_type !== 'executor_options'
        );
        try {
          for (let index = 0; index < boardRecords.length; index += 100) {
            await publish(boardRecords.slice(index, index + 100));
          }
        } catch (error) {
          console.warn('AuraPunk Cloud board sync failed', error);
        }
        try {
          for (let index = 0; index < catalogRecords.length; index += 100) {
            await publish(catalogRecords.slice(index, index + 100));
          }
        } catch (error) {
          console.warn('AuraPunk Cloud catalog sync failed', error);
        }

        // Keep the same discovered model catalog available to Mobile. The
        // mobile client cannot open the Desktop's localhost WebSocket, so the
        // Desktop publishes the catalog through the existing Cloud context
        // channel. It is intentionally best-effort: sending a message still
        // works with the executor default when discovery is unavailable.
        const modelResponse = await makeLocalApiRequest(
          '/api/agents/models?executor=codex',
          { headers: { Accept: 'application/json' }, cache: 'no-store' }
        );
        if (modelResponse.ok) {
          const modelBody = (await modelResponse.json()) as {
            data?: Array<{
              id: string;
              name: string;
              provider?: string;
            }>;
          };
          const models = modelBody.data ?? [];
          if (models.length > 0) {
            await publish([
              {
                entity_type: 'executor_options',
                entity_id: 'CODEX',
                operation: 'upsert',
                payload: { executor: 'CODEX', models },
              },
            ]);
          }
        }
      } catch (error) {
        console.warn('AuraPunk Cloud context sync failed', error);
        // Cloud sync is deliberately best-effort. The local database remains
        // authoritative while the network or Cloud service is unavailable.
      }
    },
    [cloudUrl]
  );

  const syncCloudSnapshot = useCallback(
    async (nextAccount: CloudAccount) => {
      if (!nextAccount.accessToken) return null;

      try {
        const response = await fetch(
          `${cloudUrl.replace(/\/$/, '')}/api/sync?view=snapshot&exclude=workspace_context,chat,chat_command,job,executor_options,pipeline,instance`,
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
                event.entityType === 'issue_workspace') &&
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

      const publishWorkspaceResult = async (
        requestId: string,
        payload: MobileWorkspaceRequestResult
      ) => {
        const response = await fetch(
          `${cloudUrl.replace(/\/$/, '')}/api/sync`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${nextAccount.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              source: 'desktop',
              operations: [
                {
                  entityType: 'chat_command',
                  entityId: `${requestId}:result`,
                  operation: 'upsert',
                  payload,
                },
              ],
            }),
          }
        );
        if (!response.ok) {
          console.warn(
            'Could not publish workspace request result',
            requestId,
            await response.text()
          );
        }
      };

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
          if (event.entityType === 'chat_command') {
            const payload = event.payload as
              | MobileChatCommand
              | MobileWorkspaceRequest;
            if (payload.kind === 'workspace_request') {
              if (!payload.issue_id) continue;
              const localResponse = await makeLocalApiRequest(
                '/api/mobile/workspace',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                  signal,
                }
              );
              const responseBody = await localResponse.text();
              if (!localResponse.ok) {
                console.warn(
                  'Cloud workspace request was rejected by Desktop',
                  event.entityId,
                  responseBody
                );
                await publishWorkspaceResult(event.entityId ?? '', {
                  kind: 'workspace_request_result',
                  issue_id: payload.issue_id,
                  status: 'error',
                  message:
                    responseBody.slice(0, 500) ||
                    'Desktop rejected the request',
                });
              } else {
                let workspaceId: string | undefined;
                try {
                  const result = JSON.parse(responseBody) as {
                    data?: { workspace_id?: string };
                  };
                  workspaceId = result.data?.workspace_id;
                } catch {
                  // The workspace context sync remains authoritative.
                }
                await publishWorkspaceResult(event.entityId ?? '', {
                  kind: 'workspace_request_result',
                  issue_id: payload.issue_id,
                  status: 'completed',
                  workspace_id: workspaceId,
                });
              }
              continue;
            }
            if (!payload.workspace_id || !payload.prompt?.trim()) continue;
            const localResponse = await makeLocalApiRequest(
              '/api/mobile/chat',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal,
              }
            );
            if (!localResponse.ok) {
              console.warn(
                'Cloud chat command was rejected by Desktop',
                event.entityId,
                await localResponse.text()
              );
            }
          } else if (event.entityType === 'workspace_request') {
            const payload = event.payload as MobileWorkspaceRequest;
            if (!payload.issue_id) continue;
            const localResponse = await makeLocalApiRequest(
              '/api/mobile/workspace',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal,
              }
            );
            if (!localResponse.ok) {
              console.warn(
                'Cloud workspace request was rejected by Desktop',
                event.entityId,
                await localResponse.text()
              );
            }
          } else if (event.entityType === 'issue') {
            const payload = event.payload as { status_id?: string };
            if (!payload.status_id || !event.entityId) continue;
            const localResponse = await makeLocalApiRequest(
              `/api/issues/${event.entityId}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status_id: payload.status_id }),
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
          // Tokens issued before hosted memory was added can still represent a
          // valid Cloud account, but they cannot authenticate the memory
          // gateway. Do not keep presenting that account as fully connected;
          // force a clean authorization so the next token includes `memory`.
          if (!parsed.memory?.enabled || !parsed.scopes.includes('memory')) {
            await clearPersistedAccount();
            window.localStorage.removeItem(CLOUD_ACCOUNT_STORAGE_KEY);
            window.localStorage.removeItem(
              `${CLOUD_MEMORY_PREFERENCE_PREFIX}:${parsed.userId}`
            );
            setAccount(null);
            window.dispatchEvent(new Event('aurapunk-cloud-account-changed'));
            return;
          }
          setAccount(parsed);
          window.dispatchEvent(new Event('aurapunk-cloud-account-changed'));
          void persistAccount(parsed);
          void offerCloudMemory(parsed);
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
          void syncCloudContext(parsed);
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
    syncCloudContext,
    syncCloudSnapshot,
    syncMem0Account,
  ]);

  useEffect(() => {
    if (!account?.accessToken) return;
    const controller = new AbortController();
    void watchCloudCommands(account, controller.signal);
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let cancelled = false;
    let contextSync: Promise<void> | null = null;
    let contextSyncQueued = false;

    const pushContext = () => {
      if (cancelled) return;
      if (contextSync) {
        contextSyncQueued = true;
        return;
      }

      contextSync = syncCloudContext(account).finally(() => {
        contextSync = null;
        if (contextSyncQueued) {
          contextSyncQueued = false;
          pushContext();
        }
      });
    };

    const connectToLocalEvents = async () => {
      if (cancelled) return;
      try {
        socket = await openLocalApiWebSocket('/api/workspaces/streams/ws');
        if (cancelled) {
          socket.close();
          return;
        }
        socket.onmessage = pushContext;
        socket.onerror = () => socket?.close();
        socket.onclose = () => {
          socket = null;
          if (!cancelled) {
            reconnectTimer = window.setTimeout(() => {
              void connectToLocalEvents();
            }, 3000);
          }
        };
      } catch {
        if (!cancelled) {
          reconnectTimer = window.setTimeout(() => {
            void connectToLocalEvents();
          }, 3000);
        }
      }
    };

    // Initial snapshot, then only local event notifications. The 3s delay is
    // reconnect backoff, not a UI polling interval.
    pushContext();
    void connectToLocalEvents();

    return () => {
      cancelled = true;
      controller.abort();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [account, syncCloudContext, watchCloudCommands]);

  const openExternal = useCallback(async (url: string) => {
    if ('__TAURI_INTERNALS__' in window) {
      await invoke('open_external_url', { url });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const openCloudAuth = useCallback(async () => {
    const state = crypto.randomUUID().replaceAll('-', '');
    try {
      const url = new URL('/desktop-auth', cloudUrl);
      url.searchParams.set('state', state);
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
        void syncCloudContext(result.account);
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
  }, [cloudUrl, offerCloudMemory, openExternal, persistAccount]);

  useEffect(() => {
    const handleLoginRequest = () => void openCloudAuth();
    window.addEventListener('aurapunk-cloud-login-request', handleLoginRequest);
    return () =>
      window.removeEventListener(
        'aurapunk-cloud-login-request',
        handleLoginRequest
      );
  }, [openCloudAuth]);

  const openDashboard = useCallback(() => {
    void openExternal(`${cloudUrl.replace(/\/$/, '')}/dashboard`);
  }, [cloudUrl, openExternal]);

  const signOut = useCallback(() => {
    void clearPersistedAccount();
    setAccount(null);
    window.dispatchEvent(new Event('aurapunk-cloud-account-changed'));
    void syncMem0Account(null);
  }, [clearPersistedAccount, syncMem0Account]);

  return (
    <>
      {account && (
        <SidebarBarButton
          label="Account"
          icon={UserCircleIcon}
          onClick={openDashboard}
          title={account.email}
          aria-label={`Signed in as ${account.email}`}
          className="text-normal"
        />
      )}
      {account ? (
        <SidebarBarButton
          label="Logout"
          icon={SignOutIcon}
          onClick={signOut}
          title="Sign out of this app"
          aria-label="Logout"
          className="text-normal"
        />
      ) : (
        <>
          <SidebarBarButton
            label={t('sidebar.logIn')}
            icon={SignInIcon}
            onClick={() => void openCloudAuth()}
            title={t('sidebar.cloudAuthTitle')}
            aria-label={t('sidebar.logIn')}
            className="text-normal"
            disabled={pending}
          />
          <SidebarBarButton
            label={t('sidebar.signUp')}
            icon={UserPlusIcon}
            onClick={() => void openCloudAuth()}
            title={t('sidebar.cloudAuthTitle')}
            aria-label={t('sidebar.signUp')}
            className="text-normal"
            disabled={pending}
          />
        </>
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

type CloudSyncRecord = {
  entity_type:
    | 'project'
    | 'status'
    | 'workspace'
    | 'workspace_request'
    | 'issue_workspace'
    | 'chat'
    | 'chat_command'
    | 'issue'
    | 'job'
    | 'executor_options'
    | 'pipeline'
    | 'instance';
  entity_id: string;
  operation: 'upsert' | 'delete';
  payload: unknown;
};

type CloudSyncEvent = {
  entityType?: string;
  entityId?: string;
  operation?: string;
  payload?: unknown;
  revision?: number;
};

type MobileChatCommand = {
  kind?: never;
  workspace_id: string;
  prompt: string;
  executor?: string;
};

type MobileWorkspaceRequest = {
  kind: 'workspace_request';
  issue_id: string;
  executor?: string;
  model_id?: string;
  reasoning_id?: string;
  agent_id?: string;
  permission_policy?: string;
  prompt?: string;
  pipeline_id?: string;
  pipeline_stage_ids?: string[];
};

type MobileWorkspaceRequestResult = {
  kind: 'workspace_request_result';
  issue_id: string;
  status: 'completed' | 'error';
  message?: string;
  workspace_id?: string;
};

const CLOUD_ACCOUNT_STORAGE_KEY = 'aurapunk-cloud-account';
const CLOUD_SNAPSHOT_RELOAD_PREFIX = 'aurapunk-cloud-snapshot-reload';
const CLOUD_COMMAND_CURSOR_PREFIX = 'aurapunk-cloud-command-cursor';
