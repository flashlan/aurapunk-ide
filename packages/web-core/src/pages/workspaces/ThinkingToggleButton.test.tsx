// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThinkingToggleButton } from './ThinkingToggleButton';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';

afterEach(() => {
  cleanup();
  useUiPreferencesStore.getState().setThinkingExpanded(true);
});

describe('ThinkingToggleButton', () => {
  it('renders a pressed toggle when thinking is expanded', () => {
    useUiPreferencesStore.getState().setThinkingExpanded(true);
    render(<ThinkingToggleButton />);
    const button = screen.getByRole('button', { name: 'Hide thinking' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('collapses thinking (and flips its own label) when clicked', () => {
    useUiPreferencesStore.getState().setThinkingExpanded(true);
    render(<ThinkingToggleButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide thinking' }));

    expect(useUiPreferencesStore.getState().thinkingExpanded).toBe(false);
    expect(screen.getByRole('button', { name: 'Show thinking' })).toBeTruthy();
  });
});
