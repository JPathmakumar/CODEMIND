
import path from "node:path";
import fs from "node:fs/promises";

import { analyzeImports } from "./import-analysis.service.js";
import {
  resolveDependencies,
  type DependencyResult,
} from "./dependency-resolution.service.js";

export interface DependencyGraphNode {
  id: string;
  name: string;
  extension: string;
  importsCount: number;
  importedByCount: number;
}

export interface DependencyGraphEdge {
  id: string;
  source: string;
  target: string;
  importSource: string;
}

export interface UnresolvedGraphImport {
  importerPath: string;
  source: string;
  reason: string | null;
}

export interface DependencyGraphStatistics {
  totalFiles: number;
  totalEdges: number;
  unresolvedImports: number;
  analysisErrors: number;
  mostImportedFiles: Array<{
    path: string;
    count: number;
  }>;
  filesWithMostImports: Array<{
    path: string;
    count: number;
  }>;
}

export interface DependencyGraphResult {
  repositoryId: string;
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  unresolved: UnresolvedGraphImport[];
  statistics: DependencyGraphStatistics;
  truncated: boolean;
}

export interface ScannedSourceFile {
  path: string;
  size: number;
  sourceCode: string;
}

export interface RepositoryScanResult {
  files: ScannedSourceFile[];
  totalSourceSize: number;
  skippedFiles: number;
  truncated: boolean;
}

export const GRAPH_LIMITS = {
  maxFiles: 10_000,
  maxFileSize: 1 * 1024 * 1024,
  maxTotalSourceSize: 100 * 1024 * 1024,
  maxDirectories: 20_000,
  maxDirectoryEntries: 5_000,
  concurrency: 4,
};

export const GRAPH_SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

export const GRAPH_EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "vendor",
]);

export function normalizeGraphPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isInsideDirectory(
  directory: string,
  target: string
): boolean {
  const relativePath = path.relative(directory, target);

  return (
    relativePath === "" ||
    (
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    )
  );
}

/**
 * Recursively scans a repository for supported source files.
 */
export async function scanRepositorySourceFiles(
  repositoryRoot: string
): Promise<RepositoryScanResult> {
  const realRepositoryRoot = await fs.realpath(repositoryRoot);
  const rootStats = await fs.lstat(realRepositoryRoot);

  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("INVALID_REPOSITORY_DIRECTORY");
  }

  const files: ScannedSourceFile[] = [];
  const directoriesToScan = [realRepositoryRoot];

  let totalSourceSize = 0;
  let skippedFiles = 0;
  let scannedDirectories = 0;
  let truncated = false;

  while (directoriesToScan.length > 0 && !truncated) {
    if (scannedDirectories >= GRAPH_LIMITS.maxDirectories) {
      truncated = true;
      break;
    }

    const currentDirectory = directoriesToScan.pop();

    if (!currentDirectory) {
      break;
    }

    scannedDirectories++;

    const directoryStats = await fs.lstat(currentDirectory);

    if (
      directoryStats.isSymbolicLink() ||
      !directoryStats.isDirectory()
    ) {
      continue;
    }

    const realDirectory = await fs.realpath(currentDirectory);

    if (!isInsideDirectory(realRepositoryRoot, realDirectory)) {
      continue;
    }

    const entries = await fs.readdir(realDirectory, {
      withFileTypes: true,
    });

    if (entries.length > GRAPH_LIMITS.maxDirectoryEntries) {
      truncated = true;
      break;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(realDirectory, entry.name);
      const metadata = await fs.lstat(absolutePath);

      if (metadata.isSymbolicLink()) {
        continue;
      }

      if (metadata.isDirectory()) {
        if (
          GRAPH_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())
        ) {
          continue;
        }

        directoriesToScan.push(absolutePath);
        continue;
      }

      if (!metadata.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!GRAPH_SUPPORTED_EXTENSIONS.has(extension)) {
        continue;
      }

      if (metadata.size > GRAPH_LIMITS.maxFileSize) {
        skippedFiles++;
        continue;
      }

      if (files.length >= GRAPH_LIMITS.maxFiles) {
        truncated = true;
        break;
      }

      if (
        totalSourceSize + metadata.size >
        GRAPH_LIMITS.maxTotalSourceSize
      ) {
        truncated = true;
        break;
      }

      const realFilePath = await fs.realpath(absolutePath);

      if (!isInsideDirectory(realRepositoryRoot, realFilePath)) {
        skippedFiles++;
        continue;
      }

      const fileBuffer = await fs.readFile(realFilePath);

      if (
        fileBuffer.length > GRAPH_LIMITS.maxFileSize ||
        fileBuffer.includes(0)
      ) {
        skippedFiles++;
        continue;
      }

      let sourceCode: string;

      try {
        sourceCode = new TextDecoder("utf-8", {
          fatal: true,
        }).decode(fileBuffer);
      } catch {
        skippedFiles++;
        continue;
      }

      const relativePath = normalizeGraphPath(
        path.relative(realRepositoryRoot, realFilePath)
      );

      files.push({
        path: relativePath,
        size: fileBuffer.length,
        sourceCode,
      });

      totalSourceSize += fileBuffer.length;
    }
  }

  return {
    files,
    totalSourceSize,
    skippedFiles,
    truncated,
  };
}

