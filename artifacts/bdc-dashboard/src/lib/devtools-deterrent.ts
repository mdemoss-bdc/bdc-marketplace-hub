/**
 * devtools-deterrent.ts
 *
 * Passive UI deterrent against casual browser inspection.
 * Only activates on PRODUCTION builds (import.meta.env.PROD).
 *
 * These measures slow down casual visitors — they are NOT a substitute
 * for proper server-side auth and API access control, which is where
 * all sensitive business logic lives.
 */

type Cleanup = () => void;

/** Suppress the browser's default right-click context menu. */
function blockContextMenu(): Cleanup {
  const handler = (e: MouseEvent) => e.preventDefault();
  document.addEventListener('contextmenu', handler);
  return () => document.removeEventListener('contextmenu', handler);
}

/**
 * Block common DevTools keyboard shortcuts:
 *   F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C, Ctrl+U
 *   Cmd+Option+I (macOS)
 */
function blockDevToolsKeys(): Cleanup {
  const handler = (e: KeyboardEvent) => {
    const ctrl  = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const alt   = e.altKey;
    const key   = e.key.toUpperCase();

    const isDevToolsShortcut =
      e.key === 'F12' ||
      (ctrl && shift && (key === 'I' || key === 'J' || key === 'C')) ||
      (ctrl && !shift && key === 'U') ||
      (e.metaKey && alt && key === 'I'); // Cmd+Option+I on macOS

    if (isDevToolsShortcut) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', handler, { capture: true });
  return () => document.removeEventListener('keydown', handler, { capture: true });
}

/**
 * Disable text selection across the page via CSS.
 * Reduces trivial copy-paste of visible UI text.
 */
function disableTextSelection(): Cleanup {
  const style = document.createElement('style');
  style.id = '__bdc_sec';
  style.textContent = `
    * {
      -webkit-user-select: none !important;
      -moz-user-select: none !important;
      -ms-user-select: none !important;
      user-select: none !important;
    }
    input, textarea, [contenteditable] {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      user-select: text !important;
    }
  `;
  document.head.appendChild(style);
  return () => document.getElementById('__bdc_sec')?.remove();
}

/**
 * Activate all deterrents. Returns a single cleanup function.
 * Call only once at the application root.
 */
export function activateDevToolsDeterrent(): Cleanup {
  // Only run in production — never block developer workflow locally.
  if (!import.meta.env.PROD) {
    return () => {};
  }

  const cleanups: Cleanup[] = [
    blockContextMenu(),
    blockDevToolsKeys(),
    disableTextSelection(),
  ];

  return () => cleanups.forEach((fn) => fn());
}
