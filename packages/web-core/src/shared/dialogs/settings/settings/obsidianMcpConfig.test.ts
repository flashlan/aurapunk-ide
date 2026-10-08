import { describe, expect, it } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import {
  createObsidianMcpServer,
  isAbsoluteVaultPath,
  isValidVaultId,
  readObsidianMcpSettings,
} from './obsidianMcpConfig';

describe('Obsidian MCP configuration', () => {
  it('creates the pinned stdio server configuration', () => {
    expect(
      createObsidianMcpServer(
        '/Users/me/Notes',
        'team_notes',
        BaseCodingAgent.CLAUDE_CODE
      )
    ).toEqual({
      command: 'npx',
      args: [
        '-y',
        'obsidian-mcp@2',
        'serve',
        '--vault',
        'team_notes=/Users/me/Notes',
      ],
    });
  });

  it('reads a configured vault back from a server map', () => {
    expect(
      readObsidianMcpSettings({
        obsidian: createObsidianMcpServer(
          '/Users/me/Notes',
          'notes',
          BaseCodingAgent.CLAUDE_CODE
        ),
      })
    ).toEqual({ vaultId: 'notes', vaultPath: '/Users/me/Notes' });
  });

  it('validates absolute paths and safe vault identifiers', () => {
    expect(isAbsoluteVaultPath('/Users/me/Notes')).toBe(true);
    expect(isAbsoluteVaultPath('C:\\Notes')).toBe(true);
    expect(isAbsoluteVaultPath('notes')).toBe(false);
    expect(isValidVaultId('team_notes-2026')).toBe(true);
    expect(isValidVaultId('Team Notes')).toBe(false);
  });

  it("writes OpenCode's typed local-server format", () => {
    expect(
      createObsidianMcpServer(
        '/Users/me/Notes',
        'notes',
        BaseCodingAgent.OPENCODE
      )
    ).toEqual({
      type: 'local',
      command: [
        'npx',
        '-y',
        'obsidian-mcp@2',
        'serve',
        '--vault',
        'notes=/Users/me/Notes',
      ],
      enabled: true,
    });
  });
});
