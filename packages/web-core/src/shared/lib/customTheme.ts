import { useEffect } from 'react';
import {
  type CodeFontFamily,
  type CodeFontSize,
  type CustomThemeConfig,
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_FONT_SCALE,
  type UiFontFamily,
  type UiFontScale,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  theme: CustomThemeConfig;
  uiFontFamily?: UiFontFamily;
  codeFontFamily?: CodeFontFamily;
}

export interface ExportedThemePackage {
  version: 1;
  exportedAt: string;
  theme: CustomThemeConfig;
  typography: {
    uiFontFamily: UiFontFamily;
    codeFontFamily: CodeFontFamily;
    uiFontScale: UiFontScale;
    codeFontSize: CodeFontSize;
  };
}

export const UI_FONT_OPTIONS: {
  value: UiFontFamily;
  label: string;
  family: string;
}[] = [
  {
    value: 'ibm-plex-sans',
    label: 'IBM Plex Sans (Default)',
    family: '"IBM Plex Sans", "Noto Emoji", sans-serif',
  },
  {
    value: 'inter',
    label: 'Inter',
    family: '"Inter", "Noto Emoji", sans-serif',
  },
  {
    value: 'geist-sans',
    label: 'Geist Sans',
    family: '"Geist", "Noto Emoji", sans-serif',
  },
  {
    value: 'plus-jakarta-sans',
    label: 'Plus Jakarta Sans',
    family: '"Plus Jakarta Sans", "Noto Emoji", sans-serif',
  },
  {
    value: 'fira-sans',
    label: 'Fira Sans',
    family: '"Fira Sans", "Noto Emoji", sans-serif',
  },
  {
    value: 'roboto',
    label: 'Roboto',
    family: '"Roboto", "Noto Emoji", sans-serif',
  },
  {
    value: 'system',
    label: 'System UI (Native)',
    family:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
];

export const CODE_FONT_OPTIONS: {
  value: CodeFontFamily;
  label: string;
  family: string;
}[] = [
  {
    value: 'ibm-plex-mono',
    label: 'IBM Plex Mono (Default)',
    family: '"IBM Plex Mono", monospace',
  },
  {
    value: 'jetbrains-mono',
    label: 'JetBrains Mono',
    family: '"JetBrains Mono", monospace',
  },
  {
    value: 'fira-code',
    label: 'Fira Code',
    family: '"Fira Code", monospace',
  },
  {
    value: 'geist-mono',
    label: 'Geist Mono',
    family: '"Geist Mono", monospace',
  },
  {
    value: 'source-code-pro',
    label: 'Source Code Pro',
    family: '"Source Code Pro", monospace',
  },
  {
    value: 'system-mono',
    label: 'Monospace (System)',
    family:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  },
];

export const UI_SCALE_OPTIONS: {
  value: UiFontScale;
  label: string;
  percent: string;
}[] = [
  { value: '85', label: 'Compact (85%)', percent: '85%' },
  { value: '92', label: 'Comfortable (92%)', percent: '92%' },
  { value: '100', label: 'Standard (100%)', percent: '100%' },
  { value: '110', label: 'Large (110%)', percent: '110%' },
  { value: '120', label: 'Extra Large (120%)', percent: '120%' },
];

export const CODE_FONT_SIZE_OPTIONS: { value: CodeFontSize; label: string }[] =
  [
    { value: 11, label: '11px' },
    { value: 12, label: '12px' },
    { value: 13, label: '13px (Default)' },
    { value: 14, label: '14px' },
    { value: 15, label: '15px' },
    { value: 16, label: '16px' },
  ];

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'aurapunk-default',
    name: 'Aurapunk Default',
    description: 'Classic dark base with vibrant warm orange accents.',
    theme: {
      name: 'Aurapunk Default',
      canvasBg: '#121214',
      surfaceBg: '#1a1a1e',
      textColor: '#f4f4f5',
      textMutedColor: '#a1a1aa',
      borderColor: '#3f3f46',
      highlightColor: '#f97316',
      enableGradient: true,
      gradientColor1: '#f97316',
      gradientColor2: '#fb923c',
      gradientAngle: 135,
    },
    uiFontFamily: 'ibm-plex-sans',
    codeFontFamily: 'ibm-plex-mono',
  },
  {
    id: 'cyberpunk-neon',
    name: 'Cyberpunk Neon',
    description:
      'Ultra dark background with neon magenta and electric yellow gradient.',
    theme: {
      name: 'Cyberpunk Neon',
      canvasBg: '#090a0f',
      surfaceBg: '#12131f',
      textColor: '#f3f4f6',
      textMutedColor: '#9ca3af',
      borderColor: '#374151',
      highlightColor: '#ec4899',
      enableGradient: true,
      gradientColor1: '#ec4899',
      gradientColor2: '#facc15',
      gradientAngle: 135,
    },
    uiFontFamily: 'inter',
    codeFontFamily: 'fira-code',
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Deep navy tones and lavender inspired by Tokyo nights.',
    theme: {
      name: 'Tokyo Night',
      canvasBg: '#1a1b26',
      surfaceBg: '#24283b',
      textColor: '#c0caf5',
      textMutedColor: '#7aa2f7',
      borderColor: '#414868',
      highlightColor: '#7aa2f7',
      enableGradient: true,
      gradientColor1: '#7aa2f7',
      gradientColor2: '#bb9af7',
      gradientAngle: 135,
    },
    uiFontFamily: 'geist-sans',
    codeFontFamily: 'jetbrains-mono',
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description:
      'Cozy pastel palette with soft mauve and pink gradient highlights.',
    theme: {
      name: 'Catppuccin Mocha',
      canvasBg: '#1e1e2e',
      surfaceBg: '#181825',
      textColor: '#cdd6f4',
      textMutedColor: '#a6adc8',
      borderColor: '#45475a',
      highlightColor: '#cba6f7',
      enableGradient: true,
      gradientColor1: '#cba6f7',
      gradientColor2: '#f5c2e7',
      gradientAngle: 135,
    },
    uiFontFamily: 'inter',
    codeFontFamily: 'jetbrains-mono',
  },
  {
    id: 'sunset-synth',
    name: 'Sunset Synth',
    description: 'Synthwave vibes with sunset rose and amber gradient.',
    theme: {
      name: 'Sunset Synth',
      canvasBg: '#0f0c1b',
      surfaceBg: '#1b162c',
      textColor: '#f5e6f8',
      textMutedColor: '#bfa7cc',
      borderColor: '#584379',
      highlightColor: '#f43f5e',
      enableGradient: true,
      gradientColor1: '#f43f5e',
      gradientColor2: '#fb923c',
      gradientAngle: 135,
    },
    uiFontFamily: 'plus-jakarta-sans',
    codeFontFamily: 'fira-code',
  },
  {
    id: 'nordic-frost',
    name: 'Nordic Frost',
    description: 'Calm arctic tones with glacial blue gradient.',
    theme: {
      name: 'Nordic Frost',
      canvasBg: '#242933',
      surfaceBg: '#2e3440',
      textColor: '#eceff4',
      textMutedColor: '#d8dee9',
      borderColor: '#5e687e',
      highlightColor: '#88c0d0',
      enableGradient: true,
      gradientColor1: '#88c0d0',
      gradientColor2: '#81a1c1',
      gradientAngle: 135,
    },
    uiFontFamily: 'inter',
    codeFontFamily: 'jetbrains-mono',
  },
  {
    id: 'emerald-matrix',
    name: 'Emerald Matrix',
    description: 'Deep cybernetic green with vibrant emerald gradient.',
    theme: {
      name: 'Emerald Matrix',
      canvasBg: '#07120a',
      surfaceBg: '#0d1f13',
      textColor: '#dcfce7',
      textMutedColor: '#86efac',
      borderColor: '#2b6b3e',
      highlightColor: '#22c55e',
      enableGradient: true,
      gradientColor1: '#22c55e',
      gradientColor2: '#10b981',
      gradientAngle: 135,
    },
    uiFontFamily: 'geist-sans',
    codeFontFamily: 'source-code-pro',
  },
  {
    id: 'midnight-oled',
    name: 'Midnight OLED',
    description: 'Pure black for OLED displays with electric blue gradient.',
    theme: {
      name: 'Midnight OLED',
      canvasBg: '#000000',
      surfaceBg: '#121212',
      textColor: '#ffffff',
      textMutedColor: '#9e9e9e',
      borderColor: '#333333',
      highlightColor: '#38bdf8',
      enableGradient: true,
      gradientColor1: '#38bdf8',
      gradientColor2: '#6366f1',
      gradientAngle: 135,
    },
    uiFontFamily: 'inter',
    codeFontFamily: 'jetbrains-mono',
  },
  {
    id: 'paper-minimal-light',
    name: 'Paper Minimal (Light)',
    description: 'Warm paper minimalist light theme with terracotta highlight.',
    theme: {
      name: 'Paper Minimal (Light)',
      canvasBg: '#f8f7f4',
      surfaceBg: '#eeece6',
      textColor: '#1c1917',
      textMutedColor: '#78716c',
      borderColor: '#d6d3d1',
      highlightColor: '#ea580c',
      enableGradient: true,
      gradientColor1: '#ea580c',
      gradientColor2: '#d97706',
      gradientAngle: 135,
    },
    uiFontFamily: 'fira-sans',
    codeFontFamily: 'source-code-pro',
  },
];

