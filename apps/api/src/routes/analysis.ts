
import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { prisma } from "../lib/prisma.js";
import { analyzeCode } from "../services/code-analysis.service.js";
import { analyzeImports } from "../services/import-analysis.service.js";
import { resolveDependencies } from "../services/dependency-resolution.service.js";

const router = Router();

const paramsSchema = z.object({
  repositoryId: z.string().uuid(),
});

const bodySchema = z.object({
  path: z.string().min(1).max(1000),
});

const MAX_FILE_SIZE = 1 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
];

const storageDirectory = fileURLToPath(
  new URL("../../storage/repositories/", import.meta.url)
);

interface SourceFileResult {
  repositoryName: string;
  sourceCode: string;
}

/**
 * Validates a repository file path and safely reads its source code.
 */
async function readSourceFile(
  repositoryId: string,
  requestedPath: string
): Promise<SourceFileResult> {
  if (
    requestedPath.includes("\\") ||
    requestedPath.includes("\0") ||
    requestedPath.startsWith("/") ||
    requestedPath.split("/").some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    )
  ) {
    throw new Error("INVALID_FILE_PATH");
  }

  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
  });

  if (!repository) {
    throw new Error("REPOSITORY_NOT_FOUND");
  }

  const storageRoot = path.resolve(
    storageDirectory,
    repository.id
  );

  const targetPath = path.resolve(
    storageRoot,
    requestedPath
  );

  const relativePath = path.relative(
    storageRoot,
    targetPath
  );

  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("INVALID_FILE_PATH");
  }

  // Check every path segment for symbolic links.
  let currentPath = storageRoot;

  for (const segment of requestedPath.split("/")) {
    currentPath = path.join(currentPath, segment);

    const segmentStats = await fs.lstat(currentPath);

    if (segmentStats.isSymbolicLink()) {
      throw new Error("SYMBOLIC_LINK_NOT_ALLOWED");
    }
  }

  const fileStats = await fs.lstat(targetPath);

  if (!fileStats.isFile()) {
    throw new Error("NOT_A_REGULAR_FILE");
  }

  if (fileStats.size > MAX_FILE_SIZE) {
    throw new Error("FILE_TOO_LARGE");
  }

  const extension = path.extname(targetPath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new Error("UNSUPPORTED_FILE_TYPE");
  }

  const buffer = await fs.readFile(targetPath);

  if (
    buffer.length > MAX_FILE_SIZE ||
    buffer.includes(0)
  ) {
    throw new Error("INVALID_TEXT_FILE");
  }

  let sourceCode: string;

  try {
    sourceCode = new TextDecoder("utf-8", {
      fatal: true,
    }).decode(buffer);
  } catch {
    throw new Error("INVALID_UTF8");
  }

  return {
    repositoryName: repository.fullName,
    sourceCode,
  };
}

/**
 * Sends consistent errors for file-analysis requests.
 */
function handleAnalysisError(
  error: unknown,
  res: import("express").Response
) {
  const errorCode =
    error instanceof Error ? error.message : "";

  const knownErrors: Record<
    string,
    { status: number; message: string }
  > = {
    INVALID_FILE_PATH: {
      status: 400,
      message: "Invalid file path.",
    },
    REPOSITORY_NOT_FOUND: {
      status: 404,
      message: "Repository not found.",
    },
    SYMBOLIC_LINK_NOT_ALLOWED: {
      status: 400,
      message: "Symbolic links cannot be analyzed.",
    },
    NOT_A_REGULAR_FILE: {
      status: 400,
      message: "The requested path is not a regular file.",
    },
    FILE_TOO_LARGE: {
      status: 413,
      message: "File exceeds the 1 MB analysis limit.",
    },
    UNSUPPORTED_FILE_TYPE: {
      status: 415,
      message: "This file type is not supported for analysis.",
    },
    INVALID_TEXT_FILE: {
      status: 415,
      message: "File is too large or is not a text file.",
    },
    INVALID_UTF8: {
      status: 415,
      message: "File is not valid UTF-8 text.",
    },
  };

  const knownError = knownErrors[errorCode];

  if (knownError) {
    return res.status(knownError.status).json({
      success: false,
      message: knownError.message,
    });
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  ) {
    return res.status(404).json({
      success: false,
      message: "File not found.",
    });
  }

  console.error("Analysis request error:", error);

  return res.status(500).json({
    success: false,
    message: "An error occurred while analyzing the file.",
  });
}

