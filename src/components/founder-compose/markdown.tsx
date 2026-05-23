/**
 * Lightweight Reddit-flavoured markdown renderer.
 *
 * No external deps. Pure TS + React. Covers the subset a founder
 * actually uses in Reddit selftext + dev.to drafts: headings, bold,
 * italic, inline code, code fences, ordered + unordered lists, links,
 * and paragraphs. Auto-paragraphs blank-line-separated blocks.
 *
 * Intentional non-features:
 *   - tables                  (founder posts almost never need them)
 *   - images                  (creative is attached separately)
 *   - blockquotes             (rare on Reddit; future addition)
 *   - HTML pass-through       (XSS surface; not worth it)
 *
 * Output is plain React elements — no dangerouslySetInnerHTML.
 */

import { Fragment } from "react";

export interface MarkdownProps {
  source: string;
  /** Tailwind classes applied to the root container. Defaults to a
   *  prose-y stack: text-sm, leading-relaxed, space-y-2. */
  className?: string;
}

type Block =
  | { type: "h1" | "h2" | "h3"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "p"; text: string }
  | { type: "blank" };

function tokenizeBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Code fence ```lang ... ```
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? null;
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence
      blocks.push({ type: "code", lang, text: buf.join("\n") });
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const level = h[1].length as 1 | 2 | 3;
      blocks.push({
        type: (`h${level}` as "h1" | "h2" | "h3"),
        text: h[2],
      });
      i += 1;
      continue;
    }

    // Unordered list (consecutive lines starting with -, *, or +)
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Blank line
    if (/^\s*$/.test(line)) {
      blocks.push({ type: "blank" });
      i += 1;
      continue;
    }

    // Paragraph — accumulate until blank line / block boundary
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "p", text: buf.join(" ") });
  }
  return blocks;
}

// Inline tokens: **bold**, *italic*, `code`, [text](url)
interface InlineToken {
  type: "text" | "bold" | "italic" | "code" | "link";
  text: string;
  href?: string;
}

function tokenizeInline(src: string): InlineToken[] {
  const out: InlineToken[] = [];
  let i = 0;
  let buf = "";
  const push = () => {
    if (buf) {
      out.push({ type: "text", text: buf });
      buf = "";
    }
  };
  while (i < src.length) {
    const rest = src.slice(i);

    // Inline code: `code` (must close on the same string)
    const codeMatch = /^`([^`\n]+)`/.exec(rest);
    if (codeMatch) {
      push();
      out.push({ type: "code", text: codeMatch[1] });
      i += codeMatch[0].length;
      continue;
    }

    // Bold: **text**
    const boldMatch = /^\*\*([^*]+)\*\*/.exec(rest);
    if (boldMatch) {
      push();
      out.push({ type: "bold", text: boldMatch[1] });
      i += boldMatch[0].length;
      continue;
    }

    // Italic: *text* (not part of **)
    const italMatch = /^\*([^*\n]+)\*/.exec(rest);
    if (italMatch) {
      push();
      out.push({ type: "italic", text: italMatch[1] });
      i += italMatch[0].length;
      continue;
    }

    // Link: [text](url)
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rest);
    if (linkMatch) {
      push();
      out.push({ type: "link", text: linkMatch[1], href: linkMatch[2] });
      i += linkMatch[0].length;
      continue;
    }

    buf += src[i];
    i += 1;
  }
  push();
  return out;
}

function InlineRender({ tokens }: { tokens: InlineToken[] }) {
  return (
    <>
      {tokens.map((t, idx) => {
        switch (t.type) {
          case "text":
            return <Fragment key={idx}>{t.text}</Fragment>;
          case "bold":
            return <strong key={idx}>{t.text}</strong>;
          case "italic":
            return <em key={idx}>{t.text}</em>;
          case "code":
            return (
              <code
                key={idx}
                className="font-mono text-[12px] bg-ink-100 text-ink-800 rounded px-1"
              >
                {t.text}
              </code>
            );
          case "link":
            return (
              <a
                key={idx}
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-signal-700 underline"
              >
                {t.text}
              </a>
            );
        }
      })}
    </>
  );
}

export function Markdown({ source, className }: MarkdownProps) {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return (
      <div className={className ?? ""}>
        <p className="text-xs text-ink-400 italic">Nothing to preview yet.</p>
      </div>
    );
  }
  const blocks = tokenizeBlocks(trimmed);
  return (
    <div className={className ?? "text-sm leading-relaxed space-y-2.5"}>
      {blocks.map((b, idx) => {
        switch (b.type) {
          case "h1":
            return (
              <h1 key={idx} className="text-xl font-semibold text-ink-900">
                <InlineRender tokens={tokenizeInline(b.text)} />
              </h1>
            );
          case "h2":
            return (
              <h2 key={idx} className="text-base font-semibold text-ink-900">
                <InlineRender tokens={tokenizeInline(b.text)} />
              </h2>
            );
          case "h3":
            return (
              <h3
                key={idx}
                className="text-sm font-semibold text-ink-900 uppercase tracking-wide"
              >
                <InlineRender tokens={tokenizeInline(b.text)} />
              </h3>
            );
          case "ul":
            return (
              <ul
                key={idx}
                className="list-disc list-inside text-sm text-ink-800 space-y-1"
              >
                {b.items.map((item, j) => (
                  <li key={j}>
                    <InlineRender tokens={tokenizeInline(item)} />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol
                key={idx}
                className="list-decimal list-inside text-sm text-ink-800 space-y-1"
              >
                {b.items.map((item, j) => (
                  <li key={j}>
                    <InlineRender tokens={tokenizeInline(item)} />
                  </li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre
                key={idx}
                className="font-mono text-xs leading-relaxed bg-ink-50 border border-ink-200 rounded-md p-3 overflow-x-auto"
              >
                {b.text}
              </pre>
            );
          case "p":
            return (
              <p
                key={idx}
                className="text-sm text-ink-800 leading-relaxed whitespace-pre-wrap"
              >
                <InlineRender tokens={tokenizeInline(b.text)} />
              </p>
            );
          case "blank":
            return null;
        }
      })}
    </div>
  );
}
