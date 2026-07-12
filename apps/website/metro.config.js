const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

// Monorepo setup, mirroring apps/mobile/metro.config.js.
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

// Treat markdown as source and compile it via metro.transformer.js (frontmatter +
// rendered HTML). Docs content lives in content/docs/*.md, enumerated with
// require.context in src/content/docs.ts.
config.resolver.sourceExts = [...config.resolver.sourceExts, "md"];
config.transformer.babelTransformerPath = require.resolve("./metro.transformer.js");

module.exports = config;
