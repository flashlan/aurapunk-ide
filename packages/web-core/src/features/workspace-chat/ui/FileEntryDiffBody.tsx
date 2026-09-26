import type { ChatFileEntryDiffInput } from '@vibe/ui/components/ChatFileEntry';
import {
  DiffViewBody,
  useDiffData,
} from '@vibe/ui/components/PierreConversationDiff';
import { getActualTheme } from '@/shared/lib/theme';
import { useTheme } from '@/shared/hooks/useTheme';
import { useDiffViewMode } from '@/shared/stores/useDiffViewStore';

/**
 * Expanded diff of a chat file-edit entry. Lives in its own module so the
 * diff stack (@pierre/diffs) loads only when an entry is actually expanded,
 * not with the main bundle.
 */
export default function FileEntryDiffBody({
  diffContent,
}: {
  diffContent: ChatFileEntryDiffInput;
}) {
  const { theme } = useTheme();
  const actualTheme = getActualTheme(theme);
  const diffMode = useDiffViewMode();
  const diffData = useDiffData(diffContent);

  if (!diffData.isValid) {
    return null;
  }

  return (
    <DiffViewBody
      fileDiffMetadata={diffData.fileDiffMetadata}
      unifiedDiff={diffData.unifiedDiff}
      isValid={diffData.isValid}
      hideLineNumbers={diffData.hideLineNumbers}
      theme={actualTheme}
      diffMode={diffMode}
    />
  );
}
