import { createFileRoute, notFound } from "@tanstack/react-router";
import { DOC_PAGES } from "@/lib/docs-pages";
import { Markdown } from "./docs";
export const Route = createFileRoute("/gitbook_/$page")({
  beforeLoad: ({ params }) => {
    if (!DOC_PAGES.some((page) => page.id === params.page)) throw notFound();
  },
  head: ({ params }) => ({
    meta: [{ title: DOC_PAGES.find((page) => page.id === params.page)?.title ?? "Rill" }],
  }),
  component: ImportPage,
});
function ImportPage() {
  const { page: id } = Route.useParams();
  const page = DOC_PAGES.find((page) => page.id === id)!;
  return (
    <main>
      <article>
        <h1>{page.title}</h1>
        <Markdown content={page.content} />
      </article>
    </main>
  );
}
