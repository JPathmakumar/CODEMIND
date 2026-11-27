
import { builtinModules } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";

import type { ImportInfo } from "./import-analysis.service.js";

export interface DependencyResult {
  source: string;
  type: "resolved" | "external" | "unresolved";
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

interface WorkspacePackage {
  name: string;
  directory: string;
  entryPoints: string[];
}

const MAX_PACKAGE_MANIFEST_SIZE = 1024 * 1024;
const MAX_WORKSPACE_SCAN_DIRECTORIES = 20000;

const EXCLUDED_WORKSPACE_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "vendor",
]);

const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => [
    name,
    name.startsWith("node:") ? name.slice(5) : `node:${name}`,
  ])
);

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

function isNodeBuiltin(source: string): boolean {
  return NODE_BUILTINS.has(source);
}

function getPackageName(source: string): string | null {
  if (
    !source ||
    source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("node:")
  ) {
    return null;
  }

  const parts = source.split("/");

  if (source.startsWith("@")) {
    return parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : null;
  }

  return parts[0] ?? null;
}

function collectEntryPointStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return [];
  }

  return Object.values(value).flatMap(collectEntryPointStrings);
}

/**
 * Discovers package.json files throughout the repository.
 *
 * This also discovers nested package projects that are not listed
 * in the repository's top-level workspaces configuration.
 *
 * Repository configuration is read as data and never executed.
 */
async function discoverWorkspacePackages(
  repositoryRoot: string
): Promise<Map<string, WorkspacePackage>> {
  const workspacePackages = new Map<string, WorkspacePackage>();
  const visitedDirectories = new Set<string>();

  let scannedDirectories = 0;

  async function scanDirectory(directory: string): Promise<void> {
    if (scannedDirectories >= MAX_WORKSPACE_SCAN_DIRECTORIES) {
      return;
    }

    let realDirectory: string;

    try {
      realDirectory = await fs.realpath(directory);
    } catch {
      return;
    }

    if (
      !isInsideDirectory(repositoryRoot, realDirectory) ||
      visitedDirectories.has(realDirectory)
    ) {
      return;
    }

    visitedDirectories.add(realDirectory);
    scannedDirectories++;

    // Discover a package manifest in this directory.
    const manifestPath = path.join(realDirectory, "package.json");

    try {
      const stats = await fs.lstat(manifestPath);

      if (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.size <= MAX_PACKAGE_MANIFEST_SIZE
      ) {
        const parsed: unknown = JSON.parse(
          await fs.readFile(manifestPath, "utf8")
        );

        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        ) {
          const manifest = parsed as Record<string, unknown>;
          const packageName = manifest.name;

          if (
            typeof packageName === "string" &&
            packageName.length > 0 &&
            packageName.length <= 256
          ) {
            const entryPoints = [
              ...collectEntryPointStrings(manifest.exports),
              ...collectEntryPointStrings(manifest.source),
              ...collectEntryPointStrings(manifest.module),
              ...collectEntryPointStrings(manifest.main),
              ...collectEntryPointStrings(manifest.types),
              ...collectEntryPointStrings(manifest.typings),
            ];

            workspacePackages.set(packageName, {
              name: packageName,
              directory: realDirectory,
              entryPoints: [...new Set(entryPoints)],
            });
          }
        }
      }

      const workspacePackageCache = new Map<
  string,
  Promise<Map<string, WorkspacePackage>>
>();

function getWorkspacePackages(
  repositoryRoot: string
): Promise<Map<string, WorkspacePackage>> {
  const cached = workspacePackageCache.get(repositoryRoot);

  if (cached) {
    return cached;
  }

  const discovery = discoverWorkspacePackages(repositoryRoot);

  workspacePackageCache.set(repositoryRoot, discovery);

  return discovery;
}
    } catch {
      // Missing or invalid package manifests are allowed.
    }

    // Continue scanning child directories.
    let entries;

    try {
      entries = await fs.readdir(realDirectory, {
        withFileTypes: true,
      });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        EXCLUDED_WORKSPACE_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }

      if (scannedDirectories >= MAX_WORKSPACE_SCAN_DIRECTORIES) {
        break;
      }

      await scanDirectory(
        path.join(realDirectory, entry.name)
      );
    }
  }

  await scanDirectory(repositoryRoot);

  return workspacePackages;
}

