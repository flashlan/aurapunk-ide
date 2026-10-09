import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchMem0Connection, updateMem0Connection } from './mem0Api';
import {
  MIN_ACTIVE_SOURCES,
  type Mem0Connection,
  type MemorySource,
} from './mem0Config';
import { MemoryUsageStats } from './MemoryUsageStats';

// Same dot palette as the header Mem0StatusIndicator: green = reachable,
// gray = unreachable or still checking.
const MODULE_DOT_OK = '#22c55e';
const MODULE_DOT_IDLE = '#9ca3af';

interface MemorySourceOption {
  id: MemorySource;
  label: string;
  description: string;
  labelKey: string;
  descriptionKey: string;
  /** False when the source is stored but no backend reads it yet. */
  implemented?: boolean;
}

/**
 * Which memory sources the agent stack may consult. Only `mem0_semantic` has a
 * backend reader today; the others are persisted so the choice is explicit,
 * and `implemented: false` says so in the UI instead of pretending.
 */
const MEMORY_SOURCE_OPTIONS: MemorySourceOption[] = [
  {
    id: 'mem0_semantic',
    label: 'Mem0 semantic',
    description: 'Vector search and writes through Mem0.',
    labelKey: 'settings.memory.source.mem0Semantic',
    descriptionKey: 'settings.memory.source.mem0SemanticHint',
    implemented: true,
  },
  {
    id: 'qdrant',
    label: 'Qdrant',
    description: 'Vector store behind self-hosted Mem0. Needs semantic Mem0 on.',
    labelKey: 'settings.memory.source.qdrant',
    descriptionKey: 'settings.memory.source.qdrantHint',
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    description: 'Shared vault, reached through its MCP server.',
    labelKey: 'settings.memory.source.obsidian',
    descriptionKey: 'settings.memory.source.obsidianHint',
  },
  {
    id: 'specs',
    label: 'Specs',
    description: 'SpecKit artifacts under specs/<branch>/.',
    labelKey: 'settings.memory.source.specs',
    descriptionKey: 'settings.memory.source.specsHint',
    implemented: false,
  },
];

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
  const [sources, setSources] = useState<MemorySource[]>([]);
  const [sourcesSaving, setSourcesSaving] = useState(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Mem0Connection | null>(null);
  const { t } = useTranslation('settings');

  const toggleSource = useCallback(
    async (id: MemorySource) => {
      const next = sources.includes(id)
        ? sources.filter((source) => source !== id)
        : [...sources, id];
      if (next.length < MIN_ACTIVE_SOURCES) {
        setSourcesError(
          t(
            'settings.memory.sourcesMinError',
            'Keep at least one memory source active.'
          )
        );
        return;
      }
      setSourcesError(null);
      setSourcesSaving(true);
      // Optimistic: the checkbox must not lag behind the click.
      setSources(next);
      try {
        const saved = await updateMem0Connection({ sources: next });
        setSources(saved.sources ?? next);
        setConnection((prev) => (prev ? { ...prev, sources: saved.sources } : prev));
        window.dispatchEvent(new Event('mem0-connection-changed'));
      } catch {
        setSources(sources);
        setSourcesError(
          t('settings.memory.sourcesSaveError', 'Could not save the memory sources.')
        );
      } finally {
        setSourcesSaving(false);
      }
    },
    [sources, t]
  );

  const load = useCallback(async () => {
    try {
      const next = await fetchMem0Connection();
      setConnection(next);
      setSources(next.sources ?? []);
      setSourcesError(null);
    } catch {
      // The module dots below report an unknown state; no banner needed.
      setConnection(null);
    }
  }, []);

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener('mem0-connection-changed', refresh);
    return () => window.removeEventListener('mem0-connection-changed', refresh);
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-4">
      <div className="rounded-sm border border-border bg-panel p-3 space-y-3">
        <span className="block text-sm font-medium text-high">
          {t('settings.memory.sources', 'Memory sources')}
        </span>
        <p className="text-xs text-low">
          {t(
            'settings.memory.sourcesHint',
            'These are the memories the memory_project MCP tool is allowed to consult. At least one must stay on.'
          )}
        </p>
        <div className="grid gap-2 pt-1 sm:grid-cols-2">
          {MEMORY_SOURCE_OPTIONS.map((option) => {
            const checked = sources.includes(option.id);
            // Qdrant only stores the vectors mem0 semantic writes, so it can
            // never be the one source that is on.
            const qdrantNeedsSemantic = option.id === 'qdrant' && !sources.includes('mem0_semantic');
            const off = sourcesSaving || !connection || qdrantNeedsSemantic;
            return (
              <label
                key={option.id}
                className={`flex items-start gap-2 rounded-sm border border-border bg-secondary px-3 py-2 ${off ? 'opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-border bg-panel text-brand focus:ring-brand focus:ring-offset-0"
                  checked={checked}
                  disabled={off}
                  aria-label={t(option.labelKey, option.label)}
                  onChange={() => void toggleSource(option.id)}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-high">
                    {t(option.labelKey, option.label)}
                  </span>
                  <span className="block text-2xs text-low">
                    {t(option.descriptionKey, option.description)}
                  </span>
                  {option.implemented === false && (
                    <span className="mt-1 inline-block rounded-sm bg-warning/10 px-1.5 py-0.5 text-2xs text-warning">
                      {t('settings.memory.sourceNotImplemented', 'No backend support yet')}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        {sourcesError && (
          <p role="alert" className="text-xs text-warning">
            {sourcesError}
          </p>
        )}
        {sourcesSaving && (
          <p role="status" className="text-xs text-low">Saving…</p>
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
