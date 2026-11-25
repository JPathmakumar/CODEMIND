import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { fileURLToPath } from "node:url";

const router = Router();

const MAX_DIRECTORY_ENTRIES = 500;
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB

function detectFileLanguage(extension: string): string {
  const languages: Record<string, string> = {
    js: "JavaScript",
    jsx: "React JSX",
    ts: "TypeScript",
    tsx: "React TSX",
    json: "JSON",
    css: "CSS",
    scss: "SCSS",
    html: "HTML",
    xml: "XML",
    py: "Python",
    java: "Java",
    c: "C",
    cpp: "C++",
    cs: "C#",
    go: "Go",
    rs: "Rust",
    php: "PHP",
    rb: "Ruby",
    sql: "SQL",
    md: "Markdown",
    yml: "YAML",
    yaml: "YAML",
    sh: "Shell",
    bash: "Bash",
  };

  return languages[extension.toLowerCase()] ?? "Plain Text";
}

const paramsSchema = z.object({
  repositoryId: z.string().uuid(),
});

const querySchema = z.object({
  path: z.string().max(1000).optional().default(""),
});

router.get("/:repositoryId", async (req, res) => {
  const params = paramsSchema.safeParse(req.params);
  const query = querySchema.safeParse(req.query);

  if (!params.success || !query.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid request parameters.",
    });
  }

  try {
    const repository = await prisma.repository.findUnique({
      where: {
        id: params.data.repositoryId,
      },
    });

    if (!repository) {
      return res.status(404).json({
        success: false,
        message: "Repository not found.",
      });
    }

    const storageDirectory = fileURLToPath(
  new URL("../../storage/repositories/", import.meta.url)
);

const storageRoot = path.resolve(
  storageDirectory,
  repository.id
);

    const requestedPath = query.data.path;

    if (
      requestedPath.includes("\\") ||
      requestedPath.includes("\0") ||
      requestedPath.startsWith("/") ||
      requestedPath.split("/").some(
        (segment) => segment === "." || segment === ".."
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid directory path.",
      });
    }

    const targetDirectory = path.resolve(
      storageRoot,
      requestedPath
    );

    if (
      targetDirectory !== storageRoot &&
      !targetDirectory.startsWith(storageRoot + path.sep)
    ) {
      return res.status(400).json({
        success: false,
        message: "Access to this directory is not allowed.",
      });
    }

    const directoryMetadata = await fs.lstat(targetDirectory);

if (
  directoryMetadata.isSymbolicLink() ||
  !directoryMetadata.isDirectory()
) {
  return res.status(403).json({
    success: false,
    message: "Access to this directory is not allowed.",
  });
}

    const entries = await fs.readdir(targetDirectory, {
      withFileTypes: true,
    });

    const results = await Promise.all(
      entries.slice(0, MAX_DIRECTORY_ENTRIES).map(async (entry) => {
        const entryPath = path.join(targetDirectory, entry.name);
        const metadata = await fs.lstat(entryPath);

        return {
          name: entry.name,
          type: metadata.isDirectory()
            ? "directory"
            : metadata.isFile()
              ? "file"
              : "unsupported",
          size: metadata.isFile() ? metadata.size : null,
        };
      })
    );

    return res.json({
      success: true,
      repository: repository.fullName,
      path: requestedPath,
      entries: results,
      truncated: entries.length > MAX_DIRECTORY_ENTRIES,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return res.status(404).json({
        success: false,
        message: "Directory not found.",
      });
    }

    console.error("File browsing failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to browse repository files.",
    });
  }
});

router.get("/:repositoryId/content", async (req, res) => {
  const params = paramsSchema.safeParse(req.params);

  const query = z.object({
    path: z.string().min(1).max(1000),
  }).safeParse(req.query);

  if (!params.success || !query.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid request parameters.",
    });
  }

  try {
    const repository = await prisma.repository.findUnique({
      where: {
        id: params.data.repositoryId,
      },
    });

    if (!repository) {
      return res.status(404).json({
        success: false,
        message: "Repository not found.",
      });
    }

    const storageDirectory = fileURLToPath(
      new URL("../../storage/repositories/", import.meta.url)
    );

    const storageRoot = path.resolve(
      storageDirectory,
      repository.id
    );

    const requestedPath = query.data.path;

    const segments = requestedPath.split("/");

    if (
      requestedPath.includes("\\") ||
      requestedPath.includes("\0") ||
      requestedPath.startsWith("/") ||
      segments.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".."
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid file path.",
      });
    }

    const targetPath = path.resolve(
      storageRoot,
      ...segments
    );

    if (
      targetPath === storageRoot ||
      !targetPath.startsWith(storageRoot + path.sep)
    ) {
      return res.status(400).json({
        success: false,
        message: "Access to this file is not allowed.",
      });
    }

    // Check every path segment for symbolic links.
    let currentPath = storageRoot;

    for (let i = 0; i < segments.length; i++) {
      currentPath = path.join(currentPath, segments[i]);

      const metadata = await fs.lstat(currentPath);

      if (metadata.isSymbolicLink()) {
        return res.status(403).json({
          success: false,
          message: "Symbolic links are not allowed.",
        });
      }

      if (i < segments.length - 1 && !metadata.isDirectory()) {
        return res.status(400).json({
          success: false,
          message: "Invalid file path.",
        });
      }

      if (i === segments.length - 1 && !metadata.isFile()) {
        return res.status(400).json({
          success: false,
          message: "Requested path is not a regular file.",
        });
      }
    }

    const metadata = await fs.lstat(targetPath);

    if (metadata.size > MAX_FILE_SIZE) {
      return res.status(413).json({
        success: false,
        message: "File exceeds the 1 MB reading limit.",
      });
    }

    const buffer = await fs.readFile(targetPath);

    if (buffer.length > MAX_FILE_SIZE) {
      return res.status(413).json({
        success: false,
        message: "File exceeds the 1 MB reading limit.",
      });
    }

    // Reject binary files.
    if (buffer.includes(0)) {
      return res.status(415).json({
        success: false,
        message: "Binary files cannot be displayed.",
      });
    }

    let content: string;

    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
      }).decode(buffer);
    } catch {
      return res.status(415).json({
        success: false,
        message: "File is not valid UTF-8 text.",
      });
    }

    const fileName = path.basename(requestedPath);

const extension = path.extname(fileName).slice(1).toLowerCase();

const language = detectFileLanguage(extension);

const lineCount = content.length === 0
  ? 0
  : content.split(/\r\n|\r|\n/).length;

const fileMetadata = {
  fileName,
  extension: extension || "none",
  language,
  size: buffer.length,
  lineCount,
};

return res.json({
  success: true,
  repository: repository.fullName,
  path: requestedPath,
  metadata: fileMetadata,
  content,
});

  } catch (error) {
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

    console.error("File reading failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to read repository file.",
    });
  }
});

export default router;