import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { getRepositoryInfo } from "../services/github.service.js";
import { prisma } from "../lib/prisma.js";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { downloadRepositoryArchive } from "../services/github-download.service.js";
import { extractRepositoryArchive } from "../services/archive-extraction.service.js";

const router = Router();

const repositorySchema = z.object({
  url: z.string().url("Please provide a valid URL."),
});

router.post("/import", async (req, res) => {
  const result = repositorySchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid repository URL.",
    });
  }

  const parsedUrl = new URL(result.data.url);

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    return res.status(400).json({
      success: false,
      message: "Only standard GitHub repository URLs are supported.",
    });
  }

  const parts = parsedUrl.pathname.split("/").filter(Boolean);

  if (
    parts.length !== 2 ||
    !/^[a-zA-Z0-9-]+$/.test(parts[0]) ||
    !/^[a-zA-Z0-9._-]+$/.test(parts[1])
  ) {
    return res.status(400).json({
      success: false,
      message: "Please provide a URL in the format https://github.com/owner/repository.",
    });
  }

  const [owner, repository] = parts;
  const cleanRepository = repository.replace(/\.git$/, "");

  if (!cleanRepository) {
    return res.status(400).json({
      success: false,
      message: "Invalid repository name.",
    });
  }

    try {
    const data = await getRepositoryInfo(owner, cleanRepository);
    const repo = data.repository;

    await prisma.repository.upsert({
      where: {
        githubId: BigInt(repo.id),
      },

      create: {
        githubId: BigInt(repo.id),
        name: repo.name,
        fullName: repo.fullName,
        description: repo.description,
        url: repo.url,
        language: repo.language,
        stars: repo.stars,
        forks: repo.forks,
        defaultBranch: repo.defaultBranch,
        isPrivate: repo.isPrivate,
      },

      update: {
        name: repo.name,
        fullName: repo.fullName,
        description: repo.description,
        url: repo.url,
        language: repo.language,
        stars: repo.stars,
        forks: repo.forks,
        defaultBranch: repo.defaultBranch,
        isPrivate: repo.isPrivate,
      },
    });

    return res.json({
      ...data,
      saved: true,
    });

  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to import repository.";

    const status =
      message === "GitHub repository not found." ? 404 : 502;

        return res.status(status).json({
      success: false,
      message,
    });
  }
});

router.get("/", async (_req, res) => {
  try {
    const repositories = await prisma.repository.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.json({
      success: true,
      repositories: repositories.map((repo) => ({
        ...repo,
        githubId: repo.githubId.toString(),
      })),
    });
  } catch (error) {
    console.error("Failed to retrieve repositories:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve saved repositories.",
    });
  }
});


router.post("/:id/download", async (req, res) => {
  const idResult = z.string().uuid().safeParse(req.params.id);

  if (!idResult.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid repository ID.",
    });
  }

  try {
    const repository = await prisma.repository.findUnique({
      where: {
        id: idResult.data,
      },
    });

    if (!repository) {
      return res.status(404).json({
        success: false,
        message: "Repository not found.",
      });
    }

    const githubUrl = new URL(repository.url);
    const parts = githubUrl.pathname.split("/").filter(Boolean);

    if (
      githubUrl.hostname !== "github.com" ||
      parts.length !== 2
    ) {
      return res.status(400).json({
        success: false,
        message: "Saved repository URL is invalid.",
      });
    }

    const [owner, repositoryName] = parts;

    const archive = await downloadRepositoryArchive(
      owner,
      repositoryName,
      repository.defaultBranch
    );

    const storageDirectory = fileURLToPath(
      new URL("../../storage/repositories/", import.meta.url)
    );

    const destination = path.resolve(
      storageDirectory,
      repository.id
    );

        // Create unique staging and backup directories.
    const staging = `${destination}.staging-${randomUUID()}`;
    const backup = `${destination}.backup-${randomUUID()}`;

    let oldRepositoryMoved = false;

    try {
      // Extract the new repository without touching the existing copy.
      const extraction = await extractRepositoryArchive(
        archive.buffer,
        staging
      );

      // Move the existing repository to a temporary backup.
      try {
        await fs.rename(destination, backup);
        oldRepositoryMoved = true;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }

      try {
        // Activate the newly extracted repository.
        await fs.rename(staging, destination);
      } catch (error) {
        // Restore the previous repository if activation fails.
        if (oldRepositoryMoved) {
          await fs.rename(backup, destination);
          oldRepositoryMoved = false;
        }

        throw error;
      }

      // Remove the old backup after successful replacement.
      if (oldRepositoryMoved) {
        await fs.rm(backup, {
          recursive: true,
          force: true,
        });
      }

      return res.json({
        success: true,
        message: "Repository source code downloaded successfully.",
        repository: {
          id: repository.id,
          fullName: repository.fullName,
        },
        archive: {
          size: archive.size,
          fileName: archive.fileName,
        },
        extraction: {
          extractedFiles: extraction.extractedFiles,
          skippedFiles: extraction.skippedFiles,
          totalBytes: extraction.totalBytes,
        },
      });
    } catch (error) {
      // Clean up an incomplete staging directory.
      await fs.rm(staging, {
        recursive: true,
        force: true,
      });

      throw error;
    }
  } catch (error) {
    console.error("Repository download failed:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Unable to download repository.";

    return res.status(500).json({
      success: false,
      message,
    });
  }
});


export default router;