/**
 * Converts a resolved dependency into a graph edge.
 */
export function createGraphEdge(
  importerPath: string,
  dependency: DependencyResult,
  edgeNumber = 0
): DependencyGraphEdge | null {
  if (
    dependency.type !== "resolved" ||
    !dependency.resolvedPath
  ) {
    return null;
  }

  const source = normalizeGraphPath(importerPath);
  const target = normalizeGraphPath(dependency.resolvedPath);

  return {
    id: `${source}->${target}:${edgeNumber}`,
    source,
    target,
    importSource: dependency.source,
  };
}

/**
 * Builds a complete dependency graph for a repository.
 */
export async function generateDependencyGraph(
  repositoryId: string,
  repositoryRoot: string
): Promise<DependencyGraphResult> {
  const scan = await scanRepositorySourceFiles(repositoryRoot);

  const nodes = new Map<string, DependencyGraphNode>();

  for (const file of scan.files) {
    nodes.set(file.path, {
      id: file.path,
      name: path.basename(file.path),
      extension: path.extname(file.path).toLowerCase(),
      importsCount: 0,
      importedByCount: 0,
    });
  }

  const edges: DependencyGraphEdge[] = [];
  const unresolved: UnresolvedGraphImport[] = [];

  let analysisErrors = 0;
  let nextFileIndex = 0;

  const files = scan.files;

  async function processFiles(): Promise<void> {
    while (true) {
      const currentIndex = nextFileIndex++;

      if (currentIndex >= files.length) {
        return;
      }

      const file = files[currentIndex];

      if (!file) {
        continue;
      }

      try {
        const importAnalysis = analyzeImports(
          file.sourceCode,
          file.path
        );

        if (importAnalysis.imports.length === 0) {
          continue;
        }

        const dependencyAnalysis = await resolveDependencies(
          repositoryRoot,
          file.path,
          importAnalysis.imports
        );

        let edgeNumber = 0;

        for (const dependency of dependencyAnalysis.dependencies) {
          if (
            dependency.type !== "resolved" ||
            !dependency.resolvedPath
          ) {
            unresolved.push({
              importerPath: file.path,
              source: dependency.source,
              reason: dependency.reason,
            });

            continue;
          }

          const edge = createGraphEdge(
            file.path,
            dependency,
            edgeNumber++
          );

          if (!edge) {
            continue;
          }

          // Only connect files that exist in our scanned graph.
          if (!nodes.has(edge.target)) {
            unresolved.push({
              importerPath: file.path,
              source: dependency.source,
              reason: "target-not-in-graph",
            });

            continue;
          }

          edges.push(edge);

          const sourceNode = nodes.get(edge.source);
          const targetNode = nodes.get(edge.target);

          if (sourceNode) {
            sourceNode.importsCount++;
          }

          if (targetNode) {
            targetNode.importedByCount++;
          }
        }
      } catch {
        analysisErrors++;
      }
    }
  }

  const workerCount = Math.min(
    GRAPH_LIMITS.concurrency,
    files.length
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => processFiles()
    )
  );

  const sortedNodes = Array.from(nodes.values()).sort(
    (a, b) => a.id.localeCompare(b.id)
  );

  const mostImportedFiles = [...sortedNodes]
    .filter((node) => node.importedByCount > 0)
    .sort(
      (a, b) =>
        b.importedByCount - a.importedByCount ||
        a.id.localeCompare(b.id)
    )
    .slice(0, 10)
    .map((node) => ({
      path: node.id,
      count: node.importedByCount,
    }));

  const filesWithMostImports = [...sortedNodes]
    .filter((node) => node.importsCount > 0)
    .sort(
      (a, b) =>
        b.importsCount - a.importsCount ||
        a.id.localeCompare(b.id)
    )
    .slice(0, 10)
    .map((node) => ({
      path: node.id,
      count: node.importsCount,
    }));

  edges.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      a.id.localeCompare(b.id)
  );

  unresolved.sort(
    (a, b) =>
      a.importerPath.localeCompare(b.importerPath) ||
      a.source.localeCompare(b.source)
  );

  return {
    repositoryId,
    nodes: sortedNodes,
    edges,
    unresolved,
    statistics: {
      totalFiles: sortedNodes.length,
      totalEdges: edges.length,
      unresolvedImports: unresolved.length,
      analysisErrors,
      mostImportedFiles,
      filesWithMostImports,
    },
    truncated: scan.truncated,
  };
}
