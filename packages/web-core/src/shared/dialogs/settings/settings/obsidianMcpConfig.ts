import type { JsonValue } from 'shared/types';

export const OBSIDIAN_MCP_SERVER_ID = 'obsidian';
export const OBSIDIAN_MCP_PACKAGE = 'obsidian-mcp@2';

type JsonObject = Record<string, JsonValue>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAbsoluteVaultPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

export function isValidVaultId(vaultId: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(vaultId);
}

export function createObsidianMcpServer(
  vaultPath: string,
  vaultId: string
): JsonObject {
  return {
    command: 'npx',
    args: [
      '-y',
      OBSIDIAN_MCP_PACKAGE,
      'serve',
      '--vault',
      `${vaultId}=${vaultPath}`,
    ],
  };
}

export function readObsidianMcpSettings(servers: JsonObject): {
  vaultPath: string;
  vaultId: string;
} | null {
  const server = servers[OBSIDIAN_MCP_SERVER_ID];
  if (!isJsonObject(server) || server.command !== 'npx') return null;
  const args = server.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return null;
  }
  const packageIndex = args.indexOf(OBSIDIAN_MCP_PACKAGE);
  const vaultFlagIndex = args.indexOf('--vault');
  if (packageIndex < 0 || vaultFlagIndex < 0) return null;
  const vault = args[vaultFlagIndex + 1];
  if (typeof vault !== 'string') return null;
  const separatorIndex = vault.indexOf('=');
  if (separatorIndex <= 0) return null;
  return {
    vaultId: vault.slice(0, separatorIndex),
    vaultPath: vault.slice(separatorIndex + 1),
  };
}