const STYLE_TAG_ID = 'vk-custom-appearance-theme';

export function hexToHsl(hex: string): string {
  let c = hex.replace('#', '');
  if (c.length === 3) {
    c = c
      .split('')
      .map((x) => x + x)
      .join('');
  }
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function applyCustomAppearance(state: {
  uiFontFamily: UiFontFamily;
  codeFontFamily: CodeFontFamily;
  uiFontScale: UiFontScale;
  codeFontSize: CodeFontSize;
  customThemeEnabled: boolean;
  customTheme: CustomThemeConfig;
}): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  // 1. Apply Typography variables
  const uiFont =
    UI_FONT_OPTIONS.find((o) => o.value === state.uiFontFamily)?.family ||
    UI_FONT_OPTIONS[0].family;
  const codeFont =
    CODE_FONT_OPTIONS.find((o) => o.value === state.codeFontFamily)?.family ||
    CODE_FONT_OPTIONS[0].family;

  root.style.setProperty('--app-font-sans', uiFont);
  root.style.setProperty('--app-font-mono', codeFont);
  root.style.setProperty('--app-ui-scale', `${state.uiFontScale}%`);
  root.style.setProperty('--app-code-font-size', `${state.codeFontSize}px`);

  // 2. Custom theme & colors
  let styleEl = document.getElementById(
    STYLE_TAG_ID
  ) as HTMLStyleElement | null;

  // The old theme toggle has been retired. A custom palette is always active.

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_TAG_ID;
    document.head.appendChild(styleEl);
  }

  const {
    canvasBg,
    surfaceBg,
    textColor,
    textMutedColor,
    borderColor = '#27272a',
    highlightColor,
    enableGradient,
    gradientColor1,
    gradientColor2,
    gradientAngle = 135,
  } = state.customTheme;

  const canvasHsl = hexToHsl(canvasBg);
  const surfaceHsl = hexToHsl(surfaceBg);
  const textHsl = hexToHsl(textColor);
  const textMutedHsl = hexToHsl(textMutedColor);
  const borderHsl = hexToHsl(borderColor);
  const brandHsl = hexToHsl(highlightColor);

  const gradientString = `linear-gradient(${gradientAngle}deg, ${gradientColor1} 0%, ${gradientColor2} 100%)`;

  const css = `
    :root, html, .dark, .light {
      --bg-primary: ${canvasHsl} !important;
      --bg-canvas: ${canvasHsl} !important;
      --_bg-primary-default: ${canvasHsl} !important;
      --bg-secondary: ${surfaceHsl} !important;
      --bg-panel: ${surfaceHsl} !important;
      --bg-surface: ${surfaceHsl} !important;
      --_bg-secondary-default: ${surfaceHsl} !important;
      --_bg-panel-default: ${surfaceHsl} !important;

      --text-high: ${textHsl} !important;
      --text-normal: ${textHsl} !important;
      --fg-strong: ${textHsl} !important;
      --fg-default: ${textHsl} !important;

      --text-low: ${textMutedHsl} !important;
      --fg-muted: ${textMutedHsl} !important;
      --fg-subtle: ${textMutedHsl} !important;
      --_muted-foreground: ${textMutedHsl} !important;

      --border: ${borderHsl} !important;
      --border-strong: ${borderHsl} !important;
      --_border: ${borderHsl} !important;

      --brand: ${brandHsl} !important;
      --brand-hover: ${brandHsl} !important;
      --brand-active: ${brandHsl} !important;

      --custom-gradient: ${gradientString};
    }

    body {
      background-color: ${canvasBg} !important;
      color: ${textColor} !important;
    }

    ${
      enableGradient
        ? `
      .theme-gradient-active,
      button.bg-brand,
      .bg-brand {
        background-image: ${gradientString} !important;
        background-color: ${highlightColor} !important;
      }
      .text-brand-gradient {
        background: ${gradientString};
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .border-brand-gradient {
        border-image: ${gradientString} 1;
      }
    `
        : ''
    }
  `;

  styleEl.textContent = css;
}

