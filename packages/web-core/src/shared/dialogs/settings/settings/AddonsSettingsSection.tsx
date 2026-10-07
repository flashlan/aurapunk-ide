import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ChartLineUpIcon,
  GearSixIcon,
  LightningIcon,
  NotebookIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { MemoryGraphViewer } from './MemoryGraphViewer';
import { JevLayaSuitePanel } from './JevLayaSuitePanel';
import { ObsidianMcpPanel } from './ObsidianMcpPanel';

/**
 * Settings → Add-ons: registry of optional integrations.
 *
 * The list deliberately stays compact. Configuration is opened one add-on at
 * a time so heavy visualizations and long forms never compete for the same
 * settings page.
 */

const ADDONS_ENABLED_STORAGE_KEY = 'aurapunk.settings.addons-enabled';

interface AddonDefinition {
  id: string;
  homepage: string;
  defaultEnabled: boolean;
  icon: Icon;
  renderPanel: () => ReactNode;
}

const ADDONS: AddonDefinition[] = [
  {
    id: 'jev_laya_suite',
    homepage: 'https://github.com/coldteadotai/abide',
    defaultEnabled: true,
    icon: LightningIcon,
    renderPanel: () => <JevLayaSuitePanel />,
  },
  {
    id: 'graphify',
    homepage: 'https://github.com/Graphify-Labs/graphify',
    defaultEnabled: true,
    icon: ChartLineUpIcon,
    renderPanel: () => <MemoryGraphViewer />,
  },
  {
    id: 'obsidian_mcp',
    homepage: 'https://github.com/StevenStavrakis/obsidian-mcp',
    defaultEnabled: false,
    icon: NotebookIcon,
    renderPanel: () => <ObsidianMcpPanel />,
  },
];

function readEnabledMap(): Record<string, boolean> {
  const initial: Record<string, boolean> = {};
  for (const addon of ADDONS) initial[addon.id] = addon.defaultEnabled;
  try {
    const raw = window.localStorage.getItem(ADDONS_ENABLED_STORAGE_KEY);
    if (!raw) return initial;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const addon of ADDONS) {
      const value = parsed[addon.id];
      if (typeof value === 'boolean') {
        initial[addon.id] = value;
      }
    }
  } catch {
    // Corrupt storage degrades to defaults; never blocks the section.
  }
  return initial;
}

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
            {t('settings.addons.enable', 'Enabled')}
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={`${t('settings.addons.enable', 'Enabled')}: ${t(`${base}.name`, addon.id)}`}
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
          disabled={!enabled}
          title={
            enabled
              ? t('settings.addons.configure', 'Configure add-on')
              : t('settings.addons.enableFirst', 'Enable this add-on first')
          }
          aria-label={`${t('settings.addons.configure', 'Configure add-on')}: ${t(`${base}.name`, addon.id)}`}
        >
          <GearSixIcon className="size-4" />
        </Button>
      </div>
    </article>
  );
}

export function AddonsSettingsSection() {
  const { t } = useTranslation('settings');
  const [enabledMap, setEnabledMap] =
    useState<Record<string, boolean>>(readEnabledMap);
  const [selectedAddonId, setSelectedAddonId] = useState<string | null>(null);

  const toggle = (id: string, enabled: boolean) => {
    setEnabledMap((prev) => {
      const next = { ...prev, [id]: enabled };
      try {
        window.localStorage.setItem(
          ADDONS_ENABLED_STORAGE_KEY,
          JSON.stringify(next)
        );
      } catch {
        // Storage failures (private mode, quota) degrade silently.
      }
      return next;
    });
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
            onToggle={(enabled) => toggle(addon.id, enabled)}
            onConfigure={() => setSelectedAddonId(addon.id)}
          />
        ))}
      </div>
    </div>
  );
}
