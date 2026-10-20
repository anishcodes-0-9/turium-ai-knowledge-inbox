export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Queued',
  processing: 'Processing',
  indexed: 'Ready',
  failed: 'Failed',
};
