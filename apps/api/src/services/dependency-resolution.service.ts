
import path from "node:path";
import fs from "node:fs/promises";

import type { ImportInfo } from "./import-analysis.service.js";

export interface DependencyResult {
  source: string;
  type: "resolved" | "unresolved";
  resolvedPath: string | null;
  reason: string | null;
}

export interface DependencyAnalysisResult {
  fileName: string;
  totalDependencies: number;
  resolvedDependencies: number;
  unresolvedDependencies: number;
  dependencies: DependencyResult[];
}

interface RepositoryAlias {
  pattern: string;
  target: string;
}

const SUPPORTED_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
];

function isInsideDirectory(
  directory: string,
  target: string
): boolean {
  const relative = path.relative(directory, target);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Reads static Jest moduleNameMapper assignments.
 *
 * Repository configuration is treated as untrusted text.
 * It is never executed.
 */
async function discoverJestAliases(
  repositoryRoot: string
): Promise<RepositoryAlias[]> {
  const configDirectories = [
    repositoryRoot,
    path.join(repositoryRoot, "scripts", "jest"),
  ];

  const configFiles: string[] = [];

  for (const directory of configDirectories) {
    try {
      const entries = await fs.readdir(directory, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const name = entry.name.toLowerCase();

        const isRootJestConfig =
          directory === repositoryRoot &&
          /^jest\.config\.(js|cjs|mjs)$/.test(name);

        const isJestScriptConfig =
          directory.endsWith(path.join("scripts", "jest")) &&
          /^config.*\.(js|cjs|mjs)$/.test(name);

        if (isRootJestConfig || isJestScriptConfig) {
          configFiles.push(path.join(directory, entry.name));
        }
      }
    } catch {
      // Missing configuration directories are allowed.
    }
  }

  const aliases: RepositoryAlias[] = [];

  for (const configFile of configFiles) {
    let configText: string;

    try {
      const stats = await fs.lstat(configFile);

      if (!stats.isFile() || stats.isSymbolicLink()) {
        continue;
      }

      configText = await fs.readFile(configFile, "utf8");

      // Avoid unexpectedly large configuration files.
      if (configText.length > 1024 * 1024) {
        continue;
      }
    } catch {
      continue;
    }

    const assignmentPattern =
      /moduleNameMapper\s*\[\s*(['"])([^'"]+)\1\s*\]\s*=\s*(['"])(.*?)\3\s*;?/gs;

    for (const match of configText.matchAll(assignmentPattern)) {
      const pattern = match[2];
      const target = match[4];

      if (
        !pattern ||
        !target ||
        pattern.length > 256 ||
        target.length > 500
      ) {
        continue;
      }

      aliases.push({
        pattern,
        target,
      });
    }
  }

  return aliases;
}

/**
 * Matches safe, common static Jest patterns:
 *
 * ^shared$
 * ^shared/(.*)$
 * ^shared/([^/]+)$
 *
 * More complex regular expressions are deliberately ignored.
 */
function matchAlias(
  pattern: string,
  source: string
): string | null {
  // Exact aliases:
  // ^shared$
  const exactMatch = pattern.match(
    /^\^([A-Za-z0-9_@./-]+)\$$/
  );

  if (exactMatch) {
    return source === exactMatch[1] ? "" : null;
  }

  // Wildcard aliases:
  // ^shared/(.*)$
  // ^shared/([^/]+)$
  const wildcardMatch = pattern.match(
    /^\^([A-Za-z0-9_@./-]+)\/(\(\.\*\)|\(\[\^\/\]\+\))\$$/
  );

  if (!wildcardMatch) {
    return null;
  }

  const prefix = wildcardMatch[1];
  const wildcardType = wildcardMatch[2];

  if (!source.startsWith(`${prefix}/`)) {
    return null;
  }

  const remainder = source.slice(prefix.length + 1);

  if (!remainder) {
    return null;
  }

  // (.*) supports nested paths.
  if (wildcardType === "(.*)") {
    return remainder;
  }

  // ([^/]+) supports only one path segment.
  if (
    wildcardType === "([^/]+)" &&
    remainder.includes("/")
  ) {
    return null;
  }

  return remainder;
}

/**
 * Resolves a bare import using discovered repository aliases.
 */
async function resolveAlias(
  repositoryRoot: string,
  source: string,
  aliases: RepositoryAlias[]
): Promise<string | null> {
  for (const alias of aliases) {
    const capturedValue = matchAlias(
      alias.pattern,
      source
    );

    if (capturedValue === null) {
      continue;
    }

    // Validate the original alias template before inserting the
// Windows project path, which may legitimately contain backslashes.
if (
  alias.target.includes("\0") ||
  alias.target.includes("\\") ||
  alias.target.startsWith("//")
) {
  continue;
}

const mappedTarget = alias.target
  .replace(/<rootDir>/g, repositoryRoot)
  .replace(/\$1/g, capturedValue);

if (mappedTarget.includes("\0")) {
  continue;
}

    const candidate = path.isAbsolute(mappedTarget)
      ? path.resolve(mappedTarget)
      : path.resolve(repositoryRoot, mappedTarget);

    if (!isInsideDirectory(repositoryRoot, candidate)) {
      continue;
    }

    const resolvedFile = await findExistingFile(
      repositoryRoot,
      candidate
    );

    if (resolvedFile) {
      return resolvedFile;
    }
  }

  return null;
}

/**
 * Finds a real file, trying supported extensions and index files.
 */
async function findExistingFile(
  repositoryRoot: string,
  candidate: string
): Promise<string | null> {
  const candidates = path.extname(candidate)
    ? [candidate]
    : [
        candidate,
        ...SUPPORTED_EXTENSIONS.map(
          (extension) => candidate + extension
        ),
        ...SUPPORTED_EXTENSIONS.map(
          (extension) =>
            path.join(candidate, `index${extension}`)
        ),
      ];

  for (const possiblePath of candidates) {
    if (!isInsideDirectory(repositoryRoot, possiblePath)) {
      continue;
    }

    try {
      const realPath = await fs.realpath(possiblePath);

      // Prevent symlinks from escaping the repository.
      if (!isInsideDirectory(repositoryRoot, realPath)) {
        continue;
      }

      const stats = await fs.stat(realPath);

      if (stats.isFile()) {
        return realPath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function findProjectRoot(
  repositoryRoot: string,
  importerRealPath: string
): Promise<string> {
  let currentDirectory = path.dirname(importerRealPath);

  while (isInsideDirectory(repositoryRoot, currentDirectory)) {
    const jestConfigDirectory = path.join(
      currentDirectory,
      "scripts",
      "jest"
    );

    try {
      const realConfigDirectory = await fs.realpath(
        jestConfigDirectory
      );

      if (!isInsideDirectory(repositoryRoot, realConfigDirectory)) {
        break;
      }

      const stats = await fs.stat(realConfigDirectory);

      if (stats.isDirectory()) {
        return currentDirectory;
      }
    } catch {
      // This ancestor does not contain a usable Jest config directory.
    }

    if (currentDirectory === repositoryRoot) {
      break;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return repositoryRoot;
}

/**
 * Resolves imports to actual files inside a repository.
 *
 * Supports:
 * - Relative imports
 * - Static Jest aliases
 *
 * External package resolution will be added separately.
 */
export async function resolveDependencies(
  repositoryRoot: string,
  importerPath: string,
  imports: ImportInfo[]
): Promise<DependencyAnalysisResult> {
  const realRepositoryRoot = await fs.realpath(repositoryRoot);

  const normalizedImporterPath = importerPath.replace(/\\/g, "/");

  if (
    path.isAbsolute(importerPath) ||
    normalizedImporterPath.includes("\0") ||
    normalizedImporterPath.split("/").some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    )
  ) {
    throw new Error("Invalid importer path.");
  }

  const importerAbsolutePath = path.resolve(
    realRepositoryRoot,
    ...normalizedImporterPath.split("/")
  );

  if (!isInsideDirectory(realRepositoryRoot, importerAbsolutePath)) {
    throw new Error("Importer path is outside the repository.");
  }

  const importerRealPath = await fs.realpath(importerAbsolutePath);

  if (!isInsideDirectory(realRepositoryRoot, importerRealPath)) {
    throw new Error("Importer file is outside the repository.");
  }

  // Find the actual project root inside the downloaded repository.
const projectRoot = await findProjectRoot(
  realRepositoryRoot,
  importerRealPath
);

// Discover aliases from the actual project root.
const aliases = await discoverJestAliases(projectRoot);

  const dependencies: DependencyResult[] = [];

  for (const imported of imports) {
    const source = imported.source;

    if (
      !source ||
      source.includes("\0") ||
      source.includes("\\")
    ) {
      dependencies.push({
        source,
        type: "unresolved",
        resolvedPath: null,
        reason: "invalid-import-path",
      });

      continue;
    }

    let candidate: string | null = null;

    if (
      source.startsWith("./") ||
      source.startsWith("../")
    ) {
      candidate = path.resolve(
        path.dirname(importerRealPath),
        source
      );

      if (!isInsideDirectory(realRepositoryRoot, candidate)) {
        dependencies.push({
          source,
          type: "unresolved",
          resolvedPath: null,
          reason: "import-escapes-repository",
        });

        continue;
      }
    } else {
      const resolvedAlias = await resolveAlias(
  projectRoot,
  source,
  aliases
);

      if (!resolvedAlias) {
        dependencies.push({
          source,
          type: "unresolved",
          resolvedPath: null,
          reason: "alias-or-external-package-not-resolved",
        });

        continue;
      }

      candidate = resolvedAlias;
    }

    const resolvedFile = await findExistingFile(
      realRepositoryRoot,
      candidate
    );

    if (!resolvedFile) {
      dependencies.push({
        source,
        type: "unresolved",
        resolvedPath: null,
        reason: "file-not-found",
      });

      continue;
    }

    const relativeResolvedPath = path
      .relative(realRepositoryRoot, resolvedFile)
      .split(path.sep)
      .join("/");

    dependencies.push({
      source,
      type: "resolved",
      resolvedPath: relativeResolvedPath,
      reason: null,
    });
  }

  const resolvedDependencies = dependencies.filter(
    (dependency) => dependency.type === "resolved"
  ).length;

  return {
    fileName: normalizedImporterPath,
    totalDependencies: dependencies.length,
    resolvedDependencies,
    unresolvedDependencies:
      dependencies.length - resolvedDependencies,
    dependencies,
  };
}
