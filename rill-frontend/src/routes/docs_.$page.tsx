import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocsReader } from "./docs";
import { DOC_PAGES } from "@/lib/docs-pages";
export const Route = createFileRoute("/docs_/$page")({
  beforeLoad: ({ params }) => {
    if (!DOC_PAGES.some((page) => page.id === params.page)) throw notFound();
  },
  head: ({ params }) => ({
    meta: [
      {
        title: `${DOC_PAGES.find((page) => page.id === params.page)?.title ?? "Documentation"} | Rill`,
      },
    ],
  }),
  component: DocumentationPage,
});
function DocumentationPage() {
  const { page } = Route.useParams();
  return <DocsReader id={page} />;
}
