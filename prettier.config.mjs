/** @type {import("prettier").Config} */
export default {
  plugins: ["@ianvs/prettier-plugin-sort-imports"],
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  singleQuote: false,
  semi: true,
  trailingComma: "all",
  importOrder: ["<BUILTIN_MODULES>", "^bun:", "^node:", "", "<THIRD_PARTY_MODULES>", "", "^[.]"],
  importOrderParserPlugins: ["typescript", "jsx"],
  overrides: [
    {
      files: ["*.json", "*.json5", "*.jsonc"],
      options: { trailingComma: "none" },
    },
  ],
};
