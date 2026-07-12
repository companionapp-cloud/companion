// Metro's require.context (enabled by Expo) — used by the markdown docs loader in
// src/content/docs.ts. Kept in a committed file because expo-env.d.ts is generated
// and gitignored.
declare namespace NodeJS {
  interface Require {
    context(
      directory: string,
      useSubdirectories?: boolean,
      regExp?: RegExp,
    ): {
      keys(): string[];
      <T = unknown>(id: string): T;
    };
  }
}
