import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircleIcon } from '@phosphor-icons/react';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { SettingsCard, SettingsSelect } from './SettingsComponents';
import { useProjects } from '@/shared/hooks/useProjects';
import { makeRequest } from '@/shared/lib/remoteApi';

interface SdlcStatusPreview {
  name: string;
  color: string;
  isTerminal: boolean;
}

/**
 * Display-only mirror of the backend SDLC preset
 * (`services::project_config::SDLC_STATUS_PRESET`) so the Settings section can
 * preview the columns before injecting them. The actual injection is performed
 * by the backend endpoint — this list is never used to create statuses.
 */
const SDLC_STATUS_PREVIEW: SdlcStatusPreview[] = [
  { name: 'planning', color: '#64748b', isTerminal: false },
  { name: 'development', color: '#3b82f6', isTerminal: false },
  { name: 'testing', color: '#f59e0b', isTerminal: false },
  { name: 'review', color: '#a855f7', isTerminal: false },
  { name: 'iteration', color: '#06b6d4', isTerminal: false },
  { name: 'deployment', color: '#22c55e', isTerminal: true },
];

interface InjectSdlcStatusesResponse {
  added: number;
}

async function injectSdlcStatuses(projectId: string): Promise<number> {
  const response = await makeRequest('/api/project-statuses/inject-sdlc', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId }),
  });
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    message?: string;
    data?: InjectSdlcStatusesResponse;
  } | null;
  if (!response.ok || !body?.success) {
    throw new Error(body?.message ?? 'Failed to inject statuses');
  }
  return body.data?.added ?? 0;
}

export function StatusesSettingsSection() {
  const { t } = useTranslation('settings');
  const { data: projects = [], isLoading } = useProjects();
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectOptions = useMemo(
    () =>
      [...projects]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((project) => ({ value: project.id, label: project.name })),
    [projects]
  );

  const handleInject = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const added = await injectSdlcStatuses(projectId);
      setResult(
        added === 0
          ? t(
              'settings.statuses.preset.alreadyPresent',
              'All SDLC statuses are already present on this project.'
            )
          : t('settings.statuses.preset.added', {
              count: added,
              defaultValue: 'Added {{count}} SDLC statuses.',
            })
      );
    } catch (err) {
      setError(
        t('settings.statuses.preset.error', {
          error: err instanceof Error ? err.message : String(err),
          defaultValue: 'Failed to inject statuses: {{error}}',
        })
      );
    } finally {
      setBusy(false);
    }
  }, [projectId, t]);

  return (
    <div className="space-y-2">
      <p className="pb-2 text-sm text-low">
        {t(
          'settings.statuses.subtitle',
          'Add a pre-fabricated SDLC set of card statuses to a project. They become available in every card status picker of that project.'
        )}
      </p>
      <SettingsCard
        title={t('settings.statuses.preset.title', 'SDLC status preset')}
        description={t(
          'settings.statuses.preset.description',
          'Inject planning, development, testing, review, iteration and deployment as board columns for the selected project. Existing statuses are kept and duplicates are skipped.'
        )}
        headerAction={
          <PrimaryButton
            value={t('settings.statuses.preset.button', 'Inject SDLC statuses')}
            onClick={handleInject}
            disabled={!projectId || busy}
            actionIcon={busy ? 'spinner' : undefined}
          />
        }
      >
        <SettingsSelect
          value={projectId}
          options={projectOptions}
          onChange={setProjectId}
          disabled={isLoading}
          placeholder={t(
            'settings.statuses.preset.projectPlaceholder',
            'Select a project'
          )}
        />

        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          {SDLC_STATUS_PREVIEW.map((preset) => (
            <li
              key={preset.name}
              className="flex items-center gap-2 text-sm text-normal"
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: preset.color }}
              />
              <span>{preset.name}</span>
              {preset.isTerminal && (
                <span
                  title={t('settings.statuses.preset.terminal', 'Terminal')}
                  aria-label={t(
                    'settings.statuses.preset.terminal',
                    'Terminal'
                  )}
                >
                  <CheckCircleIcon className="size-3 text-low" />
                </span>
              )}
            </li>
          ))}
        </ul>

        {result && <p className="text-sm text-success">{result}</p>}
        {error && <p className="text-sm text-error">{error}</p>}
      </SettingsCard>
    </div>
  );
}
