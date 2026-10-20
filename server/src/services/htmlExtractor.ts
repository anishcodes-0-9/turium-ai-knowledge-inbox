import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeText } from './textNormalizer.js';

export interface ExtractedPage {
  title: string;
  text: string;
  /** Which container the text was taken from, for diagnostics. */
  strategy: 'article' | 'main' | 'body' | 'plain';
}

const NOISE_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'object', 'embed',
  'nav', 'header', 'footer', 'aside', 'form', 'button', 'input', 'select', 'textarea',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]', '[aria-hidden="true"]',
  '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header', '.cookie', '.advert', '.ad', '.share', '.comments',
].join(',');

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'table', 'tr', 'br', 'hr', 'dd', 'dt', 'dl', 'figcaption', 'details', 'summary']);

/**
 * Extracts readable text from an HTML document. Not a full Readability port,
 * but removes the usual noise and prefers the semantic main content container
 * when it carries enough text. The result is untrusted user data and is
 * treated as such downstream (it is never interpreted as instructions).
 */
export function extractFromHtml(html: string, fallbackTitle: string): ExtractedPage {
  const $ = cheerio.load(html);
  const title = cleanTitle($('title').first().text()) || cleanTitle($('meta[property="og:title"]').attr('content') ?? '') || cleanTitle($('h1').first().text()) || fallbackTitle;
  $(NOISE_SELECTOR).remove();

  const candidates: Array<{ strategy: ExtractedPage['strategy']; nodes: AnyNode[] }> = [
    { strategy: 'article', nodes: $('article').toArray() },
    { strategy: 'main', nodes: [...$('main').toArray(), ...$('[role="main"]').toArray()] },
    { strategy: 'body', nodes: $('body').toArray() },
  ];
  for (const c of candidates) {
    if (c.nodes.length === 0) continue;
    const text = normalizeText(c.nodes.map((n) => toText($, n)).join('\n\n'));
    if (text.length >= 200 || c.strategy === 'body') return { title, text, strategy: c.strategy };
  }
  return { title, text: normalizeText($.root().text()), strategy: 'body' };
}

export function extractFromPlainText(text: string, fallbackTitle: string): ExtractedPage {
  const normalized = normalizeText(text);
  const firstLine = normalized.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return { title: firstLine ? firstLine.slice(0, 80) : fallbackTitle, text: normalized, strategy: 'plain' };
}

function cleanTitle(t: string): string {
  return t.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Depth-first text serialisation that inserts line breaks at block boundaries. */
function toText($: cheerio.CheerioAPI, node: AnyNode): string {
  if (node.type === 'text') return node.data;
  if (node.type !== 'tag') return '';
  const tag = node.name.toLowerCase();
  const inner = node.children.map((c) => toText($, c)).join('');
  return BLOCK_TAGS.has(tag) ? `\n${inner}\n` : inner;
}
