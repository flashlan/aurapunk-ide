import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  CodeIcon,
  LockIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  SpinnerIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  BaseCodingAgent,
  type PipelineFileStatus,
  type PipelineValidation,
} from 'shared/types';
import { configApi, pipelinesApi } from '@/shared/lib/api';
import { useModelSelectorConfig } from '@/shared/hooks/useExecutorDiscovery';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { IconButton } from '@vibe/ui/components/IconButton';
import { SettingsCard, SettingsTextarea } from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';
import { cn } from '@/shared/lib/utils';
import { ModelSelectorPopover } from '@vibe/ui/components/ModelSelectorPopover';
import { DropdownMenuTriggerButton } from '@vibe/ui/components/Dropdown';
import { getResolvedTheme, useTheme } from '@/shared/hooks/useTheme';
import {
  getSelectedModel as getSelectedModelByProvider,
  parseModelId,
} from '@/shared/lib/modelSelector';

const BUNDLED_IDS = new Set([
  'swarm-multi-agent',
  'quick',
  'basic',
  'wikillm',
  'speckit',
  'async-claude-opus',
  'async-claude-sonnet',
  'async-claude-fable',
  'async-opencode-glm',
]);
const CORE_STAGE_IDS = new Set([
  'plan',
  'implement',
  'code-review',
  'manual-review',
  'merge',
  'spec',
  'test',
  'review',
  'verify',
  'deploy',
]);
const VALIDATE_DEBOUNCE_MS = 400;

const KNOWN_EXECUTORS = [
  { value: '', label: 'Default / Project Lead' },
  { value: 'antigravity', label: '🤖 Antigravity' },
  { value: 'claude', label: '🤖 Claude Code' },
  { value: 'codex', label: '🤖 Codex' },
  { value: 'opencode', label: '🤖 OpenCode' },
  { value: 'qwen_code', label: '🤖 Qwen Code' },
  { value: 'droid', label: '🤖 Droid' },
  { value: 'command_code', label: '🤖 Command Code' },
  { value: 'gemini', label: '🤖 Gemini' },
  { value: 'cursor', label: '🤖 Cursor Agent' },
  { value: 'copilot', label: '🤖 GitHub Copilot' },
  { value: 'amp', label: '🤖 Amp' },
  { value: 'local-executor', label: '⚡ Local Host Command' },
];

interface StageData {
  id: string;
  label: string;
  default_enabled?: boolean;
  heavy?: boolean;
  executor?: string;
  model?: string;
  reasoning_effort?: string;
  prompt?: string;
}

interface PipelineData {
  name: string;
  description?: string;
  stage?: StageData[];
}

function tomlToPipelineData(raw: string): PipelineData | null {
  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description:
        typeof parsed.description === 'string' ? parsed.description : '',
      stage: Array.isArray(parsed.stage)
        ? (parsed.stage as unknown[]).map((s) => {
            const item = (s ?? {}) as Record<string, unknown>;
            return {
              id: typeof item.id === 'string' ? item.id : 'stage',
              label: typeof item.label === 'string' ? item.label : 'Stage',
              default_enabled:
                typeof item.default_enabled === 'boolean'
                  ? item.default_enabled
                  : true,
              heavy: typeof item.heavy === 'boolean' ? item.heavy : false,
              executor:
                typeof item.executor === 'string' ? item.executor : undefined,
              model: typeof item.model === 'string' ? item.model : undefined,
              reasoning_effort:
                typeof item.reasoning_effort === 'string'
                  ? item.reasoning_effort
                  : undefined,
              prompt: typeof item.prompt === 'string' ? item.prompt : '',
            };
          })
        : [],
    };
  } catch {
    return null;
  }
}

