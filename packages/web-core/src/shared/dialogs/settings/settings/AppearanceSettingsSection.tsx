import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DownloadSimpleIcon,
  UploadSimpleIcon,
  TrashIcon,
  ArrowClockwiseIcon,
  CheckIcon,
} from '@phosphor-icons/react';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import {
  type MobileFontScale,
  type UiFontFamily,
  type CodeFontFamily,
  type UiFontScale,
  type CodeFontSize,
  useAnimateRunningOutline,
  useMobileFontScale,
  useUiFontFamily,
  useCodeFontFamily,
  useUiFontScale,
  useCodeFontSize,
  useCustomTheme,
  useSavedCustomThemes,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import {
  CODE_FONT_OPTIONS,
  CODE_FONT_SIZE_OPTIONS,
  THEME_PRESETS,
  UI_FONT_OPTIONS,
  UI_SCALE_OPTIONS,
  exportThemeToFile,
  parseImportedTheme,
} from '@/shared/lib/customTheme';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import {
  SettingsCard,
  SettingsCheckbox,
  SettingsField,
  SettingsSelect,
} from './SettingsComponents';

export function AppearanceSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);
  const isMobile = useIsMobile();

  // Appearance is now driven exclusively by the custom palette system.
  const [animateRunningOutline, setAnimateRunningOutline] =
    useAnimateRunningOutline();
  const [mobileFontScale, setMobileFontScale] = useMobileFontScale();

  // Typography
  const [uiFontFamily, setUiFontFamily] = useUiFontFamily();
  const [codeFontFamily, setCodeFontFamily] = useCodeFontFamily();
  const [uiFontScale, setUiFontScale] = useUiFontScale();
  const [codeFontSize, setCodeFontSize] = useCodeFontSize();

  // Custom Themes
  const [customTheme, setCustomTheme] = useCustomTheme();
  // The legacy enable/disable switch is intentionally gone. The custom
  // palette is the only theme system now, so it is always active.
  const customThemeEnabled = true;
  const {
    themes: savedThemes,
    save: saveTheme,
    apply: applyTheme,
    remove: removeTheme,
  } = useSavedCustomThemes();
  const resetDefaults = useUiPreferencesStore((s) => s.resetAppearanceDefaults);

  const [newThemeName, setNewThemeName] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    exportThemeToFile(customTheme, {
      uiFontFamily,
      codeFontFamily,
      uiFontScale,
      codeFontSize,
    });
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportError(null);
    setImportSuccess(null);
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const parsed = parseImportedTheme(content);
      if (!parsed) {
        setImportError('Invalid or corrupted theme file.');
        return;
      }

      setCustomTheme(parsed.theme);
      if (parsed.typography) {
        setUiFontFamily(parsed.typography.uiFontFamily);
        setCodeFontFamily(parsed.typography.codeFontFamily);
        setUiFontScale(parsed.typography.uiFontScale);
        setCodeFontSize(parsed.typography.codeFontSize);
      }
      setImportSuccess(
        `Theme "${parsed.theme.name || 'Imported'}" applied successfully!`
      );
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const handleSaveCurrentTheme = () => {
    const name = newThemeName.trim() || customTheme.name || 'My Custom Theme';
    saveTheme(name);
    setNewThemeName('');
    setImportSuccess(`Theme "${name}" saved to your custom themes!`);
  };

  const activeGradient = useMemo(() => {
    if (!customTheme.enableGradient) return null;
    return `linear-gradient(${customTheme.gradientAngle || 135}deg, ${customTheme.gradientColor1} 0%, ${customTheme.gradientColor2} 100%)`;
  }, [customTheme]);

  return (
    <div className="space-y-6 pb-12">
      {/* Import / Notification Messages */}
      {importError && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error text-sm">
          {importError}
        </div>
      )}
      {importSuccess && (
        <div className="bg-success/10 border border-success/50 rounded-sm p-4 text-success font-medium text-sm flex items-center gap-2">
          <CheckIcon weight="bold" className="size-4" />
          {importSuccess}
        </div>
      )}

      {/* 1. Live Interactive Preview */}
      <SettingsCard
        title="Live Real-time Preview"
        description="Preview how your typography, colors, borders, and gradient highlights look in the Aurapunk interface."
      >
        <div
          className="rounded-lg border overflow-hidden shadow-md transition-all duration-200"
          style={{
            backgroundColor: customThemeEnabled
              ? customTheme.canvasBg
              : '#0f0f11',
            borderColor: customThemeEnabled
              ? customTheme.borderColor || '#27272a'
              : '#27272a',
            color: customThemeEnabled ? customTheme.textColor : '#f4f4f5',
          }}
        >
          {/* Cockpit Window Header */}
          <div
            className="px-4 py-2.5 flex items-center justify-between border-b"
            style={{
              backgroundColor: customThemeEnabled
                ? customTheme.surfaceBg
                : '#18181b',
              borderColor: customThemeEnabled
                ? customTheme.borderColor || '#27272a'
                : '#27272a',
            }}
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 opacity-75">
                <div className="w-2.5 h-2.5 rounded-full bg-error/70" />
                <div className="w-2.5 h-2.5 rounded-full bg-warning/70" />
                <div className="w-2.5 h-2.5 rounded-full bg-success/70" />
              </div>
              <div className="h-3 w-px bg-border/60" />
              <div className="flex items-center gap-2">
                <span
                  className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded shadow-xs"
                  style={{
                    background:
                      activeGradient ||
                      (customThemeEnabled
                        ? customTheme.highlightColor
                        : 'hsl(var(--brand))'),
                    color: '#ffffff',
                  }}
                >
                  Aurapunk
                </span>
                <span className="text-xs font-semibold">
                  {`Custom: ${customTheme.name || 'Theme'}`}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span
                className="text-[11px] hidden sm:inline"
                style={{
                  color: customThemeEnabled
                    ? customTheme.textMutedColor
                    : '#a1a1aa',
                }}
              >
                Font: <strong className="font-medium">{uiFontFamily}</strong> (
                {uiFontScale}%)
              </span>
              <button
                type="button"
                className="px-3 py-1 text-xs font-medium rounded text-white shadow-xs border border-white/20 transition-transform active:scale-95"
                style={{
                  background:
                    activeGradient ||
                    (customThemeEnabled
                      ? customTheme.highlightColor
                      : 'hsl(var(--brand))'),
                }}
              >
                Action
              </button>
            </div>
          </div>

          {/* Workspace Body */}
          <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Sidebar Active Item Sample */}
            <div
              className="p-3 rounded border flex flex-col justify-between"
              style={{
                backgroundColor: customThemeEnabled
                  ? customTheme.surfaceBg
                  : '#18181b',
                borderColor: customThemeEnabled
                  ? customTheme.borderColor || '#27272a'
                  : '#27272a',
              }}
            >
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-low opacity-70 mb-2">
                  Sidebar / Navigation
                </div>
                <div
                  className="px-2.5 py-1.5 rounded text-xs font-medium flex items-center justify-between"
                  style={{
                    backgroundColor: customThemeEnabled
                      ? `${customTheme.highlightColor}20`
                      : 'hsla(var(--brand), 0.12)',
                    color: customThemeEnabled
                      ? customTheme.textColor
                      : '#ffffff',
                    borderLeft: `3px solid ${customThemeEnabled ? customTheme.highlightColor : 'hsl(var(--brand))'}`,
                  }}
                >
                  <span>⚡ Active Workspace</span>
                  <span className="text-[9px] px-1 py-0.2 rounded bg-white/10">
                    main
                  </span>
                </div>
              </div>
              <p
                className="text-[11px] mt-3 leading-relaxed"
                style={{
                  color: customThemeEnabled
                    ? customTheme.textMutedColor
                    : '#a1a1aa',
                }}
              >
                Sidebar tint & active state contrast.
              </p>
            </div>

            {/* Kanban Task Card */}
            <div
              className="p-3 rounded border relative flex flex-col justify-between shadow-xs"
              style={{
                backgroundColor: customThemeEnabled
                  ? customTheme.surfaceBg
                  : '#18181b',
                borderColor: customThemeEnabled
                  ? customTheme.borderColor || '#27272a'
                  : '#27272a',
              }}
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase"
                    style={{
                      backgroundColor: customThemeEnabled
                        ? `${customTheme.highlightColor}25`
                        : 'hsla(var(--brand), 0.15)',
                      color: customThemeEnabled
                        ? customTheme.highlightColor
                        : 'hsl(var(--brand))',
                    }}
                  >
                    In Progress
                  </span>
                  <span className="text-[10px] opacity-60 font-mono">
                    #8381
                  </span>
                </div>
                <div className="font-semibold text-xs mb-1">
                  Typography & Theme Editor
                </div>
                <p
                  className="text-[11px] leading-relaxed line-clamp-2"
                  style={{
                    color: customThemeEnabled
                      ? customTheme.textMutedColor
                      : '#a1a1aa',
                  }}
                >
                  Verify surface readability, contrast ratios, and button
                  highlights.
                </p>
              </div>

              <div className="flex items-center gap-1 mt-2.5 pt-2 border-t border-border/40">
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-low">
                  UI
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-low">
                  Themes
                </span>
              </div>
            </div>

            {/* Code / Diff Inspector */}
            <div
              className="p-3 rounded border text-xs overflow-x-auto shadow-xs"
              style={{
                backgroundColor: customThemeEnabled
                  ? customTheme.surfaceBg
                  : '#141416',
                borderColor: customThemeEnabled
                  ? customTheme.borderColor || '#27272a'
                  : '#27272a',
                fontFamily: CODE_FONT_OPTIONS.find(
                  (o) => o.value === codeFontFamily
                )?.family,
                fontSize: `${codeFontSize}px`,
              }}
            >
              <div className="text-low opacity-60 mb-1 flex items-center justify-between">
                <span>agent.ts</span>
                <span className="text-[10px]">{codeFontSize}px</span>
              </div>
              <div className="leading-snug">
                <span className="text-brand font-semibold">const</span> agent ={' '}
                <span className="text-success">new Agent</span>({'{'}
              </div>
              <div className="pl-2 leading-snug">
                theme:{' '}
                <span className="text-warning">
                  '{customTheme.name || 'custom'}'
                </span>
                ,
              </div>
              <div className="pl-2 leading-snug">
                grad:{' '}
                <span className="text-info">
                  {customTheme.enableGradient ? 'true' : 'false'}
                </span>
              </div>
              <div className="leading-snug">{'}'});</div>
            </div>
          </div>
        </div>
      </SettingsCard>

      {/* 2. Theme Presets */}
      <SettingsCard
        title="Theme Presets"
        description="Choose a saved Aurapunk palette or start from a modern preset."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {THEME_PRESETS.map((preset) => {
            const isSelected =
              customThemeEnabled && customTheme.name === preset.theme.name;
            const gradientStyle = preset.theme.enableGradient
              ? `linear-gradient(135deg, ${preset.theme.gradientColor1} 0%, ${preset.theme.gradientColor2} 100%)`
              : preset.theme.highlightColor;

            return (
              <div
                key={preset.id}
                onClick={() => {
                  setCustomTheme(preset.theme);
                  if (preset.uiFontFamily) setUiFontFamily(preset.uiFontFamily);
                  if (preset.codeFontFamily)
                    setCodeFontFamily(preset.codeFontFamily);
                }}
                className={`group relative p-3.5 rounded-md cursor-pointer transition-all duration-200 flex flex-col justify-between ${
                  isSelected
                    ? 'border-2 border-brand bg-brand/10 shadow-sm'
                    : 'border border-border dark:border-white/15 hover:border-brand/60 bg-secondary/40 hover:bg-secondary/80'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-sm font-semibold text-high">
                      {preset.name}
                    </span>
                    {isSelected && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-brand text-white shadow-xs shrink-0">
                        <CheckIcon weight="bold" className="size-3" />
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-low line-clamp-2 mb-3">
                    {preset.description}
                  </p>
                </div>

                {/* Color swatches */}
                <div className="flex items-center gap-1.5 pt-2 border-t border-border/40">
                  <div
                    className="w-5 h-5 rounded-full border border-white/25 ring-1 ring-black/30 shadow-xs"
                    style={{ backgroundColor: preset.theme.canvasBg }}
                    title="Canvas Background"
                  />
                  <div
                    className="w-5 h-5 rounded-full border border-white/25 ring-1 ring-black/30 shadow-xs"
                    style={{ backgroundColor: preset.theme.surfaceBg }}
                    title="Surface / Panels"
                  />
                  <div
                    className="w-5 h-5 rounded-full border border-white/25 ring-1 ring-black/30 shadow-xs"
                    style={{ backgroundColor: preset.theme.textColor }}
                    title="Primary Text"
                  />
                  <div
                    className="w-5 h-5 rounded-full ml-auto border border-white/25 ring-1 ring-black/30 shadow-xs"
                    style={{ background: gradientStyle }}
                    title="Highlight / Gradient"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      {/* 3. Interface behavior */}
      <SettingsCard
        title="Interface Behavior"
        description="Configure how active workspace panels are presented."
      >
        <SettingsCheckbox
          id="animate-running-outline-appearance"
          label={t('settings.general.appearance.animateRunningOutline.label', {
            defaultValue: 'Animate running card border',
          })}
          description={t(
            'settings.general.appearance.animateRunningOutline.helper',
            {
              defaultValue:
                'Show animated shimmering outline around active workspace panels.',
            }
          )}
          checked={animateRunningOutline}
          onChange={setAnimateRunningOutline}
        />
      </SettingsCard>

      {/* 4. Typography & Font Families */}
      <SettingsCard
        title="Typography & Font Families"
        description="Choose custom font families for the user interface and for code diffs, logs, and terminals."
      >
        <SettingsField
          label="Interface Font (Sans-Serif)"
          description="Applied to menus, sidebars, buttons, headings, kanban cards, and chat."
        >
          <SettingsSelect
            value={uiFontFamily}
            options={UI_FONT_OPTIONS.map((f) => ({
              value: f.value,
              label: f.label,
            }))}
            onChange={(val: UiFontFamily) => setUiFontFamily(val)}
          />
        </SettingsField>

        <SettingsField
          label="Code & Terminal Font (Monospace)"
          description="Applied to code blocks, file diffs, agent execution logs, and embedded terminal."
        >
          <SettingsSelect
            value={codeFontFamily}
            options={CODE_FONT_OPTIONS.map((f) => ({
              value: f.value,
              label: f.label,
            }))}
            onChange={(val: CodeFontFamily) => setCodeFontFamily(val)}
          />
        </SettingsField>
      </SettingsCard>

      {/* 5. Font Sizes & Scaling */}
      <SettingsCard
        title="Font Sizes & UI Scaling"
        description="Fine-tune the overall interface scale and monospace code font sizes."
      >
        <SettingsField
          label="Global UI Scale"
          description="Scale all interface elements and fonts up or down proportionally."
        >
          <SettingsSelect
            value={uiFontScale}
            options={UI_SCALE_OPTIONS.map((s) => ({
              value: s.value,
              label: s.label,
            }))}
            onChange={(val: UiFontScale) => setUiFontScale(val)}
          />
        </SettingsField>

        <SettingsField
          label="Code & Diff Font Size"
          description="Base text size for code blocks, diff viewers, and editors."
        >
          <SettingsSelect
            value={codeFontSize}
            options={CODE_FONT_SIZE_OPTIONS.map((s) => ({
              value: s.value,
              label: s.label,
            }))}
            onChange={(val: CodeFontSize) => setCodeFontSize(val)}
          />
        </SettingsField>

        {isMobile && (
          <SettingsField
            label="Mobile Font Scale"
            description="Dedicated font scaling when viewing on smartphone screens."
          >
            <SettingsSelect
              value={mobileFontScale}
              options={[
                {
                  value: 'default' as MobileFontScale,
                  label: 'Default (100%)',
                },
                { value: 'small' as MobileFontScale, label: 'Small (95%)' },
                { value: 'smaller' as MobileFontScale, label: 'Smaller (90%)' },
              ]}
              onChange={(value: MobileFontScale) => setMobileFontScale(value)}
            />
          </SettingsField>
        )}
      </SettingsCard>

      {/* 6. Custom Colors, Backgrounds & Highlight Gradient */}
      <SettingsCard
        title="Custom Palette, Backgrounds & Gradient Highlights"
        description="Customize canvas background (behind everything), interface surface, font color, and gradient highlights."
      >
        <div className="space-y-4 pt-3 border-t border-border">
          {/* Background colors */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-high">
                Canvas Background (Behind Everything)
              </label>
              <p className="text-xs text-low">
                Main root canvas and window background.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customTheme.canvasBg}
                  onChange={(e) => setCustomTheme({ canvasBg: e.target.value })}
                  className="w-9 h-8 p-0 rounded border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={customTheme.canvasBg}
                  onChange={(e) => setCustomTheme({ canvasBg: e.target.value })}
                  className="flex-1 bg-secondary border border-border rounded-sm px-2.5 py-1 text-sm text-high font-mono"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-high">
                Interface Surface (Panels, Cards, Sidebars)
              </label>
              <p className="text-xs text-low">
                Elevated surface for cards, inputs, and sidebars.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customTheme.surfaceBg}
                  onChange={(e) =>
                    setCustomTheme({ surfaceBg: e.target.value })
                  }
                  className="w-9 h-8 p-0 rounded border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={customTheme.surfaceBg}
                  onChange={(e) =>
                    setCustomTheme({ surfaceBg: e.target.value })
                  }
                  className="flex-1 bg-secondary border border-border rounded-sm px-2.5 py-1 text-sm text-high font-mono"
                />
              </div>
            </div>
          </div>

          {/* Text colors */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-high">
                Font Color (Primary Text)
              </label>
              <p className="text-xs text-low">
                High-contrast text for headings, messages, and titles.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customTheme.textColor}
                  onChange={(e) =>
                    setCustomTheme({ textColor: e.target.value })
                  }
                  className="w-9 h-8 p-0 rounded border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={customTheme.textColor}
                  onChange={(e) =>
                    setCustomTheme({ textColor: e.target.value })
                  }
                  className="flex-1 bg-secondary border border-border rounded-sm px-2.5 py-1 text-sm text-high font-mono"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-high">
                Secondary Text Color (Muted)
              </label>
              <p className="text-xs text-low">
                Labels, timestamps, hints, and secondary metadata.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customTheme.textMutedColor}
                  onChange={(e) =>
                    setCustomTheme({ textMutedColor: e.target.value })
                  }
                  className="w-9 h-8 p-0 rounded border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={customTheme.textMutedColor}
                  onChange={(e) =>
                    setCustomTheme({ textMutedColor: e.target.value })
                  }
                  className="flex-1 bg-secondary border border-border rounded-sm px-2.5 py-1 text-sm text-high font-mono"
                />
              </div>
            </div>
          </div>

          {/* Highlight & Gradient */}
          <div className="pt-2 border-t border-border/60">
            <div className="space-y-1.5 mb-3">
              <label className="text-sm font-medium text-high">
                Highlight Color (Brand Accent)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customTheme.highlightColor}
                  onChange={(e) =>
                    setCustomTheme({ highlightColor: e.target.value })
                  }
                  className="w-9 h-8 p-0 rounded border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={customTheme.highlightColor}
                  onChange={(e) =>
                    setCustomTheme({ highlightColor: e.target.value })
                  }
                  className="flex-1 bg-secondary border border-border rounded-sm px-2.5 py-1 text-sm text-high font-mono"
                />
              </div>
            </div>

            <SettingsCheckbox
              id="enable-highlight-gradient"
              label="Enable Gradient on Highlights & Buttons"
              description="Applies smooth two-color gradient to primary action buttons, active badges, and accents."
              checked={customTheme.enableGradient}
              onChange={(checked) =>
                setCustomTheme({ enableGradient: checked })
              }
            />

            {customTheme.enableGradient && (
              <div className="mt-3 p-3.5 rounded bg-secondary/50 border border-border space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-high block mb-1">
                      Start Color
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={customTheme.gradientColor1}
                        onChange={(e) =>
                          setCustomTheme({ gradientColor1: e.target.value })
                        }
                        className="w-8 h-7 p-0 rounded border border-border cursor-pointer bg-transparent"
                      />
                      <input
                        type="text"
                        value={customTheme.gradientColor1}
                        onChange={(e) =>
                          setCustomTheme({ gradientColor1: e.target.value })
                        }
                        className="flex-1 bg-secondary border border-border rounded-sm px-2 py-0.5 text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-high block mb-1">
                      End Color
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={customTheme.gradientColor2}
                        onChange={(e) =>
                          setCustomTheme({ gradientColor2: e.target.value })
                        }
                        className="w-8 h-7 p-0 rounded border border-border cursor-pointer bg-transparent"
                      />
                      <input
                        type="text"
                        value={customTheme.gradientColor2}
                        onChange={(e) =>
                          setCustomTheme({ gradientColor2: e.target.value })
                        }
                        className="flex-1 bg-secondary border border-border rounded-sm px-2 py-0.5 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium text-high">
                      Gradient Angle
                    </span>
                    <span className="text-low font-mono">
                      {customTheme.gradientAngle || 135}°
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    step="5"
                    value={customTheme.gradientAngle || 135}
                    onChange={(e) =>
                      setCustomTheme({
                        gradientAngle: Number(e.target.value),
                      })
                    }
                    className="w-full accent-brand cursor-pointer"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </SettingsCard>

      {/* 7. Save, Export & Import Theme Management */}
      <SettingsCard
        title="Save, Export & Import Themes"
        description="Save your custom palette and typography, export as JSON to share, or import existing theme files."
      >
        {/* Save Current Theme */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pb-4 border-b border-border/60">
          <input
            type="text"
            placeholder="Theme name (e.g. My Custom Dark Glow)"
            value={newThemeName}
            onChange={(e) => setNewThemeName(e.target.value)}
            className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm text-high focus:outline-none focus:ring-1 focus:ring-brand placeholder:text-low"
          />
          <PrimaryButton
            value="Save Current Theme"
            onClick={handleSaveCurrentTheme}
            actionIcon={CheckIcon}
          />
        </div>

        {/* Saved Themes List */}
        {savedThemes.length > 0 && (
          <div className="space-y-2 py-2">
            <label className="text-xs font-medium text-low uppercase tracking-wider">
              Your Saved Themes ({savedThemes.length})
            </label>
            <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
              {savedThemes.map((saved) => (
                <div
                  key={saved.name}
                  className="flex items-center justify-between p-2.5 rounded bg-secondary/60 border border-border text-sm"
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-4 h-4 rounded-full border border-white/25 ring-1 ring-black/30 shadow-xs"
                      style={{
                        background: saved.enableGradient
                          ? `linear-gradient(135deg, ${saved.gradientColor1} 0%, ${saved.gradientColor2} 100%)`
                          : saved.highlightColor,
                      }}
                    />
                    <span className="font-medium text-high">{saved.name}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        applyTheme(saved);
                      }}
                      className="px-2.5 py-1 text-xs rounded border border-brand/40 bg-brand/10 hover:bg-brand/20 text-brand font-medium transition-colors shadow-xs"
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      onClick={() => removeTheme(saved.name)}
                      className="p-1 rounded border border-transparent hover:border-error/40 hover:bg-error/10 text-low hover:text-error transition-colors"
                      title="Delete theme"
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Export / Import / Reset buttons */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-border/40">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleExport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border bg-secondary hover:bg-panel hover:border-brand/60 text-high transition-colors shadow-xs"
            >
              <DownloadSimpleIcon
                weight="bold"
                className="size-3.5 text-brand"
              />
              Export Theme (JSON)
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border bg-secondary hover:bg-panel hover:border-brand/60 text-high transition-colors shadow-xs"
            >
              <UploadSimpleIcon weight="bold" className="size-3.5 text-brand" />
              Import Theme (.json)
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImportFile}
              className="hidden"
            />
          </div>

          <button
            type="button"
            onClick={resetDefaults}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-border/60 hover:border-warning/50 bg-secondary/30 hover:bg-warning/10 text-low hover:text-warning transition-colors"
          >
            <ArrowClockwiseIcon weight="bold" className="size-3.5" />
            Reset to Defaults
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}
