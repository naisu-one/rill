import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { BookOpen, ChevronRight, Search } from "lucide-react";
import { SiteHeader } from "@/components/site-chrome";
import { DOC_PAGES, docAnchor } from "@/lib/docs-pages";
export const Route = createFileRoute("/docs")({
  validateSearch: (search: { page?: unknown }) => ({
    page: DOC_PAGES.some((page) => page.id === search.page)
      ? String(search.page)
      : "getting-started",
  }),
  head: () => ({ meta: [{ title: "Documentation | Rill" }] }),
  component: DocsPage,
});
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const index = match.index!;
    parts.push(text.slice(cursor, index));
    const url = match[2];
    parts.push(
      /^(https?:\/\/|\/)/.test(url) ? (
        <a key={index} href={url} className="text-primary underline underline-offset-4">
          {match[1]}
        </a>
      ) : (
        match[1]
      ),
    );
    cursor = index + match[0].length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
function Markdown({ content }: { content: string }) {
  const lines = content.split("\n"),
    blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.startsWith("# ")) {
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      const title = line.slice(3);
      blocks.push(
        <h2
          id={docAnchor(title)}
          key={i}
          className="scroll-mt-24 pt-4 text-xl font-semibold tracking-tight"
        >
          {title}
        </h2>,
      );
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const start = i++;
      const code: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre
          key={start}
          className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 text-xs leading-relaxed"
        >
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (line.startsWith("- ")) {
      const start = i,
        items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2));
      blocks.push(
        <ul
          key={start}
          className="list-disc space-y-2 pl-5 text-sm leading-7 text-muted-foreground"
        >
          {items.map((text, n) => (
            <li key={n}>
              <Inline text={text} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    const start = i,
      paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^## |^```|^- /.test(lines[i]))
      paragraph.push(lines[i++]);
    blocks.push(
      <p key={start} className="text-sm leading-7 text-muted-foreground">
        <Inline text={paragraph.join(" ")} />
      </p>,
    );
  }
  return <div className="space-y-5">{blocks}</div>;
}
function DocsPage() {
  const { page } = Route.useSearch();
  return <DocsReader id={page} />;
}
export function DocsReader({ id }: { id: string }) {
  const page = DOC_PAGES.find((page) => page.id === id)!;
  const [query, setQuery] = useState("");
  const pages = DOC_PAGES.filter((page) => page.title.toLowerCase().includes(query.toLowerCase()));
  const headings = page.content
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
  const navigation = (
    <>
      <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          aria-label="Find a documentation page"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a page…"
          className="min-w-0 w-full bg-transparent text-xs outline-none"
        />
      </label>
      <p className="mt-6 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Documentation
      </p>
      <nav aria-label="Documentation pages" className="mt-2 space-y-1">
        {pages.map((item) => (
          <Link
            key={item.id}
            to="/docs/$page"
            params={{ page: item.id }}
            className={`block rounded-md px-2 py-2 text-xs ${id === item.id ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            {item.title}
          </Link>
        ))}
      </nav>
      {pages.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">No matching pages.</p>
      )}
    </>
  );
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto grid max-w-7xl gap-8 px-4 py-8 sm:px-6 md:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_180px]">
        <aside className="hidden md:block">
          <div className="sticky top-24">{navigation}</div>
        </aside>
        <article className="min-w-0 max-w-3xl">
          <details className="mb-6 rounded-lg border border-border bg-card p-3 md:hidden">
            <summary className="cursor-pointer text-sm font-medium">Documentation menu</summary>
            <div className="mt-4">{navigation}</div>
          </details>
          <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5" />
            Docs
            <ChevronRight className="h-3 w-3" />
            {page.title}
          </div>
          <h1 className="mb-6 text-3xl font-semibold tracking-tight">{page.title}</h1>
          <Markdown content={page.content} />
          <div className="mt-10 border-t border-border pt-5 text-xs text-muted-foreground">
            Use the sidebar to continue, or open{" "}
            <Link to="/builder" className="text-primary hover:underline">
              Builder
            </Link>
            .
          </div>
        </article>
        <aside className="hidden xl:block">
          <nav aria-label="On this page" className="sticky top-24 space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              On this page
            </p>
            {headings.map((title) => (
              <a
                key={title}
                href={`#${docAnchor(title)}`}
                className="block text-xs text-muted-foreground hover:text-primary"
              >
                {title}
              </a>
            ))}
          </nav>
        </aside>
      </main>
    </div>
  );
}
