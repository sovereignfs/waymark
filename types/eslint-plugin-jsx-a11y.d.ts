// The plugin ships no types, and eslint.config.ts is type-checked with the rest. Only the part the config uses is declared.
declare module 'eslint-plugin-jsx-a11y' {
  import type { ESLint, Linter } from 'eslint';
  const plugin: ESLint.Plugin & { flatConfigs: { recommended: { rules: Linter.RulesRecord } } };
  export default plugin;
}
