/**
 * Normalises raw text before chunking without destroying meaning:
 *  - unifies line endings and strips control characters (keeps \n and \t)
 *  - collapses runs of spaces/tabs inside a line
 *  - collapses 3+ blank lines to a single paragraph break
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Short preview used in list responses so raw content is never shipped wholesale. */
export function makePreview(text: string | null, maxChars = 200): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Derives a title for a note from its first line, falling back to a generic label. */
export function deriveNoteTitle(content: string, maxChars = 80): string {
  const firstLine = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (!firstLine) return 'Untitled note';
  return firstLine.length <= maxChars ? firstLine : `${firstLine.slice(0, maxChars - 1).trimEnd()}…`;
}
