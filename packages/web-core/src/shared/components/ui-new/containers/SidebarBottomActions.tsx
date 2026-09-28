import { SidebarAccountFooter } from './SidebarAccountFooter';

/**
 * Bottom sidebar content (ADR-010): the account footer — account and cloud
 * sync state, Mem0 and RLCD health, and the account / mobile / settings menu.
 */
export function SidebarBottomActions() {
  return <SidebarAccountFooter />;
}
