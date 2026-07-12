#!/usr/bin/env node
// Builds the web dist that @companion/design-system is missing (it ships raw
// .tsx consumed directly; main → ./src/index.ts, no build). design-sync needs
// two things this produces:
//
//   dist/types/*.d.ts   — TypeScript declarations (component discovery is driven
//                          by cfg.componentSrcMap, but propsBodyFor reads the
//                          <Name>Props interfaces from these files).
//   dist/index.web.mjs   — the components pre-bundled for the WEB target, exactly
//                          the way apps/web/vite.config.ts resolves them:
//                          react-native → react-native-web, .web.tsx first. react
//                          stays external so design-sync's own IIFE bundler binds
//                          it to window.React. react-native-web is inlined here so
//                          the converter never has to resolve it.
//
// cfg.entry points design-sync at dist/index.web.mjs; cfg.buildCmd re-runs this
// before every (re)sync. esbuild resolves from the fork symlink
// (.design-sync/node_modules → ../.ds-sync/node_modules).

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PKG = resolve(REPO, 'packages/design-system');
const DIST = resolve(PKG, 'dist');
const SRC_ENTRY = resolve(PKG, 'src/index.ts');

// Web-platform resolution — mirrors apps/web/vite.config.ts.
const WEB = {
  alias: { 'react-native': 'react-native-web' },
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
  define: { global: 'globalThis', __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1. .d.ts → dist/types/  (findTypesRoot picks up dist/types; propsBodyFor reads it)
console.error('[build-web-dist] emitting declarations …');
execFileSync(
  'npx',
  ['tsc', '--emitDeclarationOnly', '--declaration', '--noEmit', 'false', '--outDir', 'dist/types'],
  { cwd: PKG, stdio: 'inherit' },
);

// 2. web IIFE-ready ESM → dist/index.web.mjs
console.error('[build-web-dist] bundling web entry …');
await build({
  entryPoints: [SRC_ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: resolve(DIST, 'index.web.mjs'),
  // The converter's reactShim binds these to window.React — keep them external.
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  alias: WEB.alias,
  resolveExtensions: WEB.resolveExtensions,
  define: WEB.define,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  nodePaths: [resolve(REPO, 'node_modules')],
  logLevel: 'warning',
  // react-native-web injects `<style id="react-native-stylesheet">` into <head>
  // with its rules added via CSSOM insertRule (so the element's innerHTML stays
  // empty). The design-sync render check measures `querySelectorAll('#root,
  // [id^="r"]')[0]` as the render root, and that empty <style> matches `[id^="r"]`
  // and sorts first in document order — making every preview falsely read as
  // "root empty" even though the cells render fine. Rename RNW's style elements
  // off the `r*` prefix so the selector lands on the real cell roots. Harmless in
  // shipped designs: RNW keeps the sheet by object reference, not by id lookup.
  footer: {
    js: ';(function(){if(typeof document==="undefined")return;'
      + 'var fix=function(){var s=document.querySelectorAll("style[id^=\\"react-native\\"]");'
      + 'for(var i=0;i<s.length;i++){s[i].id="ds-rnw-"+s[i].id;}};'
      + 'fix();try{new MutationObserver(fix).observe(document.head||document.documentElement,{childList:true});}catch(e){}})();',
  },
});

// 3. self-contained brand fonts → dist/fonts.css  (cfg.cssEntry appends this to
//    _ds_bundle.css so Geist/Geist Mono ship inside styles.css's @import closure;
//    data-URI @font-face so designs render in-brand even in a sandbox with no
//    external font fetch). Authored once at .design-sync/fonts.css (committed).
copyFileSync(resolve(HERE, 'fonts.css'), resolve(DIST, 'fonts.css'));

console.error(
  `[build-web-dist] done — dist/index.web.mjs (${(statSync(resolve(DIST, 'index.web.mjs')).size / 1024).toFixed(0)} KB) + dist/types/ + dist/fonts.css`,
);
if (!existsSync(resolve(DIST, 'types', 'index.d.ts'))) {
  console.error('[build-web-dist] WARNING: dist/types/index.d.ts missing — declaration emit may have failed');
  process.exit(1);
}