export function useApplyCustomAppearance(): void {
  const uiFontFamily = useUiPreferencesStore((s) => s.uiFontFamily);
  const codeFontFamily = useUiPreferencesStore((s) => s.codeFontFamily);
  const uiFontScale = useUiPreferencesStore((s) => s.uiFontScale);
  const codeFontSize = useUiPreferencesStore((s) => s.codeFontSize);
  const customThemeEnabled = useUiPreferencesStore((s) => s.customThemeEnabled);
  const customTheme = useUiPreferencesStore((s) => s.customTheme);

  useEffect(() => {
    applyCustomAppearance({
      uiFontFamily,
      codeFontFamily,
      uiFontScale,
      codeFontSize,
      customThemeEnabled,
      customTheme,
    });
  }, [
    uiFontFamily,
    codeFontFamily,
    uiFontScale,
    codeFontSize,
    customThemeEnabled,
    customTheme,
  ]);
}

export function exportThemeToFile(
  theme: CustomThemeConfig,
  typography: {
    uiFontFamily: UiFontFamily;
    codeFontFamily: CodeFontFamily;
    uiFontScale: UiFontScale;
    codeFontSize: CodeFontSize;
  }
): void {
  const payload: ExportedThemePackage = {
    version: 1,
    exportedAt: new Date().toISOString(),
    theme,
    typography,
  };

  const fileName = `vk-theme-${(theme.name || 'custom')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')}.json`;

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function parseImportedTheme(
  jsonText: string
): ExportedThemePackage | null {
  try {
    const data = JSON.parse(jsonText);
    if (!data || typeof data !== 'object') return null;

    // Check if it's an ExportedThemePackage or standalone CustomThemeConfig
    if (data.theme && data.theme.canvasBg && data.theme.surfaceBg) {
      return data as ExportedThemePackage;
    }

    if (data.canvasBg && data.surfaceBg) {
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        theme: data as CustomThemeConfig,
        typography: {
          uiFontFamily: DEFAULT_UI_FONT_FAMILY,
          codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
          uiFontScale: DEFAULT_UI_FONT_SCALE,
          codeFontSize: DEFAULT_CODE_FONT_SIZE,
        },
      };
    }
  } catch {
    // Malformed JSON
  }
  return null;
}
