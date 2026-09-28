import { describe, expect, it } from 'vitest';
import { accountInitials, syncSummary } from './SidebarAccountFooter';

describe('SidebarAccountFooter helpers', () => {
  it('builds initials from the name, falling back to the email', () => {
    expect(accountInitials('Everton Kacy', 'e@x.dev')).toBe('EK');
    expect(accountInitials('', 'everton.kacy@x.dev')).toBe('EK');
    expect(accountInitials(undefined, 'everton@x.dev')).toBe('EV');
  });

  it('summarizes the cloud sync state', () => {
    expect(syncSummary(false, undefined)).toEqual({
      tone: 'off',
      label: 'Local only',
    });
    expect(
      syncSummary(true, { connected: true, pending: 0, last_error: null })
    ).toEqual({ tone: 'ok', label: 'Cloud synced' });
    expect(
      syncSummary(true, { connected: true, pending: 3, last_error: null }).label
    ).toBe('Syncing 3…');
    expect(
      syncSummary(true, { connected: true, pending: 0, last_error: 'boom' })
    ).toMatchObject({ tone: 'error', detail: 'boom' });
  });
});
