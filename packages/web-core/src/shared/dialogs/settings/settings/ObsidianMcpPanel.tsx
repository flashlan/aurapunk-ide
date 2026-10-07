import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircleIcon,
  FloppyDiskIcon,
  FolderOpenIcon,
} from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import type { BaseCodingAgent, McpConfig } from 'shared/types';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { McpConfigStrategyGeneral } from '@/shared/lib/mcpStrategies';
import { toPrettyCase } from '@/shared/lib/string';
import { useSettingsMachineClient } from './SettingsHostContext';
import { SettingsCheckbox, SettingsField } from './SettingsComponents';
import { FolderPickerDialog } from '@/shared/dialogs/shared/FolderPickerDialog';
import {
  createObsidianMcpServer,
  isAbsoluteVaultPath,
  isValidVaultId,
  readObsidianMcpSettings,
} from './obsidianMcpConfig';

type ProfileConfig = {
  agent: BaseCodingAgent;
  mcpConfig: McpConfig;
};

function configuredServers(config: McpConfig) {
  return McpConfigStrategyGeneral.extractServersForApi(
    config,
    McpConfigStrategyGeneral.createFullConfig(config)
  );
}

export function ObsidianMcpPanel() {
  const { profiles } = useUserSystem();
  const machineClient = useSettingsMachineClient();
  const [profileConfigs, setProfileConfigs] = useState<ProfileConfig[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<Set<BaseCodingAgent>>(
    new Set()
  );
  const [vaultPath, setVaultPath] = useState('');
  const [vaultId, setVaultId] = useState('aurapunk');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const profileAgents = useMemo(
    () => (profiles ? (Object.keys(profiles) as BaseCodingAgent[]) : []),
    [profiles]
  );

  useEffect(() => {
    if (!machineClient || profileAgents.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const results = await Promise.all(
        profileAgents.map(async (agent): Promise<ProfileConfig | null> => {
          try {
            const response = await machineClient.loadMcpServers({
              executor: agent,
            });
            return { agent, mcpConfig: response.mcp_config };
          } catch {
            // Some installed executors intentionally do not support MCP.
            return null;
          }
        })
      );
      if (cancelled) return;
      const supported = results.filter(
        (result): result is ProfileConfig => result !== null
      );
      setProfileConfigs(supported);

      const configured = supported
        .map(({ agent, mcpConfig }) => ({
          agent,
          settings: readObsidianMcpSettings(configuredServers(mcpConfig)),
        }))
        .filter((entry) => entry.settings !== null);
      const first = configured[0]?.settings;
      if (first) {
        setVaultPath(first.vaultPath);
        setVaultId(first.vaultId);
      }
      setSelectedAgents(
        new Set(
          configured.length > 0
            ? configured.map((entry) => entry.agent)
            : supported.map((entry) => entry.agent)
        )
      );
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [machineClient, profileAgents]);

  const vaultError = !vaultPath.trim()
    ? 'Choose the absolute path to an existing Obsidian vault.'
    : !isAbsoluteVaultPath(vaultPath.trim())
      ? 'The vault path must be absolute.'
      : null;
  const vaultIdError = isValidVaultId(vaultId)
    ? null
    : 'Use lowercase letters, numbers, hyphens, or underscores; the first character must be a letter.';

  const toggleAgent = (agent: BaseCodingAgent, checked: boolean) => {
    setSelectedAgents((current) => {
      const next = new Set(current);
      if (checked) next.add(agent);
      else next.delete(agent);
      return next;
    });
  };

  const chooseVaultFolder = async () => {
    const selectedPath = await FolderPickerDialog.show({
      value: vaultPath,
      title: 'Choose Obsidian vault',
      description:
        'Choose the folder containing your Obsidian vault (.obsidian).',
    });
    if (selectedPath) {
      setVaultPath(selectedPath);
    }
  };

  const save = async () => {
    if (!machineClient || vaultError || vaultIdError) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await Promise.all(
        profileConfigs.map(async ({ agent, mcpConfig }) => {
          const servers = configuredServers(mcpConfig);
          const updatedServers = { ...servers };
          if (selectedAgents.has(agent)) {
            updatedServers.obsidian = createObsidianMcpServer(
              vaultPath.trim(),
              vaultId.trim()
            );
          } else {
            delete updatedServers.obsidian;
          }
          await machineClient.saveMcpServers(
            { executor: agent },
            {
              servers: updatedServers,
            }
          );
        })
      );
      setSuccess(
        `Updated the shared vault for ${selectedAgents.size} agent${selectedAgents.size === 1 ? '' : 's'}. Start a new agent session to load it.`
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? `Could not save the MCP configuration: ${reason.message}`
          : 'Could not save the MCP configuration.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-low">
        Give selected agents one shared Obsidian vault as additional project
        memory. This uses a local stdio MCP server; Obsidian does not need to be
        open and no vault content is sent anywhere except through the agent
        tools you approve.
      </p>
      <SettingsField
        label="Vault folder"
        error={vaultError}
        description="The folder must be an existing Obsidian vault (it contains .obsidian) and must use an absolute path."
      >
        <div className="flex gap-2">
          <input
            value={vaultPath}
            onChange={(event) => setVaultPath(event.target.value)}
            placeholder="/Users/you/Documents/Knowledge"
            className="min-w-0 flex-1 rounded border border-border bg-secondary px-3 py-2 text-sm text-normal placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => void chooseVaultFolder()}
            className="shrink-0"
          >
            <FolderOpenIcon className="mr-1.5 size-4" />
            Browse
          </Button>
        </div>
      </SettingsField>
      <SettingsField
        label="Vault ID"
        error={vaultIdError}
        description="This short name is how agents identify the shared vault in MCP tool calls."
      >
        <input
          value={vaultId}
          onChange={(event) => setVaultId(event.target.value)}
          placeholder="aurapunk"
          className="w-full rounded border border-border bg-secondary px-3 py-2 text-sm text-normal placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </SettingsField>
      <div className="space-y-2">
        <p className="text-sm font-medium text-normal">Share with agents</p>
        <p className="text-sm text-low">
          Clearing an agent removes this Obsidian MCP server from that agent's
          configuration when you save.
        </p>
        {loading ? (
          <p className="text-sm text-low">Checking MCP-capable agents…</p>
        ) : profileConfigs.length === 0 ? (
          <p className="text-sm text-low">
            No installed coding-agent profile supports MCP configuration.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {profileConfigs.map(({ agent }) => (
              <SettingsCheckbox
                key={agent}
                id={`obsidian-agent-${agent}`}
                label={toPrettyCase(agent)}
                checked={selectedAgents.has(agent)}
                onChange={(checked) => toggleAgent(agent, checked)}
              />
            ))}
          </div>
        )}
      </div>
      <p className="rounded border border-warning/40 bg-warning/10 p-3 text-sm text-low">
        This server can create, edit, move, and delete notes. Back up important
        vaults and keep write-tool approval enabled in your coding agent.
      </p>
      {error && <p className="text-sm text-error">{error}</p>}
      {success && (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircleIcon weight="fill" />
          {success}
        </p>
      )}
      <PrimaryButton
        onClick={() => void save()}
        disabled={loading || saving || !!vaultError || !!vaultIdError}
        actionIcon={FloppyDiskIcon}
      >
        {saving ? 'Saving shared vault…' : 'Save shared vault'}
      </PrimaryButton>
    </div>
  );
}
