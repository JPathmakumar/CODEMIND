
import { parse } from "@babel/parser";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const traverse = require("@babel/traverse").default as
  typeof import("@babel/traverse").default;

export interface ImportSymbol {
  imported: string;
  local: string;
}

export interface ImportInfo {
  source: string;
  type: "default" | "named" | "namespace" | "side-effect";
  symbols: ImportSymbol[];
  line: number;
}

export interface ImportAnalysisResult {
  fileName: string;
  totalImports: number;
  imports: ImportInfo[];
}

function prepareFlowSource(sourceCode: string): string {
  return sourceCode.replace(
    /\s+as\s+(?:any|unknown|[A-Za-z_$][\w$]*(?:<[^>\n;]+>)?)(?:\s+as\s+(?:any|unknown|[A-Za-z_$][\w$]*(?:<[^>\n;]+>)?))*/g,
    (match) => " ".repeat(match.length)
  );
}

function parseImportSource(sourceCode: string) {
  const parserOptions = {
    sourceType: "unambiguous" as const,
    errorRecovery: false,
  };

  try {
    return parse(sourceCode, {
      ...parserOptions,
      plugins: [
        "typescript",
        "jsx",
        "decorators-legacy",
        "classProperties",
      ],
    });
  } catch {
    return parse(prepareFlowSource(sourceCode), {
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

export function analyzeImports(
  sourceCode: string,
  fileName: string
): ImportAnalysisResult {
  const ast = parseImportSource(sourceCode);

  const imports: ImportInfo[] = [];

  traverse(ast, {
    ImportDeclaration(path) {
      const node = path.node;

      const source = node.source.value;
      const symbols: ImportSymbol[] = [];

      let type: ImportInfo["type"] = "side-effect";

      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportDefaultSpecifier") {
          type = "default";

          symbols.push({
            imported: "default",
            local: specifier.local.name,
          });
        } else if (
          specifier.type === "ImportSpecifier"
        ) {
          type = "named";

          symbols.push({
            imported:
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value,
            local: specifier.local.name,
          });
        } else if (
          specifier.type === "ImportNamespaceSpecifier"
        ) {
          type = "namespace";

          symbols.push({
            imported: "*",
            local: specifier.local.name,
          });
        }
      }

      imports.push({
        source,
        type,
        symbols,
        line: node.loc?.start.line ?? 0,
      });
    },
  });

  return {
    fileName,
    totalImports: imports.length,
    imports,
  };
}
