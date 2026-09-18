import {
  GearIcon,
  PaletteIcon,
  GitBranchIcon,
  CpuIcon,
  PlugIcon,
  TelegramLogoIcon,
  FlowArrowIcon,
  ClockCountdownIcon,
  ChartBarIcon,
  DatabaseIcon,
  ArchiveIcon,
  PuzzlePieceIcon,
  ColumnsIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { GeneralSettingsSection } from './GeneralSettingsSection';
import { AppearanceSettingsSection } from './AppearanceSettingsSection';
import { PipelineSettingsSection } from './PipelineSettingsSection';
import { RecurrentSettingsSection } from './RecurrentSettingsSection';
import { ReposSettingsSection } from './ReposSettingsSection';
import { AgentsSettingsSection } from './AgentsSettingsSection';
import { McpSettingsSection } from './McpSettingsSection';
import { TelegramSettingsSection } from './TelegramSettingsSection';
import { UsageSettingsSection } from './UsageSettingsSection';
import { MemorySettingsSection } from './MemorySettingsSection';
import { BackupSettingsSection } from './BackupSettingsSection';
import { AddonsSettingsSection } from './AddonsSettingsSection';
import { StatusesSettingsSection } from './StatusesSettingsSection';

// ADR-018 — `organizations` and `remote-projects` sections are gone.
// Only host-scoped sections remain; the `universal` group is empty.
export type SettingsSectionType =
  | 'general'
  | 'appearance'
  | 'pipeline'
  | 'recurrent'
  | 'repos'
  | 'agents'
  | 'mcp'
  | 'telegram'
  | 'usage'
  | 'memory'
  | 'backup'
  | 'addons'
  | 'statuses';

export type SettingsSectionGroup = 'host';

export type SettingsSectionInitialState = {
  general: undefined;
  appearance: undefined;
  pipeline: undefined;
  recurrent: undefined;
  repos: { repoId?: string } | undefined;
  agents: { executor?: string; variant?: string } | undefined;
  mcp: undefined;
  telegram: undefined;
  usage: undefined;
  memory: undefined;
  backup: undefined;
  addons: undefined;
  statuses: undefined;
};

export interface SettingsSectionDefinition {
  id: SettingsSectionType;
  icon: Icon;
  group: SettingsSectionGroup;
}

export const SETTINGS_SECTION_DEFINITIONS: SettingsSectionDefinition[] = [
  { id: 'general', icon: GearIcon, group: 'host' },
  { id: 'appearance', icon: PaletteIcon, group: 'host' },
  { id: 'pipeline', icon: FlowArrowIcon, group: 'host' },
  { id: 'recurrent', icon: ClockCountdownIcon, group: 'host' },
  { id: 'repos', icon: GitBranchIcon, group: 'host' },
  { id: 'agents', icon: CpuIcon, group: 'host' },
  { id: 'mcp', icon: PlugIcon, group: 'host' },
  { id: 'telegram', icon: TelegramLogoIcon, group: 'host' },
  { id: 'usage', icon: ChartBarIcon, group: 'host' },
  { id: 'memory', icon: DatabaseIcon, group: 'host' },
  { id: 'backup', icon: ArchiveIcon, group: 'host' },
  { id: 'addons', icon: PuzzlePieceIcon, group: 'host' },
  { id: 'statuses', icon: ColumnsIcon, group: 'host' },
];

export function isHostSpecificSettingsSection(
  type: SettingsSectionType
): boolean {
  return (
    SETTINGS_SECTION_DEFINITIONS.find((section) => section.id === type)
      ?.group === 'host'
  );
}

export function renderSettingsSection(
  type: SettingsSectionType,
  initialState?: SettingsSectionInitialState[SettingsSectionType],
  onClose?: () => void
) {
  switch (type) {
    case 'general':
      return <GeneralSettingsSection />;
    case 'appearance':
      return <AppearanceSettingsSection />;
    case 'pipeline':
      return <PipelineSettingsSection />;
    case 'recurrent':
      return <RecurrentSettingsSection onClose={onClose} />;
    case 'repos':
      return (
        <ReposSettingsSection
          initialState={initialState as SettingsSectionInitialState['repos']}
        />
      );
    case 'agents':
      return <AgentsSettingsSection />;
    case 'mcp':
      return <McpSettingsSection />;
    case 'telegram':
      return <TelegramSettingsSection />;
    case 'usage':
      return <UsageSettingsSection />;
    case 'memory':
      return <MemorySettingsSection />;
    case 'backup':
      return <BackupSettingsSection />;
    case 'addons':
      return <AddonsSettingsSection />;
    case 'statuses':
      return <StatusesSettingsSection />;
    default:
      return <GeneralSettingsSection />;
  }
}
