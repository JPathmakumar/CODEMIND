
import { useEffect, useState } from "react";
import {
  GitBranch,
  Upload,
  FolderGit2,
  ArrowRight,
  FileArchive,
  ExternalLink,
} from "lucide-react";

interface RepositoryResponse {
  success: boolean;
  repository?: {
    id: number;
    name: string;
    fullName: string;
    description: string | null;
    url: string;
    language: string | null;
    stars: number;
    forks: number;
    defaultBranch: string;
    isPrivate: boolean;
  };
  message?: string;
}

interface SavedRepository {
  id: string;
  githubId: string;
  name: string;
  fullName: string;
  description: string | null;
  url: string;
  language: string | null;
  stars: number;
  forks: number;
  defaultBranch: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

function Repositories() {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState("");
  const [repositories, setRepositories] = useState<SavedRepository[]>([]);
  const [connectedRepository, setConnectedRepository] =
    useState<NonNullable<RepositoryResponse["repository"]> | null>(null);

  async function fetchRepositories() {
    try {
      const response = await fetch(
        "http://localhost:4000/api/repositories"
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error("Failed to load repositories.");
      }

      setRepositories(data.repositories);
    } catch (err) {
      console.error("Repository loading error:", err);
    } finally {
      setIsFetching(false);
    }
  }

  useEffect(() => {
    fetchRepositories();
  }, []);

  async function handleConnect() {
    setError("");
    setConnectedRepository(null);

    if (!repositoryUrl.trim()) {
      setError("Please enter a GitHub repository URL.");
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(
        "http://localhost:4000/api/repositories/import",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: repositoryUrl.trim(),
          }),
        }
      );

      const data: RepositoryResponse = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.message || "Failed to validate repository."
        );
      }

      setConnectedRepository(data.repository ?? null);

      // Refresh the saved repository list.
      setIsFetching(true);
      await fetchRepositories();

      setRepositoryUrl("");
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Unable to connect to CODEMIND API.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="repository-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1>Repositories</h1>
          <p>Connect and manage your codebases.</p>
        </div>
      </div>

      <div className="import-grid">
        <section className="import-card">
          <div className="import-icon">
            <GitBranch size={25} />
          </div>

          <h2>Import from GitHub</h2>

          <p>
            Connect a GitHub repository to start understanding
            its architecture and code.
          </p>

          <label htmlFor="repository-url">
            Repository URL
          </label>

          <input
            id="repository-url"
            type="url"
            placeholder="https://github.com/username/repository"
            value={repositoryUrl}
            onChange={(event) => {
              setRepositoryUrl(event.target.value);
              setError("");
              setConnectedRepository(null);
            }}
          />

          <button
            className="import-button"
            onClick={handleConnect}
            disabled={isLoading}
          >
            {isLoading ? "Connecting..." : "Connect repository"}
            {!isLoading && <ArrowRight size={17} />}
          </button>

          {error && (
            <div className="repository-message error" role="alert">
              {error}
            </div>
          )}

          {connectedRepository && (
            <div className="repository-message success">
              <div className="repository-card-header">
                <div>
                  <span className="repository-status">
                    {connectedRepository.isPrivate
                      ? "Private"
                      : "Public"} repository
                  </span>

                  <h3>{connectedRepository.fullName}</h3>
                </div>

                <GitBranch size={24} />
              </div>

              <p>
                {connectedRepository.description ||
                  "No repository description available."}
              </p>

              <div className="repository-stats">
                <div>
                  <strong>
                    {connectedRepository.language || "Unknown"}
                  </strong>
                  <span>Language</span>
                </div>

                <div>
                  <strong>
                    {connectedRepository.stars.toLocaleString()}
                  </strong>
                  <span>Stars</span>
                </div>

                <div>
                  <strong>
                    {connectedRepository.forks.toLocaleString()}
                  </strong>
                  <span>Forks</span>
                </div>
              </div>

              <div className="repository-branch">
                <span>Default branch</span>
                <strong>{connectedRepository.defaultBranch}</strong>
              </div>

              <a
                href={connectedRepository.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                View repository on GitHub
                <ArrowRight size={15} />
              </a>
            </div>
          )}
        </section>

        <section className="import-card">
          <div className="import-icon">
            <Upload size={25} />
          </div>

          <h2>Upload ZIP file</h2>

          <p>
            Import a project directly from your computer
            using a ZIP archive.
          </p>

          <div className="upload-area">
            <FileArchive size={30} />

            <strong>Choose a ZIP file</strong>

            <span>ZIP archives only</span>

            <input
              type="file"
              accept=".zip,application/zip"
              aria-label="Choose a ZIP archive"
            />
          </div>
        </section>
      </div>

      <section className="repository-list">
        <div className="repository-list-heading">
          <div>
            <h2>Your repositories</h2>
            <p>Projects connected to CODEMIND.</p>
          </div>

          <FolderGit2 size={22} />
        </div>

        {isFetching ? (
          <div className="repository-empty">
            <p>Loading your repositories...</p>
          </div>
        ) : repositories.length === 0 ? (
          <div className="repository-empty">
            <FolderGit2 size={30} />
            <h3>No repositories connected</h3>
            <p>Import your first project to get started.</p>
          </div>
        ) : (
          <div className="saved-repository-grid">
            {repositories.map((repo) => (
              <article className="saved-repository-card" key={repo.id}>
                <div className="repository-card-header">
                  <div>
                    <span className="repository-status">
                      {repo.isPrivate ? "Private" : "Public"} repository
                    </span>

                    <h3>{repo.fullName}</h3>
                  </div>

                  <GitBranch size={22} />
                </div>

                <p>
                  {repo.description ||
                    "No repository description available."}
                </p>

                <div className="repository-stats">
                  <div>
                    <strong>{repo.language || "Unknown"}</strong>
                    <span>Language</span>
                  </div>

                  <div>
                    <strong>{repo.stars.toLocaleString()}</strong>
                    <span>Stars</span>
                  </div>

                  <div>
                    <strong>{repo.forks.toLocaleString()}</strong>
                    <span>Forks</span>
                  </div>
                </div>

                <div className="repository-branch">
                  <span>Default branch</span>
                  <strong>{repo.defaultBranch}</strong>
                </div>

                <a
                  href={repo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on GitHub
                  <ExternalLink size={15} />
                </a>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default Repositories;