/**
 * POST /api/analysis/:repositoryId
 *
 * Detects functions, classes, and methods.
 */
router.post("/:repositoryId", async (req, res) => {
  try {
    const params = paramsSchema.safeParse(req.params);
    const body = bodySchema.safeParse(req.body);

    if (!params.success || !body.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid repository ID or file path.",
      });
    }

    const { repositoryId } = params.data;
    const requestedPath = body.data.path;

    const { repositoryName, sourceCode } =
      await readSourceFile(repositoryId, requestedPath);

    try {
      const analysis = analyzeCode(
        sourceCode,
        requestedPath
      );

      return res.json({
        success: true,
        repository: repositoryName,
        path: requestedPath,
        analysis,
      });
    } catch (error) {
      console.error("AST parsing error:", error);

      return res.status(422).json({
        success: false,
        message:
          "Unable to analyze this file. It may contain unsupported or invalid syntax.",
      });
    }
  } catch (error) {
    return handleAnalysisError(error, res);
  }
});

/**
 * POST /api/analysis/:repositoryId/imports
 *
 * Detects imported modules, symbols, and aliases.
 */
router.post("/:repositoryId/imports", async (req, res) => {
  try {
    const params = paramsSchema.safeParse(req.params);
    const body = bodySchema.safeParse(req.body);

    if (!params.success || !body.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid repository ID or file path.",
      });
    }

    const { repositoryId } = params.data;
    const requestedPath = body.data.path;

    const { repositoryName, sourceCode } =
      await readSourceFile(repositoryId, requestedPath);

    try {
      const analysis = analyzeImports(
        sourceCode,
        requestedPath
      );

      return res.json({
        success: true,
        repository: repositoryName,
        path: requestedPath,
        analysis,
      });
    } catch (error) {
      console.error("Import parsing error:", error);

      return res.status(422).json({
        success: false,
        message:
          "Unable to detect imports. The file may contain unsupported or invalid syntax.",
      });
    }
  } catch (error) {
    return handleAnalysisError(error, res);
  }
});

/**
 * POST /api/analysis/:repositoryId/dependencies
 *
 * Detects imports and resolves relative imports
 * to actual files inside the repository.
 */
router.post("/:repositoryId/dependencies", async (req, res) => {
  try {
    const params = paramsSchema.safeParse(req.params);
    const body = bodySchema.safeParse(req.body);

    if (!params.success || !body.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid repository ID or file path.",
      });
    }

    const { repositoryId } = params.data;
    const requestedPath = body.data.path;

    const { repositoryName, sourceCode } =
      await readSourceFile(repositoryId, requestedPath);

    try {
      // First, detect the imports in this source file.
      const importAnalysis = analyzeImports(
        sourceCode,
        requestedPath
      );

      // Then resolve relative imports to actual repository files.
      const repositoryRoot = path.resolve(
        storageDirectory,
        repositoryId
      );

      const analysis = await resolveDependencies(
        repositoryRoot,
        requestedPath,
        importAnalysis.imports
      );

      return res.json({
        success: true,
        repository: repositoryName,
        path: requestedPath,
        analysis,
      });
    } catch (error) {
      console.error("Dependency resolution error:", error);

      return res.status(422).json({
        success: false,
        message:
          "Unable to resolve dependencies for this file.",
      });
    }
  } catch (error) {
    return handleAnalysisError(error, res);
  }
});

export default router;
