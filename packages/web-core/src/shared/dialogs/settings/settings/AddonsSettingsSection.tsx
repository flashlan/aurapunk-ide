import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { SettingsCard, SettingsCheckbox } from './SettingsComponents';
import { MemoryGraphViewer } from './MemoryGraphViewer';
import { JevLayaSuitePanel } from './JevLayaSuitePanel';

/**
 * Settings → Add-ons: registry of optional integrations.
 *
 * Each entry is a self-contained add-on card with an enable toggle
 * (persisted per browser in localStorage) and, when enabled, its own
 * panel. New add-ons only need an entry in `ADDONS` — no registry or
 * plumbing changes.
 */

const ADDONS_ENABLED_STORAGE_KEY = 'aurapunk.settings.addons-enabled';

interface AddonDefinition {
  id: string;
  homepage: string;
  defaultEnabled: boolean;
  renderPanel: () => ReactNode;
}

const ADDONS: AddonDefinition[] = [
  {
    id: 'jev_laya_suite',
    homepage: 'https://github.com/coldteadotai/abide',
    defaultEnabled: true,
    renderPanel: () => <JevLayaSuitePanel />,
  },
  {
    id: 'graphify',
    homepage: 'https://github.com/Graphify-Labs/graphify',
    defaultEnabled: true,
    renderPanel: () => <MemoryGraphViewer />,
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

function AddonCard({
  addon,
  enabled,
  onToggle,
}: {
  addon: AddonDefinition;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const base = `settings.addons.${addon.id}`;
  return (
    <SettingsCard
      title={`${t(`${base}.name`, addon.id)} — ${t(`${base}.tagline`, '')}`.replace(
        / — $/,
        ''
      )}
      description={
        <>
          <span className="block">{t(`${base}.description`, '')}</span>
          <a
            href={addon.homepage}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-brand hover:underline"
          >
            {t('settings.addons.homepage', 'View on GitHub')}
            <ArrowSquareOutIcon className="size-3" weight="bold" />
          </a>
        </>
      }
      headerAction={
        <SettingsCheckbox
          id={`addon-enabled-${addon.id}`}
          label={t('settings.addons.enable', 'Enabled')}
          checked={enabled}
          onChange={onToggle}
        />
      }
    >
      {enabled ? (
        addon.renderPanel()
      ) : (
        <p className="text-sm text-low">
          {t('settings.addons.disabledHint', 'Enable this add-on to use it.')}
        </p>
      )}
    </SettingsCard>
  );
}

export function AddonsSettingsSection() {
  const { t } = useTranslation('settings');
  const [enabledMap, setEnabledMap] =
    useState<Record<string, boolean>>(readEnabledMap);

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

  return (
    <div className="space-y-2">
      <p className="pb-2 text-sm text-low">
        {t(
          'settings.addons.subtitle',
          'Enable optional add-ons. Each add-on extends the app with a focused integration.'
        )}
      </p>
      {ADDONS.map((addon) => (
        <AddonCard
          key={addon.id}
          addon={addon}
          enabled={enabledMap[addon.id] ?? addon.defaultEnabled}
          onToggle={(enabled) => toggle(addon.id, enabled)}
        />
      ))}
    </div>
  );
}
