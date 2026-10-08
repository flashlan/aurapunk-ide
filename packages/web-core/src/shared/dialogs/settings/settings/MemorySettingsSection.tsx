import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { fetchMem0Connection } from './mem0Api';
import type { Mem0Connection } from './mem0Config';
import { MemoryUsageStats } from './MemoryUsageStats';

// Same dot palette as the header Mem0StatusIndicator: green = reachable,
// gray = unreachable or still checking.
const MODULE_DOT_OK = '#22c55e';
const MODULE_DOT_IDLE = '#9ca3af';

function ModuleStatusDot({
  ok,
  label,
  stateText,
  hint,
}: {
  ok: boolean;
  label: string;
  stateText: string;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-2" title={hint}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: ok ? MODULE_DOT_OK : MODULE_DOT_IDLE }}
      />
      <span className="text-xs font-medium text-normal">{label}</span>
      <span className="text-2xs text-low">{stateText}</span>
    </div>
  );
}

/**
 * Settings → Memory: which memory to use, plus how that memory is behaving.
 *
 * Mem0's own configuration (hosting, endpoints, adapters, extraction
 * providers, migration) lives in its own add-on panel under Add-ons, next to
 * the Obsidian vault and the Fast Jev & Laya suite.
 */
export function MemorySettingsSection() {
  const { config: appConfig, updateAndSaveConfig } = useUserSystem();
  const [memorySaving, setMemorySaving] = useState(false);
  const [memorySaveError, setMemorySaveError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Mem0Connection | null>(null);
  const { t } = useTranslation('settings');

  const load = useCallback(async () => {
    try {
      setConnection(await fetchMem0Connection());
    } catch {
      // The module dots below report an unknown state; no banner needed.
      setConnection(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-4">
      <div className="rounded-sm border border-border bg-panel p-3 space-y-3">
        <label
          htmlFor="memory-backend"
          className="block text-sm font-medium text-high"
        >
          {t('settings.memory.backend', 'Memory source')}
        </label>
        <select
          id="memory-backend"
          className="w-full rounded border border-border bg-secondary px-3 py-2 text-sm text-normal"
          value={appConfig?.memory_backend ?? 'mem0'}
          disabled={!appConfig || memorySaving}
          onChange={async (event) => {
            const memory_backend = event.target.value;
            setMemorySaving(true);
            setMemorySaveError(null);
            try {
              if (!(await updateAndSaveConfig({ memory_backend }))) {
                setMemorySaveError('Could not save the memory source.');
              }
            } catch {
              setMemorySaveError('Could not save the memory source.');
            } finally {
              setMemorySaving(false);
            }
          }}
        >
          <option value="mem0">Mem0</option>
          <option value="obsidian_okf">Obsidian + OKF</option>
          <option value="both">Both</option>
        </select>
        <p className="text-xs text-low">
          {t(
            'settings.memory.backendHint',
            'Default memory for the app. Automatic OKF integration is still under implementation, so this choice does not yet change the memory sessions use.'
          )}
        </p>
        {memorySaving && <p role="status">Saving…</p>}
        {memorySaveError && (
          <p role="alert" className="text-sm text-error">
            {memorySaveError}
          </p>
        )}
      </div>

      <div className="rounded-sm border border-border bg-panel p-3">
        <div className="text-sm font-medium text-high">
          {t('settings.memory.modules.title', 'Module status')}
        </div>
        <div className="mt-1 text-xs text-low">
          {t(
            'settings.memory.modules.hint',
            'Live availability of the services agents rely on. Gray means unreachable or still checking.'
          )}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <ModuleStatusDot
            ok={connection !== null}
            label={t(
              'settings.memory.modules.integrationGuard',
              'Integration Guard'
            )}
            stateText={
              connection !== null
                ? t('settings.memory.modules.available', 'Available')
                : t('settings.memory.modules.unknown', 'Unknown')
            }
            hint={t(
              'settings.memory.modules.integrationGuardHint',
              'Runs inside the backend: green while this settings API answers.'
            )}
          />
          <ModuleStatusDot
            ok={connection !== null}
            label={t('settings.memory.modules.aurapunkMcp', 'Aurapunk MCP')}
            stateText={
              connection !== null
                ? t('settings.memory.modules.available', 'Available')
                : t('settings.memory.modules.unknown', 'Unknown')
            }
            hint={t(
              'settings.memory.modules.aurapunkMcpHint',
              'Stdio server agents use (aurapunk-mcp). It can only serve tools while this backend is reachable.'
            )}
          />
        </div>
      </div>

      <MemoryUsageStats />
    </div>
  );
}
