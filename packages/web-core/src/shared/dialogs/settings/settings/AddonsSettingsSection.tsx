import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ChartLineUpIcon,
  GearSixIcon,
  LightningIcon,
  NotebookIcon,
  DatabaseIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { MemoryGraphViewer } from './MemoryGraphViewer';
import { JevLayaSuitePanel } from './JevLayaSuitePanel';
import { Mem0Panel } from './Mem0Panel';
import { ObsidianMcpPanel } from './ObsidianMcpPanel';
import {
  ADDON_DEFAULT_ENABLED,
  setAddonEnabled,
  useAddonEnabledMap,
  type AddonId,
} from './addonPreferences';

/**
 * Settings → Add-ons: registry of optional integrations.
 *
 * The list deliberately stays compact. Configuration is opened one add-on at
 * a time so heavy visualizations and long forms never compete for the same
 * settings page.
 */

interface AddonDefinition {
  id: string;
  homepage: string;
  defaultEnabled: boolean;
  icon: Icon;
  renderPanel: () => ReactNode;
}

// Every add-on defaults to disabled: each one needs the user to install and
// configure something external before it does anything, so none of them should
// look active until that setup actually happened.
const ADDONS: AddonDefinition[] = [
  {
    id: 'mem0',
    homepage: 'https://github.com/mem0ai/mem0',
    defaultEnabled: ADDON_DEFAULT_ENABLED.mem0,
    icon: DatabaseIcon,
    renderPanel: () => <Mem0Panel />,
  },
  {
    id: 'jev_laya_suite',
    homepage: 'https://github.com/coldteadotai/abide',
    defaultEnabled: ADDON_DEFAULT_ENABLED.jev_laya_suite,
    icon: LightningIcon,
    renderPanel: () => <JevLayaSuitePanel />,
  },
  {
    id: 'graphify',
    homepage: 'https://github.com/Graphify-Labs/graphify',
    defaultEnabled: ADDON_DEFAULT_ENABLED.graphify,
    icon: ChartLineUpIcon,
    renderPanel: () => <MemoryGraphViewer />,
  },
  {
    id: 'obsidian_mcp',
    homepage: 'https://github.com/StevenStavrakis/obsidian-mcp',
    defaultEnabled: ADDON_DEFAULT_ENABLED.obsidian_mcp,
    icon: NotebookIcon,
    renderPanel: () => <ObsidianMcpPanel />,
  },
];

function AddonRow({
  addon,
  enabled,
  onToggle,
  onConfigure,
}: {
  addon: AddonDefinition;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
}) {
  const { t } = useTranslation('settings');
  const base = `settings.addons.${addon.id}`;
  const Icon = addon.icon;
  return (
    <article className="flex items-center gap-3 rounded-md border border-border bg-panel p-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-brand/10 text-brand">
        <Icon className="size-5" weight="duotone" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <h3 className="text-base font-medium text-high">
            {t(`${base}.name`, addon.id)}
          </h3>
          <span className="text-xs text-low">{t(`${base}.tagline`, '')}</span>
        </div>
        <p className="mt-0.5 text-sm text-low">
          {t(`${base}.description`, '')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-low">
          <span className="hidden sm:inline">
            {t('settings.addons.active', 'Active')}
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={`${t('settings.addons.active', 'Active')}: ${t(`${base}.name`, addon.id)}`}
            checked={enabled}
            onChange={(event) => onToggle(event.target.checked)}
            className="h-4 w-4 rounded border-border bg-secondary text-brand focus:ring-brand focus:ring-offset-0"
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onConfigure}
          title={t('settings.addons.configure', 'Configure add-on')}
          aria-label={`${t('settings.addons.configure', 'Configure add-on')}: ${t(`${base}.name`, addon.id)}`}
        >
          <GearSixIcon className="size-4" />
        </Button>
      </div>
    </article>
  );
}

function AddonsSettingsSectionInner({ enabledMap }: { enabledMap: Record<string, boolean> }) {
  const { t } = useTranslation('settings');
  const [selectedAddonId, setSelectedAddonId] = useState<string | null>(null);

  const toggle = (id: AddonId, enabled: boolean) => {
    setAddonEnabled(id, enabled);
  };

  const selectedAddon = ADDONS.find((addon) => addon.id === selectedAddonId);

  if (selectedAddon) {
    const base = `settings.addons.${selectedAddon.id}`;
    const Icon = selectedAddon.icon;
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setSelectedAddonId(null)}
            aria-label={t('settings.addons.backToList', 'Back to add-ons')}
            title={t('settings.addons.backToList', 'Back to add-ons')}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Icon className="size-5 text-brand" weight="duotone" />
              <h2 className="text-lg font-medium text-high">
                {t(`${base}.name`, selectedAddon.id)}
              </h2>
            </div>
            <p className="mt-1 text-sm text-low">
              {t(`${base}.description`, '')}
            </p>
            <a
              href={selectedAddon.homepage}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-sm text-brand hover:underline"
            >
              {t('settings.addons.homepage', 'View on GitHub')}
              <ArrowSquareOutIcon className="size-3" weight="bold" />
            </a>
          </div>
        </div>
        <div className="rounded-md border border-border bg-panel p-4">
          {selectedAddon.renderPanel()}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="pb-2 text-sm text-low">
        {t(
          'settings.addons.subtitle',
          'Enable optional add-ons. Each add-on extends the app with a focused integration.'
        )}
      </p>
      <div className="space-y-2">
        {ADDONS.map((addon) => (
          <AddonRow
            key={addon.id}
            addon={addon}
            enabled={enabledMap[addon.id] ?? addon.defaultEnabled}
            onToggle={(enabled) => toggle(addon.id as AddonId, enabled)}
            onConfigure={() => setSelectedAddonId(addon.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Reads the shared add-on preference store so the list and the sidebar
 * indicators never disagree about what is enabled.
 */
export function AddonsSettingsSection() {
  const enabledMap = useAddonEnabledMap();
  return <AddonsSettingsSectionInner enabledMap={enabledMap} />;
}
