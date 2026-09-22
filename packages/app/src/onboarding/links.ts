/** The help center (apps/website/content/docs). */
const DOCS_URL = "https://companionapp.cloud/docs";

/** A help center article, by its slug (the markdown file's name). */
export function docsUrl(slug: string): string {
  return `${DOCS_URL}/${slug}`;
}
