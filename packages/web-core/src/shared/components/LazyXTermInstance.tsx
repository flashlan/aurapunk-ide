import { lazy, Suspense, type ComponentProps } from 'react';
import type { XTermInstance as XTermInstanceImpl } from './XTermInstance';

// xterm and its WebGL renderer (~390 KB) load only when a terminal is shown,
// not with the main bundle at startup.
const LazyImpl = lazy(() =>
  import('./XTermInstance').then((m) => ({ default: m.XTermInstance }))
);

export function XTermInstance(props: ComponentProps<typeof XTermInstanceImpl>) {
  return (
    <Suspense fallback={null}>
      <LazyImpl {...props} />
    </Suspense>
  );
}
