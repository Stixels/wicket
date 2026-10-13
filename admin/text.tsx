import { Fragment, type ReactNode } from "react";

/**
 * Just enough Markdown for chat: paragraphs, code blocks, `code`, **bold**, *italic*, links and
 * bare URLs. Builds elements, never HTML strings, so message text can't inject markup.
 */
export function RichText({ text, members = [] }: { text: string; members?: string[] }) {
  const parts = text.split(/```[^\n]*\n?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <CodeBlock key={i} code={part.replace(/\n$/, "")} />
        ) : (
          part
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p, j) => (
              <p key={`${i}-${j}`}>
                {p.split("\n").map((line, k) => (
                  <Fragment key={k}>
                    {k > 0 && <br />}
                    {inline(line, members)}
                  </Fragment>
                ))}
              </p>
            ))
        ),
      )}
    </>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="code">
      <button className="code-copy" onClick={() => void navigator.clipboard?.writeText(code)} title="Copy">
        Copy
      </button>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const TOKEN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|@[\p{L}\d])/gu;

function inline(line: string, members: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  // Longest names first, so "@Alex Rivera" wins over "@Alex".
  const byLength = [...members].sort((a, b) => b.length - a.length);
  for (const m of line.matchAll(TOKEN)) {
    const t = m[0];
    const at = m.index ?? 0;
    if (at < last) continue; // inside a mention we already took
    if (at > last) out.push(line.slice(last, at));
    last = at + t.length;
    if (t.startsWith("`")) out.push(<code key={at}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={at}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(t)!;
      out.push(
        <a key={at} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    } else if (t.startsWith("@")) {
      // Names can have spaces, so match them against the team rather than the token.
      const rest = line.slice(at + 1).toLowerCase();
      const name = byLength.find((n) => rest.startsWith(n.toLowerCase()));
      if (name) {
        out.push(
          <span key={at} className="mention">
            @{name}
          </span>,
        );
        last = at + 1 + name.length;
      } else {
        out.push("@");
        last = at + 1;
      }
    } else
      out.push(
        <a key={at} href={t} target="_blank" rel="noreferrer noopener">
          {t}
        </a>,
      );
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}
