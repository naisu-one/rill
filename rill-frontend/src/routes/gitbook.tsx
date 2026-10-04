import { createFileRoute, Link } from "@tanstack/react-router";
import { DOC_PAGES } from "@/lib/docs-pages";
export const Route = createFileRoute("/gitbook")({
  head: () => ({ meta: [{ title: "Rill documentation" }] }),
  component: ImportIndex,
});
function ImportIndex() {
  return (
    <main>
      <h1>Rill documentation</h1>
      <p>Build Sui actions, approve spending budgets, and manage agent access.</p>
      <ul>
        {DOC_PAGES.map((page) => (
          <li key={page.id}>
            <Link to="/gitbook/$page" params={{ page: page.id }}>
              {page.title}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
