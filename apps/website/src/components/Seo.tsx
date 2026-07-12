import Head from "expo-router/head";

// Per-route SEO. Expo Router's Head injects these tags into each statically-exported
// page's <head> (title, description, canonical, Open Graph, Twitter card), so every
// route is individually indexable and shareable. The absolute site origin is configurable
// via EXPO_PUBLIC_SITE_URL (inlined at build time) and defaults to the production domain.

const SITE_URL = (process.env.EXPO_PUBLIC_SITE_URL || "https://companionapp.cloud").replace(/\/+$/, "");
const SITE_NAME = "Companion";
const DEFAULT_IMAGE = "/apple-touch-icon.png";

function absolute(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return SITE_URL + (pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`);
}

export interface SeoProps {
  title: string;
  description: string;
  /** Route path, e.g. "/" or "/docs/your-first-note" — used for canonical + og:url. */
  path: string;
  /** Absolute or root-relative image; defaults to the app icon. */
  image?: string;
  type?: "website" | "article";
}

export function Seo({ title, description, path, image = DEFAULT_IMAGE, type = "website" }: SeoProps) {
  const url = absolute(path === "/" ? "" : path);
  const img = absolute(image);
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      <meta name="robots" content="index,follow" />

      {/* Open Graph */}
      <meta property="og:type" content={type} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={img} />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={img} />
    </Head>
  );
}
