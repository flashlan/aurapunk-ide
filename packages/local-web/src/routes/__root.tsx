import { Outlet, createRootRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import { ThemeMode } from 'shared/types';
import i18n from '@/i18n';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { ThemeProvider } from '@web/app/providers/ThemeProvider';
import { useUiPreferencesScratch } from '@/shared/hooks/useUiPreferencesScratch';
import { useApplyCustomAppearance } from '@/shared/lib/customTheme';
import { WorkspacesProvider } from '@/shared/providers/remote/WorkspacesProvider';
import '@/app/styles/new/index.css';

function RootRouteComponent() {
  const { config, loading } = useUserSystem();

  useUiPreferencesScratch();
  useApplyCustomAppearance();

  // Keep the native/startup splash visible until the backend configuration is
  // available and the real app tree can render. The backend performs SQLite
  // migrations and startup reconciliation before serving this request, so
  // hiding the splash on the first React frame exposed a long blank/loading
  // interval on packaged desktop builds.
  useEffect(() => {
    if (loading || !config) return;
    requestAnimationFrame(() => {
      (
        window as unknown as { __vkHideStartupBanner?: () => void }
      ).__vkHideStartupBanner?.();
    });
  }, [config, loading]);

  return (
    <I18nextProvider i18n={i18n}>
      {/* The legacy light/dark/CRT theme system is no longer applied. Keep
          the provider in dark mode for consumers that need a theme context;
          the active palette is controlled by useApplyCustomAppearance. */}
      <ThemeProvider initialTheme={ThemeMode.DARK}>
        <WorkspacesProvider>
          <Outlet />
        </WorkspacesProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}

export const Route = createRootRoute({
  component: RootRouteComponent,
});
