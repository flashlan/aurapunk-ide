import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpenIcon,
  BirdIcon,
  CheckIcon,
  CowIcon,
  DeviceMobileIcon,
  DownloadSimpleIcon,
  GithubLogoIcon,
  MusicNoteIcon,
  MusicNotesIcon,
  SpeakerHighIcon,
  SpeakerXIcon,
  WarningIcon,
  WaveformIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  BaseCodingAgent,
  EditorType,
  SoundFile,
  type AvailabilityInfo,
  type EditorConfig,
} from 'shared/types';
import { configApi } from '@/shared/lib/api';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { AgentIcon, getAgentName } from '@/shared/components/AgentIcon';
import { IdeIcon } from '@/shared/components/IdeIcon';
import { getIdeName } from '@/shared/lib/ideName';
import { cn, playSound } from '@/shared/lib/utils';
import { isTauriApp } from '@/shared/lib/platform';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';

type SoundOption = {
  value: SoundFile;
  label: string;
  icon: Icon;
};

const SOUND_OPTIONS: SoundOption[] = [
  {
    value: SoundFile.ABSTRACT_SOUND1,
    label: 'Abstract Sound 1',
    icon: WaveformIcon,
  },
  {
    value: SoundFile.ABSTRACT_SOUND2,
    label: 'Abstract Sound 2',
    icon: MusicNoteIcon,
  },
  {
    value: SoundFile.ABSTRACT_SOUND3,
    label: 'Abstract Sound 3',
    icon: MusicNotesIcon,
  },
  {
    value: SoundFile.ABSTRACT_SOUND4,
    label: 'Abstract Sound 4',
    icon: SpeakerHighIcon,
  },
  {
    value: SoundFile.COW_MOOING,
    label: 'Cow Mooing',
    icon: CowIcon,
  },
  {
    value: SoundFile.PHONE_VIBRATION,
    label: 'Phone Vibration',
    icon: DeviceMobileIcon,
  },
  {
    value: SoundFile.ROOSTER,
    label: 'Rooster',
    icon: BirdIcon,
  },
];

const AGENT_PRIORITY: BaseCodingAgent[] = [
  BaseCodingAgent.CLAUDE_CODE,
  BaseCodingAgent.CODEX,
  BaseCodingAgent.OPENCODE,
  BaseCodingAgent.GEMINI,
];

const SOCIAL_LINKS = [
  {
    label: 'GitHub',
    href: 'https://github.com/flashlan/aurapunk-ide',
    icon: GithubLogoIcon,
  },
  {
    label: 'Docs',
    href: 'https://www.vibekanban.com/docs',
    icon: BookOpenIcon,
  },
];

const AGENT_DOWNLOAD_LINKS: Partial<Record<BaseCodingAgent, string>> = {
  [BaseCodingAgent.CLAUDE_CODE]:
    'https://docs.anthropic.com/en/docs/claude-code/overview',
  [BaseCodingAgent.CLAUDE_CODE_HEADED]:
    'https://docs.anthropic.com/en/docs/claude-code/overview',
  [BaseCodingAgent.CODEX]: 'https://github.com/openai/codex',
  [BaseCodingAgent.OPENCODE]: 'https://opencode.ai/docs/',
  [BaseCodingAgent.OPENCODE_HEADED]: 'https://opencode.ai/docs/',
  [BaseCodingAgent.GEMINI]: 'https://github.com/google-gemini/gemini-cli',
  [BaseCodingAgent.AMP]: 'https://ampcode.com/',
  [BaseCodingAgent.CURSOR_AGENT]: 'https://www.cursor.com/downloads',
  [BaseCodingAgent.QWEN_CODE]: 'https://github.com/QwenLM/Qwen3-Coder',
  [BaseCodingAgent.COPILOT]: 'https://github.com/features/copilot',
  [BaseCodingAgent.DROID]: 'https://www.factory.ai/',
  [BaseCodingAgent.COMMAND_CODE]: 'https://commandcode.ai/',
};

const EDITOR_DOWNLOAD_LINKS: Partial<Record<EditorType, string>> = {
  [EditorType.VS_CODE]: 'https://code.visualstudio.com/download',
  [EditorType.VS_CODE_INSIDERS]: 'https://code.visualstudio.com/insiders/',
  [EditorType.CURSOR]: 'https://www.cursor.com/downloads',
  [EditorType.WINDSURF]: 'https://windsurf.com/download',
  [EditorType.INTELLI_J]: 'https://www.jetbrains.com/idea/download/',
  [EditorType.ZED]: 'https://zed.dev/download',
  [EditorType.XCODE]: 'https://developer.apple.com/xcode/',
};

