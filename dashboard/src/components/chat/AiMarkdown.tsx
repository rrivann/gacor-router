import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "../../lib/utils";

// Full GitHub-flavored markdown for chat messages: headings, lists, tables,
// blockquotes, links, and fenced code with highlighting + copy.
export const AiMarkdown = memo(function AiMarkdown({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="ai-md text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeBlock as never,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
              {children}
            </a>
          ),
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-lg font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-base font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-2.5 text-sm font-semibold">{children}</h3>,
          p: ({ children }) => <p className="my-1.5">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 ml-5 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 ml-5 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="marker:text-muted-foreground">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-primary/40 pl-3 text-muted-foreground">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-border" />,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-border text-left text-muted-foreground">{children}</thead>,
          th: ({ children }) => <th className="px-2 py-1 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b border-border/60 px-2 py-1">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function CodeBlock({ inline, className, children }: { inline?: boolean; className?: string; children?: ReactNode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className || "")?.[1];
  const [copied, setCopied] = useState(false);

  // react-markdown v10 doesn't reliably pass `inline`; single-line code
  // without a language tag renders as an inline span.
  if (inline || (!lang && !code.includes("\n"))) {
    return <code className="rounded bg-secondary px-1.5 py-0.5 text-[0.85em] text-primary">{code}</code>;
  }

  async function copy() {
    if (!(await copyToClipboard(code))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-secondary/60 px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{lang ?? "code"}</span>
        <button onClick={copy} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        customStyle={{ margin: 0, background: "var(--background)", fontSize: "0.8rem" }}
        codeTagProps={{ style: { fontFamily: "ui-monospace, SF Mono, Menlo, monospace" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
