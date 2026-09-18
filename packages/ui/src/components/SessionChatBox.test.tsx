/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionChatBox, type ExecutionStatus } from './SessionChatBox';

afterEach(cleanup);

function renderChatBox(status: ExecutionStatus) {
  const actions = {
    onSend: vi.fn(),
    onQueue: vi.fn(),
    onSendNow: vi.fn(),
    onCancelQueue: vi.fn(),
    onStop: vi.fn(),
    onClearEditor: vi.fn(),
    onPasteFiles: vi.fn(),
  };

  render(
    <SessionChatBox
      status={status}
      editor={{ value: 'new direction', onChange: vi.fn() }}
      renderEditor={() => <textarea aria-label="Message" />}
      actions={actions}
      session={{
        sessions: [
          {
            id: 'session-1',
            name: 'Session',
            created_at: '2026-09-18T00:00:00Z',
          },
        ],
        selectedSessionId: 'session-1',
        onSelectSession: vi.fn(),
      }}
    />
  );

  return actions;
}

describe('SessionChatBox send-now controls', () => {
  it('keeps Queue, Send now, and Stop available while running', () => {
    const actions = renderChatBox('running');

    fireEvent.click(
      screen.getByRole('button', { name: 'conversation.actions.queue' })
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'conversation.actions.sendNow' })
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'conversation.actions.stop' })
    );

    expect(actions.onQueue).toHaveBeenCalledOnce();
    expect(actions.onSendNow).toHaveBeenCalledOnce();
    expect(actions.onStop).toHaveBeenCalledOnce();
  });

  it('can promote an already queued message without removing Stop', () => {
    const actions = renderChatBox('queued');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'conversation.actions.cancelQueue',
      })
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'conversation.actions.sendNow' })
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'conversation.actions.stop' })
    );

    expect(actions.onCancelQueue).toHaveBeenCalledOnce();
    expect(actions.onSendNow).toHaveBeenCalledOnce();
    expect(actions.onStop).toHaveBeenCalledOnce();
  });
});