function pipelineDataToToml(data: PipelineData): string {
  const clean: Record<string, unknown> = {
    name: data.name || 'Custom Pipeline',
  };
  if (data.description) {
    clean.description = data.description;
  }
  if (data.stage && data.stage.length > 0) {
    clean.stage = data.stage.map((st) => {
      const s: Record<string, unknown> = {
        id: st.id || 'stage',
        label: st.label || 'Stage',
        default_enabled: Boolean(st.default_enabled),
      };
      if (st.heavy) s.heavy = true;
      if (st.executor) s.executor = st.executor;
      if (st.model) s.model = st.model;
      if (st.reasoning_effort) s.reasoning_effort = st.reasoning_effort;
      if (st.prompt) s.prompt = st.prompt;
      return s;
    });
  }
  return stringifyToml(clean);
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function parseBaseCodingAgent(executor?: string): BaseCodingAgent | null {
  if (!executor) return null;
  const clean = executor.toLowerCase().replace(/[-_]/g, '');
  if (clean === 'antigravity') return BaseCodingAgent.ANTIGRAVITY;
  if (clean === 'claude' || clean === 'claudecode')
    return BaseCodingAgent.CLAUDE_CODE;
  if (clean === 'codex') return BaseCodingAgent.CODEX;
  if (clean === 'opencode') return BaseCodingAgent.OPENCODE;
  if (clean === 'qwencode' || clean === 'qwen')
    return BaseCodingAgent.QWEN_CODE;
  if (clean === 'droid') return BaseCodingAgent.DROID;
  if (clean === 'commandcode' || clean === 'cmd')
    return BaseCodingAgent.COMMAND_CODE;
  if (clean === 'gemini') return BaseCodingAgent.GEMINI;
  if (clean === 'cursor' || clean === 'cursoragent')
    return BaseCodingAgent.CURSOR_AGENT;
  if (clean === 'copilot') return BaseCodingAgent.COPILOT;
  if (clean === 'amp') return BaseCodingAgent.AMP;
  return null;
}

function StageModelInput({
  executor,
  model,
  index: _index,
  onChange,
}: {
  executor?: string;
  model?: string;
  index: number;
  onChange: (newModel: string | undefined) => void;
}) {
  const baseAgent = useMemo(() => parseBaseCodingAgent(executor), [executor]);
  const {
    config,
    loadingModels: streamLoading,
    error: streamError,
  } = useModelSelectorConfig(baseAgent);
  const { theme } = useTheme();
  const resolvedTheme = getResolvedTheme(theme);
  const [httpModels, setHttpModels] = useState<string[]>([]);
  const [httpLoading, setHttpLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedProviderId, setExpandedProviderId] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!executor) {
      setHttpModels([]);
      return;
    }
    let cancelled = false;
    setHttpLoading(true);
    configApi
      .getAgentModels(executor)
      .then((res) => {
        if (!cancelled && res && res.length > 0) {
          setHttpModels(res.map((m) => m.id));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setHttpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [executor]);

  const effectiveConfig = useMemo(() => {
    if (config && config.models.length > 0) return config;
    if (httpModels.length === 0) return config;
    // Build synthetic grouped config from flat http ids like "nvidia/nemotron-3.5-..."
    const providerMap = new Map<string, string>();
    const models = httpModels.map((rawId) => {
      const slash = rawId.indexOf('/');
      if (slash !== -1) {
        const providerId = rawId.slice(0, slash);
        const id = rawId.slice(slash + 1);
        if (!providerMap.has(providerId))
          providerMap.set(providerId, providerId);
        return { id, name: id, provider_id: providerId, reasoning_options: [] };
      }
      return {
        id: rawId,
        name: rawId,
        provider_id: null,
        reasoning_options: [],
      };
    });
    const providers = [...providerMap.keys()].map((id) => ({ id, name: id }));
    return {
      providers,
      models,
      default_model: config?.default_model ?? null,
      agents: config?.agents ?? [],
      permissions: config?.permissions ?? [],
    } as unknown as typeof config;
  }, [config, httpModels]);

  const hasProviders = (effectiveConfig?.providers.length ?? 0) > 0;
  const hasModels = (effectiveConfig?.models.length ?? 0) > 0;
  const loadingModels = streamLoading && httpLoading && !hasModels;
  const isLive = hasModels;

  const { providerId: parsedProviderId, modelId: parsedModelId } = useMemo(
    () => parseModelId(model, hasProviders),
    [model, hasProviders]
  );

  const providerIdMap = useMemo(() => {
    const ids = effectiveConfig?.providers.map((p) => p.id) ?? [];
    return new Map(ids.map((id) => [id.toLowerCase(), id]));
  }, [effectiveConfig?.providers]);

  const resolveProviderId = (value?: string | null) =>
    value ? (providerIdMap.get(value.toLowerCase()) ?? null) : null;

  const selectedProviderId = resolveProviderId(parsedProviderId);
  const selectedModelId = parsedModelId;

  const selectedModel = useMemo(() => {
    if (!effectiveConfig || !selectedModelId) return null;
    return getSelectedModelByProvider(
      effectiveConfig.models,
      selectedProviderId,
      selectedModelId
    );
  }, [effectiveConfig, selectedModelId, selectedProviderId]);

  const modelLabel = useMemo(() => {
    if (!model) return 'Default';
    if (selectedModel) return selectedModel.name || selectedModel.id;
    // Fallback to raw string when not in discovered list (custom)
    return model;
  }, [model, selectedModel]);

  const handleModelSelect = (modelId: string | null, providerId?: string) => {
    if (!modelId) {
      onChange(undefined);
      setIsOpen(false);
      return;
    }
    const value = providerId ? `${providerId}/${modelId}` : modelId;
    onChange(value);
    setIsOpen(false);
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open && effectiveConfig) {
      const fallback =
        selectedModel?.provider_id ??
        selectedProviderId ??
        effectiveConfig.providers[0]?.id ??
        '';
      setExpandedProviderId(fallback);
    } else {
      setSearchQuery('');
    }
  };

  // Sync expanded provider when selection changes while open
  useEffect(() => {
    if (!isOpen || !effectiveConfig) return;
    if (selectedModel?.provider_id) {
      setExpandedProviderId(selectedModel.provider_id);
    }
  }, [isOpen, effectiveConfig, selectedModel?.provider_id]);

  // Flat fallback when no grouped config available
  if (!hasModels && !loadingModels) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-low">Model (Live CLI Discovery)</label>
          <span className="text-[10px] text-low font-mono">Agent default</span>
        </div>
        <input
          type="text"
          value={model ?? ''}
          onChange={(e) =>
            onChange(e.target.value.trim() ? e.target.value.trim() : undefined)
          }
          className="w-full text-xs rounded-sm border border-border bg-secondary px-2 py-1.5 text-high font-mono"
          placeholder="Default (omit --model)"
        />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-low">Model (Live CLI Discovery)</label>
        {loadingModels ? (
          <span className="text-yellow-500 animate-pulse font-mono flex items-center gap-1">
            <span className="inline-block size-1.5 rounded-full bg-yellow-500 animate-ping" />
            Querying CLI...
          </span>
        ) : isLive ? (
          <span className="text-[10px] text-green-500 font-mono">
            ● {effectiveConfig?.models.length ?? 0} live models
          </span>
        ) : (
          <span className="text-[10px] text-low font-mono">Agent default</span>
        )}
      </div>
      {effectiveConfig && (
        <ModelSelectorPopover
          isOpen={isOpen}
          onOpenChange={handleOpenChange}
          trigger={
            <DropdownMenuTriggerButton
              size="sm"
              label={modelLabel}
              className="w-full justify-between text-xs font-mono bg-secondary border-border"
            />
          }
          config={effectiveConfig}
          error={streamError}
          selectedProviderId={selectedProviderId}
          selectedModelId={selectedModelId}
          selectedReasoningId={null}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onModelSelect={(id, providerId) => handleModelSelect(id, providerId)}
          onReasoningSelect={() => {}}
          showDefaultOption
          onSelectDefault={() => handleModelSelect(null)}
          scrollRef={scrollRef}
          expandedProviderId={expandedProviderId}
          onExpandedProviderIdChange={setExpandedProviderId}
          resolvedTheme={resolvedTheme}
        />
      )}
      {/* Keep freeform custom value visible when not in discovered list */}
      {model && !selectedModel && (
        <p
          className="mt-1 text-[10px] font-mono text-low truncate"
          title={model}
        >
          Custom: {model}
        </p>
      )}
    </div>
  );
}

