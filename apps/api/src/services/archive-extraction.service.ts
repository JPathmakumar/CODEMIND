
import yauzl from "yauzl";
import path from "node:path";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const MAX_ENTRIES = 25000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB extracted
const MAX_COMPRESSION_RATIO = 100;

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "vendor",
]);

const SECRET_FILE_PATTERNS = [
  /^\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials/i,
  /secrets?/i,
];

export interface ExtractionResult {
  extractedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  rootDirectory: string;
}

function shouldSkipFile(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  const fileName = segments[segments.length - 1];

  if (
    segments.some((segment) =>
      EXCLUDED_DIRECTORIES.has(segment.toLowerCase())
    )
  ) {
    return true;
  }

  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) {
    return true;
  }

  return false;
}

function isSafeArchivePath(fileName: string): boolean {
  if (
    !fileName ||
    fileName.includes("\0") ||
    fileName.includes("\\") ||
    fileName.startsWith("/") ||
    /^[a-zA-Z]:/.test(fileName)
  ) {
    return false;
  }

  const segments = fileName.split("/");

  return segments.every(
    (segment) => segment !== ".." && segment !== "."
  );
}

function isSymbolicLink(mode: number): boolean {
  return (mode & 0o170000) === 0o120000;
}

function openArchive(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(error || new Error("Invalid ZIP archive."));
          return;
        }

        resolve(zipFile);
      }
    );
  });
}

export async function extractRepositoryArchive(
  buffer: Buffer,
  destination: string
): Promise<ExtractionResult> {
  if (buffer.length === 0) {
    throw new Error("Cannot extract an empty archive.");
  }

  const destinationPath = path.resolve(destination);

  await fs.promises.mkdir(destinationPath, {
    recursive: true,
  });

  const zipFile = await openArchive(buffer);

  let extractedFiles = 0;
  let skippedFiles = 0;
  let totalBytes = 0;
  let totalEntries = 0;

  const extractedPaths = new Set<string>();

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      zipFile.close();

      void fs.promises.rm(destinationPath, {
        recursive: true,
        force: true,
      }).finally(() => reject(error));
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      zipFile.close();

      resolve({
        extractedFiles,
        skippedFiles,
        totalBytes,
        rootDirectory: destinationPath,
      });
    };

    zipFile.on("error", fail);

    zipFile.on("entry", (entry) => {
      if (settled) return;

      void processEntry(entry).catch((error: unknown) => {
        fail(
          error instanceof Error
            ? error
            : new Error("Archive extraction failed.")
        );
      });
    });

    zipFile.on("end", finish);

    async function processEntry(
      entry: yauzl.Entry
    ): Promise<void> {
      if (settled) return;

      totalEntries++;

if (totalEntries > MAX_ENTRIES) {
  throw new Error("Archive contains too many entries.");
}

      const rawName = entry.fileName;

      if (!isSafeArchivePath(rawName)) {
        throw new Error("Archive contains an unsafe file path.");
      }

      const relativePath = rawName.replace(/\/$/, "");

      if (!relativePath) {
        zipFile.readEntry();
        return;
      }

      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;

      if (isSymbolicLink(mode)) {
        skippedFiles++;
        zipFile.readEntry();
        return;
      }

      if (shouldSkipFile(relativePath)) {
        skippedFiles++;
        zipFile.readEntry();
        return;
      }

      const targetPath = path.resolve(
        destinationPath,
        ...relativePath.split("/")
      );

      if (
        targetPath !== destinationPath &&
        !targetPath.startsWith(destinationPath + path.sep)
      ) {
        throw new Error("Archive path escapes extraction directory.");
      }

      const isDirectory = rawName.endsWith("/");

      if (isDirectory) {
        await fs.promises.mkdir(targetPath, {
          recursive: true,
        });

        zipFile.readEntry();
        return;
      }

      if (entry.uncompressedSize > MAX_FILE_SIZE) {
        throw new Error("An archive file exceeds the 10 MB limit.");
      }

      if (entry.uncompressedSize > 0 && entry.compressedSize === 0) {
        throw new Error("Invalid compressed archive entry.");
      }

      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize >
          MAX_COMPRESSION_RATIO
      ) {
        throw new Error("Archive compression ratio is too high.");
      }

      if (totalBytes + entry.uncompressedSize > MAX_TOTAL_SIZE) {
        throw new Error("Extracted archive exceeds the 100 MB limit.");
      }

      if (extractedPaths.has(targetPath)) {
        throw new Error("Archive contains duplicate file paths.");
      }

      extractedPaths.add(targetPath);

      await fs.promises.mkdir(path.dirname(targetPath), {
        recursive: true,
      });

      const readStream = await new Promise<Readable>(
  (resolveStream, rejectStream) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        rejectStream(error || new Error("Unable to read archive entry."));
        return;
      }

      resolveStream(stream as Readable);
    });
  }
);
      const writeStream = createWriteStream(targetPath, {
        flags: "wx",
        mode: 0o600,
      });

      let fileBytes = 0;

      const onData = (chunk: Buffer) => {
        fileBytes += chunk.length;

        if (fileBytes > MAX_FILE_SIZE) {
          readStream.destroy(
            new Error("Extracted file exceeds the 10 MB limit.")
          );
          return;
        }

        if (fileBytes > entry.uncompressedSize) {
          readStream.destroy(
            new Error("Archive entry exceeded its declared size.")
          );
        }
      };

      readStream.on("data", onData);

      try {
        await pipeline(readStream, writeStream);

        if (fileBytes !== entry.uncompressedSize) {
          throw new Error("Archive entry size does not match.");
        }

        totalBytes += fileBytes;
        extractedFiles++;
      } catch (error) {
        await fs.promises.rm(targetPath, { force: true });
        throw error;
      } finally {
        readStream.off("data", onData);
      }

      zipFile.readEntry();
    }

    zipFile.readEntry();
  });
}
