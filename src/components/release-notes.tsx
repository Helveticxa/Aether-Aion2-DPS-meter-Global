import { Fragment, type ReactNode } from "react";

/**
 * Release notes come straight out of CHANGELOG.md: hard-wrapped at 80
 * columns, with **bold**, `code`, bullets, and ### headings. Shown verbatim,
 * that is asterisks and sentences broken mid-line. This renders just that
 * subset: paragraphs are re-joined, the markup becomes markup, and anything
 * else is left as plain text. No HTML is ever interpreted.
 */
export function ReleaseNotes({ text }: { text: string }) {
  const blocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  return (
    <div className="space-y-2.5 text-sm leading-6">
      {blocks.map((block, index) => {
        const heading = /^#{1,6}\s+(.*)$/s.exec(block);
        if (heading) {
          return (
            <p key={index} className="pt-1 text-xs font-semibold tracking-wide uppercase">
              {inline(heading[1].replace(/\s*\n\s*/g, " "))}
            </p>
          );
        }

        if (/^[-*]\s/.test(block)) {
          const items: string[] = [];
          for (const line of block.split("\n")) {
            if (/^[-*]\s/.test(line)) items.push(line.replace(/^[-*]\s+/, ""));
            else if (items.length) items[items.length - 1] += ` ${line.trim()}`;
          }
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {items.map((item, i) => (
                <li key={i}>{inline(item)}</li>
              ))}
            </ul>
          );
        }

        return <p key={index}>{inline(block.replace(/\s*\n\s*/g, " "))}</p>;
      })}
    </div>
  );
}

/** `**bold**` and `` `code` `` inside one line of text. */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={index} className="bg-muted rounded px-1 py-px font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
