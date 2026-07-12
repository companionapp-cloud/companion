import type { PropsWithChildren } from "react";

// HTML document shell for every statically-rendered route (Expo Router web).
// react-native-web injects component styles at runtime; the reset below lets the
// document scroll normally (marketing content flows in block layout, not a ScrollView).
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        {/* Light-only marketing site — opt out of the OS dark-mode canvas so
            transparent sections fall through to white, not the UA dark background. */}
        <meta name="color-scheme" content="light only" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#f76808" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: scrollReset }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

// Allow the document (not a nested RN ScrollView) to own scrolling, and undo the
// full-height flex box react-native-web / Expo Router put on html/body/#root.
const scrollReset = `
html, body, #root {
  height: auto !important;
  min-height: 100%;
  overflow: visible !important;
}
#root { display: block !important; }
html, body { margin: 0; background: #ffffff; color-scheme: light; }
`;
