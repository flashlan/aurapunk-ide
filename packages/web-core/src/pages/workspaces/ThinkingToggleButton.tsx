import { ChatDotsIcon } from '@phosphor-icons/react';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { useThinkingExpanded } from '@/shared/stores/useUiPreferencesStore';

/**
 * Show/hide-thinking toggle for the floating ContextBar.
 *
 * Mirrors the header toggle in `ProjectRightSidebarContainer`, which is only
 * reachable while a workspace conversation is docked in the kanban sidebar.
 * The workspace view has no header, so the same control lives in the bar.
 */
export function ThinkingToggleButton() {
  const [thinkingExpanded, setThinkingExpanded] = useThinkingExpanded();
  const label = thinkingExpanded ? 'Hide thinking' : 'Show thinking';

  return (
    <Tooltip content={label} side="left">
      <button
        type="button"
        className="flex items-center justify-center transition-colors drop-shadow-[2px_2px_4px_rgba(121,121,121,0.25)] text-low group-hover:text-normal"
        aria-label={label}
        aria-pressed={thinkingExpanded}
        onClick={() => setThinkingExpanded(!thinkingExpanded)}
      >
        <ChatDotsIcon
          className="size-icon-base"
          weight={thinkingExpanded ? 'fill' : 'regular'}
        />
      </button>
    </Tooltip>
  );
}