function randomDefaultSoundFile(): SoundFile {
  const randomIndex = Math.floor(Math.random() * SOUND_OPTIONS.length);
  return SOUND_OPTIONS[randomIndex]?.value ?? SoundFile.COW_MOOING;
}

function isAgentInstalled(info: AvailabilityInfo | undefined): boolean {
  return info?.type === 'LOGIN_DETECTED' || info?.type === 'INSTALLATION_FOUND';
}

export function LandingPage() {
  const appNavigation = useAppNavigation();
  const { config, environment, updateAndSaveConfig, loading } = useUserSystem();

  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<BaseCodingAgent>(
    BaseCodingAgent.CLAUDE_CODE
  );
  const [editorType, setEditorType] = useState<EditorType>(EditorType.VS_CODE);
  const [customCommand, setCustomCommand] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundFile, setSoundFile] = useState<SoundFile>(randomDefaultSoundFile);
  const [agentAvailability, setAgentAvailability] = useState<
    Partial<Record<BaseCodingAgent, AvailabilityInfo>>
  >({});
  const [editorAvailability, setEditorAvailability] = useState<
    Partial<Record<EditorType, boolean>>
  >({});
  const [installingTool, setInstallingTool] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const hasRedirectedToRootRef = useRef(false);

  const logoSrc = '/aurapunk-ide-logo.png';

  useEffect(() => {
    let cancelled = false;

    const refreshAvailability = async () => {
      const agents = Object.values(BaseCodingAgent);
      const editors = Object.values(EditorType).filter(
        (editor) => editor !== EditorType.CUSTOM
      );

      const [agentResults, editorResults] = await Promise.all([
        Promise.all(
          agents.map(async (agent) => {
            try {
              return [
                agent,
                await configApi.checkAgentAvailability(agent),
              ] as const;
            } catch {
              return [agent, undefined] as const;
            }
          })
        ),
        Promise.all(
          editors.map(async (editor) => {
            try {
              const result = await configApi.checkEditorAvailability(editor);
              return [editor, result.available] as const;
            } catch {
              return [editor, false] as const;
            }
          })
        ),
      ]);

      if (cancelled) return;

      setAgentAvailability(Object.fromEntries(agentResults));
      setEditorAvailability(Object.fromEntries(editorResults));
      setAvailabilityReady(true);
    };

    void refreshAvailability();
    const interval = window.setInterval(() => {
      void refreshAvailability();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!config || initialized) return;

    setSelectedAgent(config.executor_profile.executor);
    setEditorType(config.editor.editor_type);
    setCustomCommand(config.editor.custom_command || '');
    setInitialized(true);
  }, [config, initialized]);

  useEffect(() => {
    if (
      !config?.remote_onboarding_acknowledged ||
      hasRedirectedToRootRef.current
    ) {
      return;
    }

    hasRedirectedToRootRef.current = true;
    appNavigation.goToRoot({ replace: true });
  }, [appNavigation, config?.remote_onboarding_acknowledged]);

  const executorOptions = useMemo(() => {
    const compareAgents = (a: BaseCodingAgent, b: BaseCodingAgent) => {
      const priorityA = AGENT_PRIORITY.indexOf(a);
      const priorityB = AGENT_PRIORITY.indexOf(b);
      const hasPriorityA = priorityA !== -1;
      const hasPriorityB = priorityB !== -1;

      if (hasPriorityA && hasPriorityB) {
        return priorityA - priorityB;
      }
      if (hasPriorityA) return -1;
      if (hasPriorityB) return 1;

      return getAgentName(a).localeCompare(getAgentName(b));
    };

    return [...Object.values(BaseCodingAgent)].sort(compareAgents);
  }, []);

  const editorOptions = useMemo(() => [...Object.values(EditorType)], []);

  const environmentType = environment?.os_type?.toLowerCase() ?? '';
  const isLinuxEnvironment =
    /linux|debian|ubuntu|fedora|arch|alpine|centos|rhel|rocky|alma|suse|opensuse|mint/.test(
      environmentType
    );
  const supportsGraphicalEditorInstall = !isLinuxEnvironment;

  useEffect(() => {
    if (!availabilityReady) return;

    if (
      executorOptions.length > 0 &&
      !executorOptions.includes(selectedAgent)
    ) {
      setSelectedAgent(executorOptions[0]);
    }

    if (editorOptions.length > 0 && !editorOptions.includes(editorType)) {
      setEditorType(editorOptions[0]);
    }
  }, [
    availabilityReady,
    editorOptions,
    editorType,
    executorOptions,
    selectedAgent,
  ]);

  const previewSound = async (value: SoundFile) => {
    try {
      await playSound(`/api/sounds/${value}`);
    } catch (err) {
      console.error('Failed to play sound:', err);
    }
  };

  const openExternalLink = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const installTool = async (
    kind: 'agent' | 'editor',
    id: BaseCodingAgent | EditorType,
    name: string
  ) => {
    const key = `${kind}:${id}`;
    setInstallingTool(key);
    setInstallError(null);

    try {
      await configApi.installTool(kind, id);
      if (kind === 'agent') {
        setAgentAvailability((current) => ({
          ...current,
          [id as BaseCodingAgent]: { type: 'INSTALLATION_FOUND' },
        }));
      } else {
        setEditorAvailability((current) => ({
          ...current,
          [id as EditorType]: true,
        }));
      }
    } catch (error) {
      setInstallError(
        error instanceof Error
          ? error.message
          : `Could not install ${name}. Check the environment and try again.`
      );
    } finally {
      setInstallingTool(null);
    }
  };

  const handleSoundSelect = (value: SoundFile) => {
    setSoundEnabled(true);
    setSoundFile(value);
    void previewSound(value);
  };

  const isCustomEditorValid =
    editorType !== EditorType.CUSTOM || customCommand.trim() !== '';
  const hasInstalledAgent = isAgentInstalled(agentAvailability[selectedAgent]);
  const hasInstalledEditor =
    isLinuxEnvironment ||
    editorType === EditorType.CUSTOM ||
    editorAvailability[editorType] === true;
  const canContinue =
    !saving && isCustomEditorValid && hasInstalledAgent && hasInstalledEditor;

  const handleContinue = async () => {
    if (!config || !canContinue) return;

    const editorConfig: EditorConfig = {
      editor_type: editorType,
      custom_command:
        editorType === EditorType.CUSTOM ? customCommand.trim() : null,
      remote_ssh_host: null,
      remote_ssh_user: null,
      auto_install_extension: true,
    };

    setSaving(true);
    const success = await updateAndSaveConfig({
      onboarding_acknowledged: true,
      remote_onboarding_acknowledged: true,
      disclaimer_acknowledged: true,
      executor_profile: {
        executor: selectedAgent,
        variant: null,
      },
      editor: editorConfig,
      notifications: {
        ...config.notifications,
        sound_enabled: soundEnabled,
        sound_file: soundFile,
      },
    });
    setSaving(false);

    if (success) {
      appNavigation.goToRoot({
        replace: true,
      });
      return;
    }
  };

  if (loading || !config || !initialized) {
    return (
      <div className="h-screen bg-primary flex items-center justify-center">
        <p className="text-low">Loading...</p>
      </div>
    );
  }

  if (config.remote_onboarding_acknowledged) {
    return null;
  }

  return (
    <div className="h-screen bg-primary flex items-center justify-center p-double">
      {isTauriApp() && (
        <div
          data-tauri-drag-region
          className="fixed inset-x-0 top-0 h-10 z-10"
        />
      )}
      <div className="flex max-h-full w-full max-w-5xl flex-col rounded-sm border border-border bg-secondary">
        {/* Header */}
        <header className="shrink-0 space-y-base p-double pb-base">
          <div className="flex items-center justify-between">
            <img src={logoSrc} alt="Aurapunk IDE" className="h-8 w-auto logo" />
            <div className="flex flex-wrap items-center gap-2">
              {SOCIAL_LINKS.map((link) => (
                <PrimaryButton
                  key={link.label}
                  value={link.label}
                  variant="tertiary"
                  actionIcon={link.icon}
                  onClick={() => openExternalLink(link.href)}
                />
              ))}
            </div>
          </div>
          <div className="rounded-sm border border-brand bg-brand/20 p-base">
            <div className="flex items-start gap-base">
              <WarningIcon
                className="size-icon-sm text-brand shrink-0 mt-[2px]"
                weight="fill"
              />
              <p className="text-sm text-normal">
                Aurapunk IDE runs AI coding agents with{' '}
                <code>--dangerously-skip-permissions</code> /{' '}
                <code>--yolo</code> by default. Always review what agents are
                doing.{' '}
                <a
                  href="https://www.vibekanban.com/docs/getting-started#safety-notice"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:underline"
                >
                  Learn more
                </a>
                .
              </p>
            </div>
          </div>
        </header>

        {/* 3-column grid */}
        <div className="min-h-0 flex-1 overflow-y-auto px-double pb-double">
          <div className="grid grid-cols-3 gap-double">
            {/* Column 1: Coding Agent */}
            <section className="space-y-half">
              <div className="flex items-center justify-between gap-base">
                <h2 className="text-sm font-medium text-high">Coding Agent</h2>
                <span className="text-xs text-low">
                  {availabilityReady ? 'Installed' : 'Detecting...'}
                </span>
              </div>
              <div className="grid gap-1.5">
                {executorOptions.map((agent) => {
                  const selected = selectedAgent === agent;
                  const toolKey = `agent:${agent}`;
                  const installed = isAgentInstalled(agentAvailability[agent]);

                  return (
                    <div
                      key={agent}
                      onClick={() => setSelectedAgent(agent)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedAgent(agent);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      className={cn(
                        'flex items-center gap-base rounded-sm border px-base py-half text-left',
                        selected
                          ? 'border-brand bg-brand/10'
                          : 'border-border bg-panel hover:bg-primary'
                      )}
                    >
                      <AgentIcon
                        agent={agent}
                        className="size-icon-xl shrink-0"
                      />
                      <span className="text-sm text-normal flex-1 truncate">
                        {getAgentName(agent)}
                      </span>
                      {AGENT_DOWNLOAD_LINKS[agent] && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void installTool(
                              'agent',
                              agent,
                              getAgentName(agent)
                            );
                          }}
                          disabled={installingTool !== null}
                          className="inline-flex shrink-0 items-center gap-1 text-xs text-brand hover:underline disabled:cursor-wait disabled:opacity-60"
                          aria-label={`${installed ? 'Reinstall' : 'Install'} ${getAgentName(agent)}`}
                        >
                          <DownloadSimpleIcon className="size-icon-xs" />
                          {installingTool === toolKey
                            ? 'Installing...'
                            : installed
                              ? 'Installed'
                              : 'Install'}
                        </button>
                      )}
                      {selected && (
                        <CheckIcon
                          className="size-icon-xs text-brand shrink-0"
                          weight="bold"
                        />
                      )}
                    </div>
                  );
                })}
                {availabilityReady && executorOptions.length === 0 && (
                  <p className="rounded-sm border border-border bg-panel p-base text-xs text-low">
                    No supported coding-agent CLI was detected. Install one and
                    it will appear automatically.
                  </p>
                )}
              </div>
              <p className="text-xs text-low">
                Install runs the official package installer inside this
                environment. Authentication is still performed with the CLI.
              </p>
            </section>

            {/* Column 2: Code Editor */}
            <section className="space-y-half">
              <div className="flex items-center justify-between gap-base">
                <h2 className="text-sm font-medium text-high">Code Editor</h2>
                <span className="text-xs text-low">
                  {availabilityReady ? 'Installed' : 'Detecting...'}
                </span>
              </div>
              <div className="grid gap-1.5">
                {editorOptions.map((editor) => {
                  const selected = editorType === editor;
                  const toolKey = `editor:${editor}`;
                  const installed =
                    editor === EditorType.CUSTOM ||
                    editorAvailability[editor] === true;

                  return (
                    <div
                      key={editor}
                      onClick={() => setEditorType(editor)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setEditorType(editor);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      className={cn(
                        'flex items-center gap-base rounded-sm border px-base py-half text-left',
                        selected
                          ? 'border-brand bg-brand/10'
                          : 'border-border bg-panel hover:bg-primary'
                      )}
                    >
                      <IdeIcon
                        editorType={editor}
                        className="size-icon-sm shrink-0"
                      />
                      <span className="text-sm text-normal flex-1 truncate">
                        {getIdeName(editor)}
                      </span>
                      {EDITOR_DOWNLOAD_LINKS[editor] &&
                        supportsGraphicalEditorInstall && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void installTool(
                                'editor',
                                editor,
                                getIdeName(editor)
                              );
                            }}
                            disabled={installingTool !== null}
                            className="inline-flex shrink-0 items-center gap-1 text-xs text-brand hover:underline disabled:cursor-wait disabled:opacity-60"
                            aria-label={`${installed ? 'Reinstall' : 'Install'} ${getIdeName(editor)}`}
                          >
                            <DownloadSimpleIcon className="size-icon-xs" />
                            {installingTool === toolKey
                              ? 'Installing...'
                              : installed
                                ? 'Installed'
                                : 'Install'}
                          </button>
                        )}
                      {EDITOR_DOWNLOAD_LINKS[editor] &&
                        !supportsGraphicalEditorInstall && (
                          <span className="text-xs text-low">CLI-first</span>
                        )}
                      {selected && (
                        <CheckIcon
                          className="size-icon-xs text-brand shrink-0"
                          weight="bold"
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {editorType === EditorType.CUSTOM && (
                <div className="space-y-half">
                  <label className="text-sm font-medium text-normal">
                    Custom Command
                  </label>
                  <input
                    type="text"
                    value={customCommand}
                    onChange={(e) => setCustomCommand(e.target.value)}
                    placeholder="e.g. code --wait"
                    className={cn(
                      'w-full bg-panel border rounded-sm px-base py-half text-sm text-high',
                      'placeholder:text-low placeholder:opacity-80 focus:outline-none',
                      'focus:ring-1 focus:ring-brand',
                      customCommand.trim() === ''
                        ? 'border-warning/60'
                        : 'border-border'
                    )}
                  />
                </div>
              )}
              <p className="text-xs text-low">
                {isLinuxEnvironment
                  ? 'Cloud/Linux workspaces are CLI-first; graphical editors are optional and are not installed automatically.'
                  : 'Graphical editors are installed on this machine when a supported package manager is available.'}
              </p>
              {installError && (
                <p className="rounded-sm border border-warning/60 bg-warning/10 p-base text-xs text-warning">
                  {installError}
                </p>
              )}
            </section>

            {/* Column 3: Notification Sound */}
            <section className="space-y-half">
              <h2 className="text-sm font-medium text-high">
                Notification Sound
              </h2>
              <div className="grid gap-1.5">
                {SOUND_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = soundEnabled && soundFile === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => handleSoundSelect(option.value)}
                      className={cn(
                        'flex items-center gap-base rounded-sm border px-base py-half text-left',
                        selected
                          ? 'border-brand bg-brand/10'
                          : 'border-border bg-panel hover:bg-primary'
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-icon-sm shrink-0',
                          selected ? 'text-brand' : 'text-normal'
                        )}
                        weight={selected ? 'fill' : 'bold'}
                      />
                      <span className="text-sm text-normal flex-1 truncate">
                        {option.label}
                      </span>
                      {selected && (
                        <CheckIcon
                          className="size-icon-xs text-brand shrink-0"
                          weight="bold"
                        />
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setSoundEnabled(false)}
                  className={cn(
                    'flex items-center gap-base rounded-sm border px-base py-half text-left',
                    !soundEnabled
                      ? 'border-brand bg-brand/10'
                      : 'border-border bg-panel hover:bg-primary'
                  )}
                >
                  <SpeakerXIcon
                    className={cn(
                      'size-icon-sm shrink-0',
                      !soundEnabled ? 'text-brand' : 'text-normal'
                    )}
                    weight={!soundEnabled ? 'fill' : 'bold'}
                  />
                  <span className="text-sm text-normal flex-1">No sound</span>
                  {!soundEnabled && (
                    <CheckIcon
                      className="size-icon-xs text-brand shrink-0"
                      weight="bold"
                    />
                  )}
                </button>
              </div>
            </section>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border p-double pt-base flex items-center justify-between gap-base">
          <p className="text-xs text-low">
            By continuing you agree to the{' '}
            <a
              href="https://www.vibekanban.com/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand hover:underline"
            >
              terms and conditions
            </a>{' '}
            and{' '}
            <a
              href="https://www.vibekanban.com/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand hover:underline"
            >
              privacy policy
            </a>
            .
          </p>
          <PrimaryButton
            value={saving ? 'Saving...' : 'Continue'}
            onClick={handleContinue}
            disabled={!canContinue}
          />
        </div>
      </div>
    </div>
  );
}
