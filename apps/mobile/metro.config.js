const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// 1. Find the project and monorepo workspace roots
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..'); // Adjust based on depth

const config = getDefaultConfig(projectRoot);

// 2. Watch all files within the monorepo root
config.watchFolders = [workspaceRoot];

// 3. Force Metro to resolve dependencies from both the app and root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 4. Prevent duplicate package versions by disabling hierarchical lookups
config.resolver.disableHierarchicalLookup = true;

module.exports = config;