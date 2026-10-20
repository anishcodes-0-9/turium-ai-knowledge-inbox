import type { ItemRecord, ItemStatus, SourceType } from '../domain.js';
import { makePreview } from '../services/textNormalizer.js';

/** Public item representation. Never includes embeddings or the full raw content. */
export interface ItemSummary {
  id: string;
  sourceType: SourceType;
  title: string;
  url: string | null;
  contentPreview: string;
  contentChars: number;
  chunkCount: number;
  status: ItemStatus;
  attempts: number;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ItemDetail extends ItemSummary {
  content: string | null;
}

export function toItemSummary(item: ItemRecord, chunkCount: number): ItemSummary {
  return {
    id: item.id,
    sourceType: item.sourceType,
    title: item.title,
    url: item.url,
    contentPreview: makePreview(item.content),
    contentChars: item.contentChars,
    chunkCount,
    status: item.status,
    attempts: item.attempts,
    error: item.errorCode ? { code: item.errorCode, message: item.errorMessage ?? '' } : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
  };
}

export function toItemDetail(item: ItemRecord, chunkCount: number): ItemDetail {
  return { ...toItemSummary(item, chunkCount), content: item.content };
}
