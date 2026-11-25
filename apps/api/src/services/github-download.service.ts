
const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024; // 50 MB

export interface RepositoryArchive {
  buffer: Buffer;
  fileName: string;
  size: number;
}

export async function downloadRepositoryArchive(
  owner: string,
  repository: string,
  branch: string
): Promise<RepositoryArchive> {
  if (
    !/^[a-zA-Z0-9-]+$/.test(owner) ||
    !/^[a-zA-Z0-9._-]+$/.test(repository) ||
    !branch ||
    branch.length > 255
  ) {
    throw new Error("Invalid repository information.");
  }

  const apiUrl =
    `https://api.github.com/repos/${encodeURIComponent(owner)}` +
    `/${encodeURIComponent(repository)}/zipball/${encodeURIComponent(branch)}`;

  const token = process.env.GITHUB_TOKEN;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "CODEMIND",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(apiUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "GitHub repository or branch not found."
          : "GitHub failed to download the repository."
      );
    }

    const finalUrl = new URL(response.url);

    if (
      finalUrl.protocol !== "https:" ||
      ![
        "api.github.com",
        "codeload.github.com",
      ].includes(finalUrl.hostname)
    ) {
      throw new Error("Unexpected GitHub download destination.");
    }

    const contentLength = Number(
      response.headers.get("content-length") || 0
    );

    if (contentLength > MAX_ARCHIVE_SIZE) {
      throw new Error("Repository archive exceeds the 50 MB limit.");
    }

    if (!response.body) {
      throw new Error("Repository archive is empty.");
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalSize = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        totalSize += value.byteLength;

        if (totalSize > MAX_ARCHIVE_SIZE) {
          await reader.cancel();
          throw new Error(
            "Repository archive exceeds the 50 MB limit."
          );
        }

        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) {
      throw new Error("Repository archive is empty.");
    }

    return {
      buffer,
      fileName: `${repository}.zip`,
      size: buffer.length,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }

    throw new Error("Unable to download repository archive.");
  }
}
