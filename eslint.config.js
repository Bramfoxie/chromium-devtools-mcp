import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

const declarations = ["const", "let", "var"];

const FUNCTION_NODES = [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "TSDeclareFunction",
    "TSEmptyBodyFunctionExpression",
    "TSFunctionType",
    "TSConstructorType",
    "TSMethodSignature",
    "TSCallSignatureDeclaration",
    "TSConstructSignatureDeclaration",
];

// Aligns the type annotation colons of parameters that are written one per line.
const alignParamColons = {
    meta: {
        type    : "layout",
        fixable : "whitespace",
        schema  : [],
        messages: { misaligned: "Align the colon of this parameter with the other parameters." },
    },
    create: (context) => {
        const source = context.sourceCode;
        const colonOf = (param) => {
            const target = param.type === "TSParameterProperty" ? param.parameter : param;
            const named = target.type === "AssignmentPattern" ? target.left : target;

            return named.typeAnnotation ? source.getFirstToken(named.typeAnnotation) : undefined;
        };
        const onePerLine = (params) =>
            params.every(
                (param, i) => i === 0 || param.loc.start.line > params[i - 1].loc.end.line,
            );
        const check = (node) => {
            if (node.params.length < 2 || !onePerLine(node.params)) return;

            const entries = node.params
                .map(colonOf)
                .filter((colon) => colon !== undefined)
                .map((colon) => ({ colon, before: source.getTokenBefore(colon) }));
            const column = Math.max(...entries.map(({ before }) => before.loc.end.column));

            for (const { colon, before } of entries) {
                if (colon.loc.start.column === column) continue;

                context.report({
                    loc      : colon.loc,
                    messageId: "misaligned",
                    fix      : (fixer) =>
                        fixer.replaceTextRange(
                            [before.range[1], colon.range[0]],
                            " ".repeat(column - before.loc.end.column),
                        ),
                });
            }
        };

        return Object.fromEntries(FUNCTION_NODES.map((type) => [type, check]));
    },
};

export default tseslint.config(
    { ignores: ["dist", "coverage", "node_modules"] },
    ...tseslint.configs.recommended,
    {
        plugins: {
            "@stylistic": stylistic,
            local       : { rules: { "align-param-colons": alignParamColons } },
        },
        rules: {
            "local/align-param-colons"                  : "error",
            "@stylistic/indent"                         : ["error", 4, { SwitchCase: 1 }],
            "@stylistic/key-spacing"                    : ["error", { align: "colon", beforeColon: false, afterColon: true }],
            "@stylistic/padding-line-between-statements": [
                "error",
                { blankLine: "always", prev: "*", next: "return" },
                { blankLine: "always", prev: "*", next: "throw" },
                { blankLine: "always", prev: "export", next: "export" },
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
