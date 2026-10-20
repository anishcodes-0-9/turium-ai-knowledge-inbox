import { z } from 'zod';

/** Request contracts (validated at the edge). Response shapes live in `contracts.ts`. */

export const ingestNoteSchema = z.object({
  type: z.literal('note'),
  content: z.string().min(1, 'content is required').max(200_000, 'content is too large'),
  title: z.string().trim().max(200).optional(),
});

export const ingestUrlSchema = z.object({
  type: z.literal('url'),
  url: z.string().trim().min(1, 'url is required').max(2048, 'url is too long'),
  title: z.string().trim().max(200).optional(),
});

export const ingestBodySchema = z.discriminatedUnion('type', [ingestNoteSchema, ingestUrlSchema], {
  error: () => ({ message: 'type must be "note" or "url"' }),
});
export type IngestBody = z.infer<typeof ingestBodySchema>;

export const listItemsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const queryBodySchema = z.object({
  question: z.string().trim().min(3, 'question must be at least 3 characters').max(2000, 'question is too long'),
  topK: z.number().int().min(1).max(20).optional(),
  minScore: z.number().min(-1).max(1).optional(),
});
export type QueryBody = z.infer<typeof queryBodySchema>;

export const itemIdParamSchema = z.object({ id: z.string().uuid('item id must be a UUID') });
