/**
 * Client-side layout file I/O for the standalone (browser) runtime.
 *
 * In VS Code the extension host reads/writes layout files through native
 * save/open dialogs. In the browser there is no filesystem access, so export
 * becomes a Blob download and import reads a user-picked File client-side.
 */

const LAYOUT_DOWNLOAD_NAME = 'pixel-agents-layout.json';

/** Trigger a browser download of the given layout as a pretty-printed JSON file. */
export function downloadLayoutFile(layout: unknown): void {
  const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = LAYOUT_DOWNLOAD_NAME;
  a.click();
  URL.revokeObjectURL(url);
}

/** Read a user-picked File as parsed layout JSON. Rejects on invalid JSON. */
export async function readLayoutFile(file: File): Promise<Record<string, unknown>> {
  const text = await file.text();
  return JSON.parse(text) as Record<string, unknown>;
}
