
import { parse } from "@babel/parser";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const traverse = require("@babel/traverse").default as
  typeof import("@babel/traverse").default;

export interface CodeSymbol {
  name: string;
  type: "function" | "class" | "method";
  line: number;
  endLine: number;
}

export interface CodeAnalysisResult {
  fileName: string;
  language: string;
  totalSymbols: number;
  functions: CodeSymbol[];
  classes: CodeSymbol[];
  methods: CodeSymbol[];
}

/**
 * Removes TypeScript "as" assertions before Flow parsing.
 * Replaces matched text with spaces to preserve source positions.
 */
function prepareFlowSource(sourceCode: string): string {
  return sourceCode.replace(
    /\s+as\s+(?:any|unknown|[A-Za-z_$][\w$]*(?:<[^>\n;]+>)?)(?:\s+as\s+(?:any|unknown|[A-Za-z_$][\w$]*(?:<[^>\n;]+>)?))*/g,
    (match) => " ".repeat(match.length)
  );
}

/**
 * Checks whether the file uses TypeScript syntax.
 */
function isTypeScriptFile(extension: string): boolean {
  return extension === "ts" || extension === "tsx";
}

/**
 * Parses source code using Babel.
 */
function parseSourceCode(
  sourceCode: string,
  isTypeScript: boolean
) {
  const parserOptions = {
    sourceType: "unambiguous" as const,
    errorRecovery: false,
  };

  // TypeScript and TSX files use the TypeScript parser.
  if (isTypeScript) {
    return parse(sourceCode, {
      ...parserOptions,
      plugins: [
        "typescript",
        "jsx",
        "decorators-legacy",
        "classProperties",
      ],
    });
  }

  try {
    // First attempt: JavaScript with TypeScript-compatible syntax.
    return parse(sourceCode, {
      ...parserOptions,
      plugins: [
        "typescript",
        "jsx",
        "decorators-legacy",
        "classProperties",
      ],
    });
  } catch (typescriptError) {
    console.error(
      "TypeScript parser error:",
      typescriptError
    );

    // Second attempt: Flow syntax.
    const flowCompatibleSource =
      prepareFlowSource(sourceCode);

    return parse(flowCompatibleSource, {
      ...parserOptions,
      plugins: [
        ["flow", { all: true }],
        "jsx",
        "decorators-legacy",
        "classProperties",
      ],
    });
  }
}

/**
 * Gets a useful name for function expressions.
 */
function getFunctionName(
  node: any,
  parent: any
): string {
  if (node.id?.name) {
    return node.id.name;
  }

  if (
    parent?.type === "VariableDeclarator" &&
    parent.id?.type === "Identifier"
  ) {
    return parent.id.name;
  }

  if (
    parent?.type === "AssignmentExpression" &&
    parent.left?.type === "Identifier"
  ) {
    return parent.left.name;
  }

  return "anonymous";
}

/**
 * Analyzes a source file using its Abstract Syntax Tree.
 */
export function analyzeCode(
  sourceCode: string,
  fileName: string
): CodeAnalysisResult {
  const extension =
    fileName.split(".").pop()?.toLowerCase() ?? "";

  const isTypeScript = isTypeScriptFile(extension);

  const language = isTypeScript
    ? extension === "tsx"
      ? "tsx"
      : "typescript"
    : extension === "jsx"
      ? "jsx"
      : "javascript";

  const ast = parseSourceCode(
    sourceCode,
    isTypeScript
  );

  const functions: CodeSymbol[] = [];
  const classes: CodeSymbol[] = [];
  const methods: CodeSymbol[] = [];

  traverse(ast, {
    // Function declarations.
    FunctionDeclaration(path) {
      const node = path.node;

      functions.push({
        name: node.id?.name ?? "anonymous",
        type: "function",
        line: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
      });
    },

    // Arrow functions and function expressions.
    VariableDeclarator(path) {
      const node = path.node;

      if (
        node.init?.type === "ArrowFunctionExpression" ||
        node.init?.type === "FunctionExpression"
      ) {
        const name = getFunctionName(
          node.init,
          path.parent
        );

        functions.push({
          name,
          type: "function",
          line: node.loc?.start.line ?? 0,
          endLine: node.loc?.end.line ?? 0,
        });
      }
    },

    // Class declarations.
    ClassDeclaration(path) {
      const node = path.node;

      classes.push({
        name: node.id?.name ?? "anonymous",
        type: "class",
        line: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
      });
    },

    // Public class methods.
    ClassMethod(path) {
      const node = path.node;

      const name =
        node.key.type === "Identifier"
          ? node.key.name
          : node.key.type === "StringLiteral"
            ? node.key.value
            : "computed";

      methods.push({
        name,
        type: "method",
        line: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
      });
    },

    // Private class methods.
    ClassPrivateMethod(path) {
      const node = path.node;

      methods.push({
        name:
          node.key.type === "PrivateName"
            ? `#${node.key.id.name}`
            : "private method",
        type: "method",
        line: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
      });
    },
  });

  return {
    fileName,
    language,
    totalSymbols:
      functions.length +
      classes.length +
      methods.length,
    functions,
    classes,
    methods,
  };
}
