import type { ReactNode } from 'react';

/**
 * Minimal markdown rendering for agent prose — the subset that actually
 * appears in assistant turns and thinking: headings, unordered lists, fenced
 * code blocks, inline code, bold, italic, and http(s) links.
 *
 * Every token becomes a React element — no dangerouslySetInnerHTML — so a
 * prompt-injected `<script>` or `<img onerror>` is inert text by
 * construction. Links are restricted to http(s): anything else renders as
 * plain text rather than an anchor.
 *
 * Deliberately not added for v1: tables, images, nested lists. A renderer
 * dependency (react-markdown et al.) would drag a plugin tree into the shell
 * for markup agents almost never emit; revisit if the structured timeline
 * starts rendering arbitrary agent-authored documents.
 */

type InlineToken =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'link'; text: string; href: string };

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]*\]\(https?:\/\/[^)\s]*\))/g;

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index;
    if (start === undefined) continue;
    if (start > cursor) tokens.push({ t: 'text', v: text.slice(cursor, start) });
    const [raw] = match;
    if (raw === undefined) continue;
    if (raw.startsWith('`')) tokens.push({ t: 'code', v: raw.slice(1, -1) });
    else if (raw.startsWith('**')) tokens.push({ t: 'bold', v: raw.slice(2, -2) });
    else if (raw.startsWith('*')) tokens.push({ t: 'italic', v: raw.slice(1, -1) });
    else {
      const link = /^\[([^\]]*)\]\((https?:\/\/[^)\s]*)\)$/.exec(raw);
      if (link !== null && link[1] !== undefined && link[2] !== undefined) {
        tokens.push({ t: 'link', text: link[1], href: link[2] });
      } else {
        tokens.push({ t: 'text', v: raw });
      }
    }
    cursor = start + raw.length;
  }
  if (cursor < text.length) tokens.push({ t: 'text', v: text.slice(cursor) });
  return tokens;
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  return tokenizeInline(text).map((token, index) => {
    const key = `${keyBase}-${index}`;
    switch (token.t) {
      case 'code':
        return <code key={key}>{token.v}</code>;
      case 'bold':
        return <strong key={key}>{token.v}</strong>;
      case 'italic':
        return <em key={key}>{token.v}</em>;
      case 'link':
        return (
          <a key={key} href={token.href} target="_blank" rel="noreferrer noopener">
            {token.text}
          </a>
        );
      case 'text':
        return token.v;
    }
  });
}

type Block =
  | { t: 'heading'; level: 1 | 2 | 3; text: string; key: string }
  | { t: 'list'; items: string[]; key: string }
  | { t: 'code'; text: string; key: string }
  | { t: 'p'; text: string; key: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let index = 0;
  let plain: string[] = [];
  let key = 0;

  const flushPlain = () => {
    if (plain.length > 0) {
      blocks.push({ t: 'p', text: plain.join('\n'), key: `p${key++}` });
      plain = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (/^```/.test(line)) {
      flushPlain();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // consume the closing fence (or run off the open stream)
      blocks.push({ t: 'code', text: body.join('\n'), key: `code${key++}` });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      flushPlain();
      blocks.push({
        t: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2],
        key: `h${key++}`,
      });
      index += 1;
      continue;
    }
    const list = /^[-*]\s+(.*)$/.exec(line);
    if (list !== null && list[1] !== undefined) {
      flushPlain();
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^[-*]\s+(.*)$/.exec(lines[index] ?? '');
        if (item === null || item[1] === undefined) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ t: 'list', items, key: `ul${key++}` });
      continue;
    }
    if (line.trim() === '') {
      flushPlain();
      index += 1;
      continue;
    }
    plain.push(line);
    index += 1;
  }
  flushPlain();
  return blocks;
}

function renderBlock(block: Block): ReactNode {
  switch (block.t) {
    case 'heading': {
      const content = renderInline(block.text, block.key);
      if (block.level === 1) return <h1 key={block.key}>{content}</h1>;
      if (block.level === 2) return <h2 key={block.key}>{content}</h2>;
      return <h3 key={block.key}>{content}</h3>;
    }
    case 'list':
      return (
        <ul key={block.key}>
          {block.items.map((item, index) => (
            <li key={`${block.key}-${index}`}>{renderInline(item, `${block.key}-${index}`)}</li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre key={block.key}>
          <code>{block.text}</code>
        </pre>
      );
    case 'p':
      return <p key={block.key}>{renderInline(block.text, block.key)}</p>;
  }
}

/** Markdown blocks for agent prose; every token is an element — never markup. */
export function Markdown({ text }: { text: string }) {
  return <>{parseBlocks(text).map(renderBlock)}</>;
}
