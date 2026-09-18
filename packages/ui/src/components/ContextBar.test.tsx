/**
 * @vitest-environment jsdom
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayIcon } from '@phosphor-icons/react';
import { ContextBar } from './ContextBar';

afterEach(cleanup);

function renderBar(onClick = vi.fn()) {
  const view = render(
    <ContextBar
      style={{}}
      isDragging={false}
      onDragHandleMouseDown={() => {}}
      secondaryItems={[
        {
          type: 'action',
          key: 'action-1',
          label: 'Start dev server',
          tooltip: 'Start dev server',
          shortcut: 'T D',
          icon: PlayIcon,
          onClick,
        },
      ]}
    />
  );
  return { ...view, onClick };
}

describe('ContextBar tooltips', () => {
  it('forwards the Radix trigger props onto the underlying button', () => {
    renderBar();
    const button = screen.getByRole('button', { name: 'Start dev server' });
    // Radix Tooltip.Trigger (asChild) injects `data-state`; it only reaches the
    // DOM when the child component spreads its props — the regression guard.
    expect(button.getAttribute('data-state')).toBe('closed');
  });

  it('opens the tooltip on hover', async () => {
    renderBar();
    const button = screen.getByRole('button', { name: 'Start dev server' });
    fireEvent.pointerMove(button);
    await waitFor(() => {
      const tooltip = document.querySelector('[data-side="left"]');
      expect(tooltip?.textContent).toContain('Start dev server');
    });
  });

  it('keeps the item click handler working', () => {
    const { onClick } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Start dev server' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