export function PipelineSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);
  const { setDirty: setContextDirty } = useSettingsDirty();

  const [statuses, setStatuses] = useState<PipelineFileStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editorModeById, setEditorModeById] = useState<
    Record<string, 'visual' | 'raw'>
  >({});
  const [rawById, setRawById] = useState<Record<string, string>>({});
  const [draftById, setDraftById] = useState<Record<string, string>>({});
  const [validationById, setValidationById] = useState<
    Record<string, PipelineValidation>
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const draftRef = useRef(draftById);
  useEffect(() => {
    draftRef.current = draftById;
  }, [draftById]);

  const reload = useCallback(async () => {
    try {
      const list = await pipelinesApi.status();
      setStatuses(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, t('settings.pipeline.loadError')));
      setStatuses([]);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const hasUnsavedChanges = useMemo(
    () =>
      Object.keys(draftById).some(
        (id) => draftById[id] !== undefined && draftById[id] !== rawById[id]
      ),
    [draftById, rawById]
  );

  useEffect(() => {
    setContextDirty('pipeline', hasUnsavedChanges);
    return () => setContextDirty('pipeline', false);
  }, [hasUnsavedChanges, setContextDirty]);

  const flash = useCallback((message: string) => {
    setSuccess(message);
    setError(null);
    setTimeout(() => setSuccess(null), 3000);
  }, []);

  const toggleExpand = useCallback(
    async (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      if (rawById[id] === undefined) {
        try {
          const raw = await pipelinesApi.getRaw(id);
          setRawById((prev) => ({ ...prev, [id]: raw }));
          setDraftById((prev) => ({ ...prev, [id]: raw }));
        } catch (err) {
          setError(errorMessage(err, t('settings.pipeline.loadError')));
        }
      }
    },
    [expandedId, rawById, t]
  );

  useEffect(() => {
    if (!expandedId) return;
    const id = expandedId;
    const content = draftById[id];
    if (content === undefined) return;

    const timer = setTimeout(() => {
      void pipelinesApi
        .validate(id, content)
        .then((result) => {
          if (draftRef.current[id] !== content) return;
          setValidationById((prev) => ({ ...prev, [id]: result }));
        })
        .catch(() => {});
    }, VALIDATE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [expandedId, draftById]);

  const handleSave = useCallback(
    async (id: string) => {
      const content = draftById[id];
      if (content === undefined) return;
      setBusyId(id);
      setError(null);
      try {
        const validation = await pipelinesApi.validate(id, content);
        setValidationById((prev) => ({ ...prev, [id]: validation }));
        if (!validation.valid) {
          return;
        }
        await pipelinesApi.saveRaw(id, content);
        setRawById((prev) => ({ ...prev, [id]: content }));
        setValidationById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await reload();
        flash(t('settings.pipeline.saved'));
      } catch (err) {
        setError(errorMessage(err, t('settings.pipeline.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [draftById, reload, flash, t]
  );

  const handleResetOne = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        await pipelinesApi.resetOne(id);
        const raw = await pipelinesApi.getRaw(id);
        setRawById((prev) => ({ ...prev, [id]: raw }));
        setDraftById((prev) => ({ ...prev, [id]: raw }));
        setValidationById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await reload();
        flash(t('settings.pipeline.saved'));
      } catch (err) {
        setError(errorMessage(err, t('settings.pipeline.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [reload, flash, t]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        await pipelinesApi.remove(id);
        setRawById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setDraftById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setValidationById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        if (expandedId === id) setExpandedId(null);
        await reload();
        flash(t('settings.pipeline.saved'));
      } catch (err) {
        setError(errorMessage(err, t('settings.pipeline.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [expandedId, reload, flash, t]
  );

  const handleResetAll = useCallback(async () => {
    setBusyId('__all__');
    setError(null);
    try {
      await pipelinesApi.resetDefaults();
      setRawById({});
      setDraftById({});
      setValidationById({});
      setExpandedId(null);
      await reload();
      flash(t('settings.pipeline.saved'));
    } catch (err) {
      setError(errorMessage(err, t('settings.pipeline.saveError')));
    } finally {
      setBusyId(null);
    }
  }, [reload, flash, t]);

  const updateVisualPipeline = useCallback(
    (id: string, updater: (prev: PipelineData) => PipelineData) => {
      const currentRaw = draftById[id] ?? '';
      const currentData = tomlToPipelineData(currentRaw) ?? {
        name: id,
        stages: [],
      };
      const updated = updater(currentData);
      const newToml = pipelineDataToToml(updated);
      setDraftById((prev) => ({ ...prev, [id]: newToml }));
    },
    [draftById]
  );

  if (statuses === null && loadError === null) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <SpinnerIcon
          className="size-icon-lg animate-spin text-brand"
          weight="bold"
        />
        <span className="text-normal">{t('settings.pipeline.loading')}</span>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error whitespace-pre-wrap">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-success/10 border border-success/50 rounded-sm p-4 text-success font-medium">
          {success}
        </div>
      )}
      {loadError && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {loadError}
        </div>
      )}

      <SettingsCard
        title={t('settings.pipeline.files.title')}
        description={t('settings.pipeline.files.description')}
        headerAction={
          <PrimaryButton
            variant="tertiary"
            value={t('settings.pipeline.resetAll')}
            disabled={busyId === '__all__'}
            onClick={handleResetAll}
          />
        }
      >
        <div className="space-y-3">
          {statuses && statuses.length === 0 ? (
            <p className="text-sm text-low">{t('settings.pipeline.empty')}</p>
          ) : (
            statuses?.map((s) => {
              const isOpen = expandedId === s.id;
              const draft = draftById[s.id] ?? '';
              const isDirty =
                draftById[s.id] !== undefined &&
                draftById[s.id] !== rawById[s.id];
              const draftValidation = validationById[s.id];
              const draftInvalid = draftValidation?.valid === false;
              const editorMode = editorModeById[s.id] ?? 'visual';
              const parsedData = tomlToPipelineData(draft);
              const isBundled = BUNDLED_IDS.has(s.id);

              return (
                <div
                  key={s.id}
                  className="rounded-sm border border-border p-3 space-y-3 bg-panel/30"
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleExpand(s.id)}
                      className="flex items-center gap-half text-sm font-medium text-high flex-1 text-left"
                    >
                      {isOpen ? (
                        <CaretDownIcon className="size-icon-sm" weight="bold" />
                      ) : (
                        <CaretRightIcon
                          className="size-icon-sm"
                          weight="bold"
                        />
                      )}
                      <span>{s.name}</span>
                      {!s.valid && (
                        <span
                          className="text-xs px-half rounded-sm font-medium bg-error/15 text-error"
                          title={s.error?.message}
                        >
                          {t('settings.pipeline.invalidBadge')}
                        </span>
                      )}
                      <span className="text-xs text-low">
                        {t('settings.pipeline.stageCount', {
                          n: s.stage_count ?? 0,
                        })}
                      </span>
                    </button>
                    <IconButton
                      icon={TrashIcon}
                      aria-label={t('settings.pipeline.remove')}
                      title={t('settings.pipeline.remove')}
                      disabled={busyId === s.id}
                      onClick={() => handleRemove(s.id)}
                      className="hover:text-error hover:bg-error/10"
                    />
                  </div>

                  {isOpen && (
                    <div className="space-y-3 pt-2 border-t border-border/50">
                      {draftById[s.id] === undefined ? (
                        <div className="flex items-center gap-2 py-4 text-xs text-low">
                          <SpinnerIcon className="size-4 animate-spin text-brand" />
                          <span>Loading pipeline definition...</span>
                        </div>
                      ) : (
                        <>
                          {/* Prominent Editor Mode Selector */}
                          <div className="flex items-center justify-between bg-secondary/40 p-2 rounded-sm border border-border">
                            <span className="text-xs font-semibold text-high uppercase tracking-wide">
                              Editor Mode
                            </span>
                            <div className="inline-flex rounded-sm border border-border bg-panel p-0.5 text-xs shadow-xs">
                              <button
                                type="button"
                                onClick={() =>
                                  setEditorModeById((prev) => ({
                                    ...prev,
                                    [s.id]: 'visual',
                                  }))
                                }
                                className={cn(
                                  'flex items-center gap-1.5 px-3 py-1 rounded-sm font-medium transition-all cursor-pointer',
                                  editorMode === 'visual'
                                    ? 'bg-brand text-white shadow-xs font-semibold'
                                    : 'text-low hover:text-high hover:bg-secondary'
                                )}
                              >
                                <SlidersHorizontalIcon
                                  className="size-3.5"
                                  weight="bold"
                                />
                                Visual Form
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setEditorModeById((prev) => ({
                                    ...prev,
                                    [s.id]: 'raw',
                                  }))
                                }
                                className={cn(
                                  'flex items-center gap-1.5 px-3 py-1 rounded-sm font-medium transition-all cursor-pointer',
                                  editorMode === 'raw'
                                    ? 'bg-brand text-white shadow-xs font-semibold'
                                    : 'text-low hover:text-high hover:bg-secondary'
                                )}
                              >
                                <CodeIcon className="size-3.5" weight="bold" />
                                Raw TOML
                              </button>
                            </div>
                          </div>

                          {editorMode === 'visual' && parsedData ? (
                            <div className="space-y-4">
                              {/* Pipeline Meta */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-sm border border-border bg-panel/60">
                                <div>
                                  <label className="block text-xs font-medium text-low mb-1">
                                    Pipeline Name
                                  </label>
                                  <input
                                    type="text"
                                    value={parsedData.name}
                                    onChange={(e) =>
                                      updateVisualPipeline(s.id, (prev) => ({
                                        ...prev,
                                        name: e.target.value,
                                      }))
                                    }
                                    className="w-full text-sm rounded-sm border border-border bg-secondary px-2.5 py-1.5 text-high focus:outline-hidden focus:ring-1 focus:ring-brand"
                                    placeholder="e.g. Swarm Multi-Agent"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-low mb-1">
                                    Description
                                  </label>
                                  <input
                                    type="text"
                                    value={parsedData.description ?? ''}
                                    onChange={(e) =>
                                      updateVisualPipeline(s.id, (prev) => ({
                                        ...prev,
                                        description: e.target.value,
                                      }))
                                    }
                                    className="w-full text-sm rounded-sm border border-border bg-secondary px-2.5 py-1.5 text-high focus:outline-hidden focus:ring-1 focus:ring-brand"
                                    placeholder="Describe what this pipeline does"
                                  />
                                </div>
                              </div>

                              {/* Stages List */}
                              <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-semibold text-high uppercase tracking-wider">
                                    Stages (
                                    {parsedData.stage
                                      ? parsedData.stage.length
                                      : 0}
                                    )
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateVisualPipeline(s.id, (prev) => ({
                                        ...prev,
                                        stage: [
                                          ...(prev.stage ?? []),
                                          {
                                            id: `stage-${(prev.stage?.length ?? 0) + 1}`,
                                            label: `New Stage ${(prev.stage?.length ?? 0) + 1}`,
                                            default_enabled: true,
                                            heavy: false,
                                            executor: '',
                                            model: '',
                                            prompt:
                                              'Write your instructions here...',
                                          },
                                        ],
                                      }))
                                    }
                                    className="flex items-center gap-1 text-xs text-brand font-medium hover:underline"
                                  >
                                    <PlusIcon className="size-3.5" />
                                    Add Custom Stage
                                  </button>
                                </div>

                                {parsedData.stage?.map((st, idx) => (
                                  <div
                                    key={st.id || idx}
                                    className="rounded-sm border border-border p-3 space-y-3 bg-panel/70 relative"
                                  >
                                    <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
                                      <div className="flex items-center gap-2">
                                        <span className="flex items-center justify-center size-5 rounded-full bg-brand/15 text-brand text-xs font-semibold">
                                          {idx + 1}
                                        </span>
                                        <span className="text-sm font-medium text-high">
                                          {st.label ||
                                            st.id ||
                                            `Stage ${idx + 1}`}
                                        </span>
                                      </div>

                                      <div className="flex items-center gap-1">
                                        <IconButton
                                          icon={ArrowUpIcon}
                                          aria-label="Move Up"
                                          title="Move Up"
                                          disabled={idx === 0}
                                          onClick={() =>
                                            updateVisualPipeline(
                                              s.id,
                                              (prev) => {
                                                const nextStages = [
                                                  ...(prev.stage ?? []),
                                                ];
                                                const temp =
                                                  nextStages[idx - 1];
                                                nextStages[idx - 1] =
                                                  nextStages[idx];
                                                nextStages[idx] = temp;
                                                return {
                                                  ...prev,
                                                  stage: nextStages,
                                                };
                                              }
                                            )
                                          }
                                          className="size-6 text-low hover:text-high disabled:opacity-30"
                                        />
                                        <IconButton
                                          icon={ArrowDownIcon}
                                          aria-label="Move Down"
                                          title="Move Down"
                                          disabled={
                                            idx ===
                                            (parsedData.stage?.length ?? 0) - 1
                                          }
                                          onClick={() =>
                                            updateVisualPipeline(
                                              s.id,
                                              (prev) => {
                                                const nextStages = [
                                                  ...(prev.stage ?? []),
                                                ];
                                                const temp =
                                                  nextStages[idx + 1];
                                                nextStages[idx + 1] =
                                                  nextStages[idx];
                                                nextStages[idx] = temp;
                                                return {
                                                  ...prev,
                                                  stage: nextStages,
                                                };
                                              }
                                            )
                                          }
                                          className="size-6 text-low hover:text-high disabled:opacity-30"
                                        />
                                        <IconButton
                                          icon={TrashIcon}
                                          aria-label="Delete Stage"
                                          title="Delete Stage"
                                          onClick={() =>
                                            updateVisualPipeline(
                                              s.id,
                                              (prev) => ({
                                                ...prev,
                                                stage: (
                                                  prev.stage ?? []
                                                ).filter((_, i) => i !== idx),
                                              })
                                            )
                                          }
                                          className="size-6 text-error hover:bg-error/10"
                                        />
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                                      <div>
                                        <label className="flex items-center gap-1 text-low mb-1">
                                          {isBundled ||
                                          CORE_STAGE_IDS.has(st.id) ? (
                                            <>
                                              <LockIcon className="size-3 text-brand" />
                                              <span>Stage ID (Protected)</span>
                                            </>
                                          ) : (
                                            <span>Stage ID (Slug)</span>
                                          )}
                                        </label>
                                        <input
                                          type="text"
                                          value={st.id}
                                          disabled={
                                            isBundled ||
                                            CORE_STAGE_IDS.has(st.id)
                                          }
                                          readOnly={
                                            isBundled ||
                                            CORE_STAGE_IDS.has(st.id)
                                          }
                                          onChange={(e) => {
                                            const cleanSlug = e.target.value
                                              .toLowerCase()
                                              .replace(/[^a-z0-9_-]/g, '-');
                                            updateVisualPipeline(
                                              s.id,
                                              (prev) => {
                                                const nextStages = [
                                                  ...(prev.stage ?? []),
                                                ];
                                                nextStages[idx] = {
                                                  ...nextStages[idx],
                                                  id: cleanSlug,
                                                };
                                                return {
                                                  ...prev,
                                                  stage: nextStages,
                                                };
                                              }
                                            );
                                          }}
                                          className={cn(
                                            'w-full text-xs rounded-sm border border-border bg-secondary px-2 py-1.5 text-high',
                                            (isBundled ||
                                              CORE_STAGE_IDS.has(st.id)) &&
                                              'cursor-not-allowed opacity-60 bg-panel font-mono text-[11px]'
                                          )}
                                          title={
                                            isBundled ||
                                            CORE_STAGE_IDS.has(st.id)
                                              ? 'Stage ID is protected to ensure system and card compatibility.'
                                              : 'Unique stage identifier slug'
                                          }
                                          placeholder="e.g. plan, code-review"
                                        />
                                      </div>

                                      <div>
                                        <label className="block text-low mb-1">
                                          Label
                                        </label>
                                        <input
                                          type="text"
                                          value={st.label}
                                          onChange={(e) =>
                                            updateVisualPipeline(
                                              s.id,
                                              (prev) => {
                                                const nextStages = [
                                                  ...(prev.stage ?? []),
                                                ];
                                                nextStages[idx] = {
                                                  ...nextStages[idx],
                                                  label: e.target.value,
                                                };
                                                return {
                                                  ...prev,
                                                  stage: nextStages,
                                                };
                                              }
                                            )
                                          }
                                          className="w-full text-xs rounded-sm border border-border bg-secondary px-2 py-1.5 text-high"
                                          placeholder="e.g. 1. Architecture & Plan"
                                        />
                                      </div>

                                      <div>
                                        <label className="block text-low mb-1">
                                          Agent Executor
                                        </label>
                                        <select
                                          value={st.executor ?? ''}
                                          onChange={(e) => {
                                            const newExec =
                                              e.target.value || undefined;
                                            updateVisualPipeline(
                                              s.id,
                                              (prev) => {
                                                const nextStages = [
                                                  ...(prev.stage ?? []),
                                                ];
                                                nextStages[idx] = {
                                                  ...nextStages[idx],
                                                  executor: newExec,
                                                  model: undefined,
                                                };
                                                return {
                                                  ...prev,
                                                  stage: nextStages,
                                                };
                                              }
                                            );
                                          }}
                                          className="w-full text-xs rounded-sm border border-border bg-secondary px-2 py-1.5 text-high"
                                        >
                                          {KNOWN_EXECUTORS.map((ex) => (
                                            <option
                                              key={ex.value}
                                              value={ex.value}
                                            >
                                              {ex.label}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                                      <StageModelInput
                                        executor={st.executor}
                                        model={st.model}
                                        index={idx}
                                        onChange={(newModel) =>
                                          updateVisualPipeline(s.id, (prev) => {
                                            const nextStages = [
                                              ...(prev.stage ?? []),
                                            ];
                                            nextStages[idx] = {
                                              ...nextStages[idx],
                                              model: newModel,
                                            };
                                            return {
                                              ...prev,
                                              stage: nextStages,
                                            };
                                          })
                                        }
                                      />

                                      <div>
                                        <label className="block text-low mb-1">
                                          Reasoning Effort
                                        </label>
                                        <select
                                          value={st.reasoning_effort ?? ''}
                                          onChange={(e) =>
                                            updateVisualPipeline(
                                              s.id,
                                              (prev) => {
                                                const nextStages = [
                                                  ...(prev.stage ?? []),
                                                ];
                                                nextStages[idx] = {
                                                  ...nextStages[idx],
                                                  reasoning_effort:
                                                    e.target.value || undefined,
                                                };
                                                return {
                                                  ...prev,
                                                  stage: nextStages,
                                                };
                                              }
                                            )
                                          }
                                          className="w-full text-xs rounded-sm border border-border bg-secondary px-2 py-1.5 text-high"
                                        >
                                          <option value="">
                                            Default / Inherit
                                          </option>
                                          <option value="high">
                                            High (Deep Thinking)
                                          </option>
                                          <option value="medium">Medium</option>
                                          <option value="low">
                                            Low (Fast)
                                          </option>
                                        </select>
                                      </div>

                                      <div className="flex items-center gap-4 pt-4">
                                        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-normal">
                                          <input
                                            type="checkbox"
                                            checked={
                                              st.default_enabled !== false
                                            }
                                            onChange={(e) =>
                                              updateVisualPipeline(
                                                s.id,
                                                (prev) => {
                                                  const nextStages = [
                                                    ...(prev.stage ?? []),
                                                  ];
                                                  nextStages[idx] = {
                                                    ...nextStages[idx],
                                                    default_enabled:
                                                      e.target.checked,
                                                  };
                                                  return {
                                                    ...prev,
                                                    stage: nextStages,
                                                  };
                                                }
                                              )
                                            }
                                          />
                                          Default Enabled
                                        </label>

                                        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-normal">
                                          <input
                                            type="checkbox"
                                            checked={Boolean(st.heavy)}
                                            onChange={(e) =>
                                              updateVisualPipeline(
                                                s.id,
                                                (prev) => {
                                                  const nextStages = [
                                                    ...(prev.stage ?? []),
                                                  ];
                                                  nextStages[idx] = {
                                                    ...nextStages[idx],
                                                    heavy: e.target.checked,
                                                  };
                                                  return {
                                                    ...prev,
                                                    stage: nextStages,
                                                  };
                                                }
                                              )
                                            }
                                          />
                                          Heavy Stage
                                        </label>
                                      </div>
                                    </div>

                                    <div>
                                      <label className="block text-xs text-low mb-1">
                                        Stage Prompt Fragment
                                      </label>
                                      <textarea
                                        value={st.prompt ?? ''}
                                        rows={3}
                                        onChange={(e) =>
                                          updateVisualPipeline(s.id, (prev) => {
                                            const nextStages = [
                                              ...(prev.stage ?? []),
                                            ];
                                            nextStages[idx] = {
                                              ...nextStages[idx],
                                              prompt: e.target.value,
                                            };
                                            return {
                                              ...prev,
                                              stage: nextStages,
                                            };
                                          })
                                        }
                                        className="w-full rounded-sm border border-border bg-secondary p-2 text-xs font-mono text-high focus:outline-hidden focus:ring-1 focus:ring-brand"
                                        placeholder="Write instructions given to the agent for this specific stage..."
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <SettingsTextarea
                                value={draft}
                                rows={14}
                                onChange={(value) =>
                                  setDraftById((prev) => ({
                                    ...prev,
                                    [s.id]: value,
                                  }))
                                }
                                placeholder={t(
                                  'settings.pipeline.rawPlaceholder'
                                )}
                              />
                            </div>
                          )}

                          {draftInvalid && draftValidation?.error && (
                            <div className="text-sm text-error bg-error/10 border border-error/50 rounded-sm p-2">
                              <span className="font-medium">
                                {t('settings.pipeline.parseError')}:
                              </span>{' '}
                              {draftValidation.error.message}
                              {draftValidation.error.line != null && (
                                <span className="text-low">
                                  {' '}
                                  (
                                  {t('settings.pipeline.errorAt', {
                                    line: draftValidation.error.line,
                                    column: draftValidation.error.column ?? 1,
                                  })}
                                  )
                                </span>
                              )}
                            </div>
                          )}

                          <div className="flex items-center gap-2 pt-2">
                            <PrimaryButton
                              value={t('settings.pipeline.saveButton')}
                              disabled={
                                !isDirty || busyId === s.id || draftInvalid
                              }
                              onClick={() => handleSave(s.id)}
                            />
                            {BUNDLED_IDS.has(s.id) && (
                              <PrimaryButton
                                variant="tertiary"
                                value={t('settings.pipeline.reset')}
                                disabled={busyId === s.id}
                                onClick={() => handleResetOne(s.id)}
                              />
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </SettingsCard>
    </>
  );
}
