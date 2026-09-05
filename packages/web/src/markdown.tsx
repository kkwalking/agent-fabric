import { ReactNode } from "react";

/**
 * Minimal Markdown → React renderer for agent messages.
 *
 * Covers what harness responses actually emit — fenced code blocks,
 * headings, lists (incl. nesting and task checkboxes), tables, quotes,
 * rules, and inline code/bold/italic/strike/links — while staying
 * dependency-free. Everything renders as React elements (no
 * dangerouslySetInnerHTML), so model output can never inject HTML.
 */

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

function parseInline(src: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = "";
  let k = 0;
  const nk = () => `${keyBase}-i${k++}`;
  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "`") {
      const m = /^(`+)([\s\S]*?)\1/.exec(src.slice(i));
      if (m) {
        flush();
        nodes.push(<code key={nk()}>{m[2]}</code>);
        i += m[0].length;
        continue;
      }
    }

    if ((ch === "*" && src[i + 1] === "*") || (ch === "_" && src[i + 1] === "_")) {
      const mark = src.slice(i, i + 2);
      const end = src.indexOf(mark, i + 2);
      if (end > i + 2 && src[i + 2] !== " ") {
        flush();
        const key = nk();
        nodes.push(<strong key={key}>{parseInline(src.slice(i + 2, end), key)}</strong>);
        i = end + 2;
        continue;
      }
    }

    if (ch === "~" && src[i + 1] === "~") {
      const end = src.indexOf("~~", i + 2);
      if (end > i + 2) {
        flush();
        const key = nk();
        nodes.push(<del key={key}>{parseInline(src.slice(i + 2, end), key)}</del>);
        i = end + 2;
        continue;
      }
    }

    // *italic* — content must be non-empty and space-free at the edges so
    // multiplication ("3 * 4") and list bullets are not mangled.
    if (ch === "*") {
      const m = /^\*([^*\n]+)\*/.exec(src.slice(i));
      if (m && m[1] === m[1].trim()) {
        flush();
        const key = nk();
        nodes.push(<em key={key}>{parseInline(m[1], key)}</em>);
        i += m[0].length;
        continue;
      }
    }

    if (ch === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m) {
        const href = safeHref(m[2]);
        flush();
        const key = nk();
        nodes.push(
          href ? (
            <a key={key} href={href} target="_blank" rel="noreferrer">
              {parseInline(m[1], key)}
            </a>
          ) : (
            <span key={key}>{parseInline(m[1], key)}</span>
          )
        );
        i += m[0].length;
        continue;
      }
    }

    if (ch === "\n") {
      flush();
      nodes.push(<br key={nk()} />);
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flush();
  return nodes;
}

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s*(?:[-*_]\s*){3,}$/;
const QUOTE_RE = /^\s*>/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+/;

function isTableSep(line: string): boolean {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  if (!t.includes("-")) return false;
  return t.split("|").every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

interface ListEntry {
  indent: number;
  ordered: boolean;
  text: string;
}

function buildList(items: ListEntry[], baseIndent: number, keyBase: string): ReactNode {
  const ordered = items[0].ordered;
  const out: ReactNode[] = [];
  let idx = 0;
  let k = 0;
  const nk = () => `${keyBase}-l${k++}`;
  while (idx < items.length) {
    let end = idx + 1;
    while (end < items.length && items[end].indent > baseIndent) end++;
    const it = items[idx];
    const childItems = items.slice(idx + 1, end);

    let content = it.text;
    let task: ReactNode = null;
    const t = TASK_RE.exec(content);
    if (t) {
      content = content.slice(t[0].length);
      task = <input type="checkbox" disabled checked={t[1] !== " "} className="md-task-box" />;
    }
    const key = nk();
    const inner = task ? (
      <>
        {task}
        {parseInline(content, key)}
      </>
    ) : (
      parseInline(content, key)
    );
    out.push(
      childItems.length ? (
        <li key={key}>
          {inner}
          {buildList(childItems, childItems[0].indent, key)}
        </li>
      ) : (
        <li key={key}>{inner}</li>
      )
    );
    idx = end;
  }
  return ordered ? <ol>{out}</ol> : <ul>{out}</ul>;
}

function parseBlocks(src: string, keyBase: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const nk = () => `${keyBase}-b${k++}`;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      blocks.push(
        <pre key={nk()} className="md-code">
          {fence[2] && <div className="md-code-lang">{fence[2]}</div>}
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length}` as "h1";
      blocks.push(<Tag key={nk()}>{parseInline(heading[2], nk())}</Tag>);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push(<hr key={nk()} />);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(<blockquote key={nk()}>{parseBlocks(quoted.join("\n"), nk())}</blockquote>);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"
      );
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={nk()} className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci} style={{ textAlign: aligns[ci] ?? "left" }}>
                    {parseInline(c, `${nk()}-h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci} style={{ textAlign: aligns[ci] ?? "left" }}>
                      {parseInline(r[ci] ?? "", `${nk()}-r${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const listItem = LIST_ITEM_RE.exec(line);
    if (listItem) {
      const entries: ListEntry[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // A blank line only continues the list when another item follows.
          if (lines[i + 1] !== undefined && LIST_ITEM_RE.test(lines[i + 1])) {
            i++;
            continue;
          }
          break;
        }
        const m = LIST_ITEM_RE.exec(l);
        if (m) {
          entries.push({
            indent: m[1].length,
            ordered: /\d/.test(m[2][0]),
            text: m[3],
          });
          i++;
        } else if (entries.length && /^\s{2,}\S/.test(l)) {
          entries[entries.length - 1].text += `\n${l.trim()}`;
          i++;
        } else {
          break;
        }
      }
      if (entries.length) blocks.push(buildList(entries, entries[0].indent, nk()));
      continue;
    }

    // Paragraph: consume until a blank line or the next block opener.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !LIST_ITEM_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) blocks.push(<p key={nk()}>{parseInline(para.join("\n"), nk())}</p>);
  }
  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`md${className ? ` ${className}` : ""}`}>{parseBlocks(text, "md")}</div>;
}
