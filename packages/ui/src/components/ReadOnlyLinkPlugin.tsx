import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LinkNode } from '@lexical/link';

interface ReadOnlyLinkPluginProps {
  /** Called when a relative/file link is clicked. If not provided, relative links are non-clickable. */
  onRelativeLinkClick?: (href: string) => void;
}

/**
 * Sanitize href to block dangerous protocols.
 * Returns undefined if the href is blocked.
 */
function sanitizeHref(href?: string): string | undefined {
  if (typeof href !== 'string') return undefined;
  const trimmed = href.trim();
  if (!trimmed) return undefined;
  // Block dangerous protocols
  if (/^(javascript|vbscript|data|blob):/i.test(trimmed)) return undefined;
  // Allow safe explicit protocols (http, https, mailto)
  if (/^(https?|mailto):/i.test(trimmed)) return trimmed;
  // Block other protocol-prefixed URLs
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  // Allow relative paths, anchors, and bare filenames (e.g. SPEC.md, ./docs/file.md)
  return trimmed;
}

/**
 * Check if href should be opened externally (HTTP/HTTPS/mailto).
 */
function isExternalHref(href?: string): boolean {
  if (!href) return false;
  return /^(https?:\/\/|mailto:)/i.test(href);
}

/**
 * Plugin that handles link sanitization and click behaviour in read-only mode.
 *
 * Root cause: Lexical sets contenteditable="false" on the editor root, which
 * causes browsers to suppress native <a> navigation. Every link type therefore
 * needs an explicit onclick that calls window.open() or a custom handler.
 *
 * - Dangerous protocols (javascript:, vbscript:, data:, blob:): href removed, non-clickable.
 * - External HTTP/HTTPS links: open via window.open() in a new tab.
 * - Relative / file links: call onRelativeLinkClick if provided; otherwise non-clickable.
 */
export function ReadOnlyLinkPlugin({
  onRelativeLinkClick,
}: ReadOnlyLinkPluginProps = {}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const processLink = (link: HTMLAnchorElement) => {
      const href = link.getAttribute('href');
      const safeHref = sanitizeHref(href ?? undefined);

      if (!safeHref) {
        link.removeAttribute('href');
        link.style.cursor = 'not-allowed';
        link.style.pointerEvents = 'none';
        return;
      }

      if (isExternalHref(safeHref)) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        // contenteditable="false" blocks native <a> navigation, so we must
        // call window.open() explicitly instead of relying on the browser default.
        link.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(safeHref, '_blank', 'noopener,noreferrer');
        };
      } else if (onRelativeLinkClick) {
        // Relative/file link with a handler — make it clickable
        link.removeAttribute('href');
        link.style.cursor = 'pointer';
        link.style.removeProperty('pointer-events');
        link.setAttribute('role', 'link');
        link.title = href ?? safeHref;
        link.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          onRelativeLinkClick(safeHref);
        };
      } else {
        // Relative link without a handler — disable
        link.removeAttribute('href');
        link.style.cursor = 'not-allowed';
        link.style.pointerEvents = 'none';
        link.setAttribute('role', 'link');
        link.setAttribute('aria-disabled', 'true');
        link.title = href ?? '';
      }
    };

    const unregister = editor.registerMutationListener(
      LinkNode,
      (mutations) => {
        for (const [nodeKey, mutation] of mutations) {
          if (mutation === 'destroyed') continue;
          const dom = editor.getElementByKey(nodeKey);
          if (!dom || !(dom instanceof HTMLAnchorElement)) continue;
          processLink(dom);
        }
      }
    );

    // Apply to links already in the DOM on mount
    editor.getEditorState().read(() => {
      const root = editor.getRootElement();
      if (!root) return;
      root.querySelectorAll('a').forEach((link) => processLink(link));
    });

    return unregister;
  }, [editor, onRelativeLinkClick]);

  return null;
}