const workspacePackageCache = new Map<
  string,
  Promise<Map<string, WorkspacePackage>>
>();

function getWorkspacePackages(
  repositoryRoot: string
): Promise<Map<string, WorkspacePackage>> {
  const cached = workspacePackageCache.get(repositoryRoot);

  if (cached) {
    return cached;
  }

  const discovery = discoverWorkspacePackages(repositoryRoot);

  workspacePackageCache.set(repositoryRoot, discovery);

  return discovery;
}

/**
 * Discovers packages declared by the importer package and
 * its parent package manifests.
 */
async function discoverDeclaredPackages(
  repositoryRoot: string,
  importerRealPath: string
): Promise<Set<string>> {
  const packages = new Set<string>();

  let currentDirectory = path.dirname(importerRealPath);

  while (isInsideDirectory(repositoryRoot, currentDirectory)) {
    const packageJsonPath = path.join(
      currentDirectory,
      "package.json"
    );

    try {
      const stats = await fs.lstat(packageJsonPath);

      if (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.size <= MAX_PACKAGE_MANIFEST_SIZE
      ) {
        const content = await fs.readFile(
          packageJsonPath,
          "utf8"
        );

        const manifest: unknown = JSON.parse(content);

        if (
          manifest !== null &&
          typeof manifest === "object" &&
          !Array.isArray(manifest)
        ) {
          const data = manifest as Record<string, unknown>;

          for (const field of [
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
          ]) {
            const section = data[field];

            if (
              section !== null &&
              typeof section === "object" &&
              !Array.isArray(section)
            ) {
              for (const name of Object.keys(section)) {
                packages.add(name);
              }
            }
          }
        }
      }
    } catch {
      // Missing or invalid package manifests are allowed.
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

  return packages;
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
        if (!entry.isFile() || entry.isSymbolicLink()) {
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

      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.size > MAX_PACKAGE_MANIFEST_SIZE
      ) {
        continue;
      }

      configText = await fs.readFile(configFile, "utf8");
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
 * Matches safe, common static Jest patterns.
 *
 * Examples:
 * ^shared$
 * ^shared/(.*)$
 * ^shared/([^/]+)$
 */
function matchAlias(
  pattern: string,
  source: string
): string | null {
  const exactMatch = pattern.match(
    /^\^([A-Za-z0-9_@./-]+)\$$/
  );

  if (exactMatch) {
    return source === exactMatch[1] ? "" : null;
  }

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

  if (wildcardType === "(.*)") {
    return remainder;
  }

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

/**
 * Resolves a workspace package's main entry point.
 *
 * Tries declared entry points first, then conventional source files
 * when compiled output such as dist/index.js is unavailable.
 */
async function resolveWorkspacePackage(
  repositoryRoot: string,
  workspacePackage: WorkspacePackage
): Promise<string | null> {
  for (const entryPoint of workspacePackage.entryPoints) {
    if (
      !entryPoint ||
      entryPoint.includes("\0") ||
      entryPoint.includes("\\") ||
      path.isAbsolute(entryPoint) ||
      entryPoint.split("/").some(
        (segment) => segment === ".."
      )
    ) {
      continue;
    }

    const candidate = path.resolve(
      workspacePackage.directory,
      entryPoint
    );

    if (
      !isInsideDirectory(
        workspacePackage.directory,
        candidate
      )
    ) {
      continue;
    }

    const resolved = await findExistingFile(
      repositoryRoot,
      candidate
    );

    if (resolved) {
      return resolved;
    }
  }

  const sourceEntryPoints = [
    "src/index.ts",
    "src/index.tsx",
    "src/index.js",
    "src/index.jsx",
    "src/index.mts",
    "src/index.mjs",
    "index.ts",
    "index.tsx",
    "index.js",
    "index.jsx",
  ];

  for (const entryPoint of sourceEntryPoints) {
    const candidate = path.resolve(
      workspacePackage.directory,
      entryPoint
    );

    const resolved = await findExistingFile(
      repositoryRoot,
      candidate
    );

    if (resolved) {
      return resolved;
    }
  }

  return null;
}

/**
 * Resolves a workspace package subpath.
 *
 * Example:
 * react-devtools-shared/src/frontend/types
 */
async function resolveWorkspaceSubpath(
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
  subpath: string
): Promise<string | null> {
  const normalizedSubpath = subpath.replace(/^\/+/, "");

  if (
    !normalizedSubpath ||
    normalizedSubpath.includes("\0") ||
    normalizedSubpath.includes("\\") ||
    normalizedSubpath.split("/").some(
      (segment) =>
        segment === ".." || segment === "." || segment === ""
    )
  ) {
    return null;
  }

  const candidate = path.resolve(
    workspacePackage.directory,
    normalizedSubpath
  );

  if (
    !isInsideDirectory(
      workspacePackage.directory,
      candidate
    )
  ) {
    return null;
  }

  return findExistingFile(
    repositoryRoot,
    candidate
  );
}

/**
 * Finds the actual project root inside the downloaded repository.
 */
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

      if (
        !isInsideDirectory(
          repositoryRoot,
          realConfigDirectory
        )
      ) {
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
 * - Node.js built-ins
 * - Declared external packages
 * - Workspace package entry points
 * - Workspace package subpaths
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

  if (
    !isInsideDirectory(
      realRepositoryRoot,
      importerAbsolutePath
    )
  ) {
    throw new Error("Importer path is outside the repository.");
  }

  const importerRealPath = await fs.realpath(
    importerAbsolutePath
  );

  if (
    !isInsideDirectory(
      realRepositoryRoot,
      importerRealPath
    )
  ) {
    throw new Error("Importer file is outside the repository.");
  }

  const projectRoot = await findProjectRoot(
    realRepositoryRoot,
    importerRealPath
  );

  const aliases = await discoverJestAliases(projectRoot);

  const declaredPackages = await discoverDeclaredPackages(
    realRepositoryRoot,
    importerRealPath
  );

  const workspacePackages = await getWorkspacePackages(
  realRepositoryRoot
);

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

    // Relative imports.
    if (
      source.startsWith("./") ||
      source.startsWith("../")
    ) {
      candidate = path.resolve(
        path.dirname(importerRealPath),
        source
      );

      if (
        !isInsideDirectory(
          realRepositoryRoot,
          candidate
        )
      ) {
        dependencies.push({
          source,
          type: "unresolved",
          resolvedPath: null,
          reason: "import-escapes-repository",
        });

        continue;
      }
    } else {
      // Node.js built-in modules.
      if (isNodeBuiltin(source)) {
        dependencies.push({
          source,
          type: "external",
          resolvedPath: null,
          reason: "node-builtin",
        });

        continue;
      }

      // Static repository aliases.
      const resolvedAlias = await resolveAlias(
        projectRoot,
        source,
        aliases
      );

      if (resolvedAlias) {
        candidate = resolvedAlias;
      } else {
        const packageName = getPackageName(source);

        const workspacePackage = packageName
          ? workspacePackages.get(packageName)
          : undefined;

        if (workspacePackage && packageName) {
          const subpath = source.slice(packageName.length);

          if (subpath.startsWith("/")) {
            candidate = await resolveWorkspaceSubpath(
              realRepositoryRoot,
              workspacePackage,
              subpath
            );

            if (!candidate) {
              dependencies.push({
                source,
                type: "unresolved",
                resolvedPath: null,
                reason: "workspace-subpath-not-found",
              });

              continue;
            }
          } else {
            candidate = await resolveWorkspacePackage(
              realRepositoryRoot,
              workspacePackage
            );

            if (!candidate) {
              dependencies.push({
                source,
                type: "unresolved",
                resolvedPath: null,
                reason: "workspace-entry-not-found",
              });

              continue;
            }
          }
        } else if (
          packageName &&
          declaredPackages.has(packageName)
        ) {
          dependencies.push({
            source,
            type: "external",
            resolvedPath: null,
            reason: "declared-package",
          });

          continue;
        } else {
          dependencies.push({
            source,
            type: "unresolved",
            resolvedPath: null,
            reason: "alias-or-package-not-resolved",
          });

          continue;
        }
      }
    }

    if (!candidate) {
      dependencies.push({
        source,
        type: "unresolved",
        resolvedPath: null,
        reason: "file-not-found",
      });

      continue;
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

  const unresolvedDependencies = dependencies.filter(
    (dependency) => dependency.type === "unresolved"
  ).length;

  return {
    fileName: normalizedImporterPath,
    totalDependencies: dependencies.length,
    resolvedDependencies,
    unresolvedDependencies,
    dependencies,
  };
}
