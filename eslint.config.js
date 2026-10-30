import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

const declarations = ["const", "let", "var"];

export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules"] },
  ...tseslint.configs.recommended,
  {
    plugins: { "@stylistic": stylistic },
    rules  : {
      "@stylistic/key-spacing"                    : ["error", { align: "colon", beforeColon: false, afterColon: true }],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: "*", next: "throw" },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: "block-like" },
        { blankLine: "always", prev: declarations, next: "*" },
        { blankLine: "any", prev: declarations, next: declarations },
        {
          blankLine: "always",
          prev     : "if",
          next     : ["expression", "return", "throw", "for", "while", "try", "switch", ...declarations],
        },
      ],
      "@stylistic/no-multiple-empty-lines": ["error", { max: 1, maxEOF: 0, maxBOF: 0 }],
      "@stylistic/padded-blocks"          : ["error", "never"],
      "@stylistic/semi"                   : ["error", "always"],
      "@stylistic/quotes"                 : ["error", "double", { avoidEscape: true, allowTemplateLiterals: "always" }],
      "@stylistic/comma-dangle"           : ["error", "always-multiline"],
      "@stylistic/eol-last"               : ["error", "always"],
      "@stylistic/linebreak-style"        : ["error", "unix"],
      "@stylistic/no-trailing-spaces"     : "error",
      "@stylistic/object-curly-spacing"   : ["error", "always"],
      "@stylistic/max-len"                : [
        "error",
        {
          code                  : 100,
          ignoreStrings         : true,
          ignoreTemplateLiterals: true,
          ignoreUrls            : true,
          ignoreRegExpLiterals  : true,
          ignoreComments        : true,
        },
      ],
    },
  },
);
