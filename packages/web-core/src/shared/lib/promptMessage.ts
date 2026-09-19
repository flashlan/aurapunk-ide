function isSlashCommandPrompt(prompt: string): boolean {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) return false;

  const match = /^\/([^\s/]+)(?:\s|$)/.exec(trimmed);
  if (!match) return false;

  return true;
}

export function buildAgentPrompt(
  rawUserMessage: string,
  contextParts: (string | null | undefined)[]
) {
  let trimmed = rawUserMessage.trim();
  const isSlashCommand = !!trimmed && isSlashCommandPrompt(trimmed);

  // Normalize aliases like /compress, /autocompress, /autocompact to /compact
  // so underlying agents (Claude Code, OpenCode, etc.) execute cleanly
  if (isSlashCommand) {
    const aliasMatch = /^\/(?:compress|autocompress|autocompact)(\s.*)?$/i.exec(trimmed);
    if (aliasMatch) {
      const rest = aliasMatch[1] ? aliasMatch[1] : '';
      trimmed = `/compact${rest}`;
    }
  }

  const parts = isSlashCommand
    ? [trimmed]
    : [...contextParts, rawUserMessage].filter(Boolean);

  return {
    prompt: parts.join('\n\n'),
    isSlashCommand,
  };
}
