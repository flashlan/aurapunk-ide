import { lazy, Suspense, type ComponentProps } from 'react';
import type { ChangesPanelContainer as ChangesPanelContainerImpl } from './ChangesPanelContainer';

// The diff viewer stack (@pierre/diffs, syntax highlighting) loads when the
// Changes panel is first shown, not with the main bundle at startup.
const LazyImpl = lazy(() =>
  import('./ChangesPanelContainer').then((m) => ({
    default: m.ChangesPanelContainer,
  }))
);

export function ChangesPanelContainer(
  props: ComponentProps<typeof ChangesPanelContainerImpl>
) {
  return (
    <Suspense fallback={null}>
      <LazyImpl {...props} />
    </Suspense>
  );
}
