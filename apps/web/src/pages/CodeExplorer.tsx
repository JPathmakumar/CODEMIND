
import { useEffect, useState } from "react";

import {
  Folder,
  FileCode,
  ChevronRight,
  Code2,
  ArrowLeft,
} from "lucide-react";

import Prism from "prismjs";
import "prismjs/themes/prism.css";
import "prismjs/plugins/line-numbers/prism-line-numbers";
import "prismjs/plugins/line-numbers/prism-line-numbers.css";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-python";

function getLanguageFromFileName(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();

  const languages: Record<string, string> = {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    json: "json",
    css: "css",
    html: "markup",
    xml: "markup",
    py: "python",
  };

  return languages[extension ?? ""] ?? "plaintext";
}

interface SavedRepository {
  id: string;
  name: string;
  fullName: string;
  language: string | null;
}

interface FileEntry {
  name: string;
  type: "directory" | "file" | "unsupported";
  size: number | null;
}

interface FileMetadata {
  fileName: string;
  extension: string;
  language: string;
  size: number;
  lineCount: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function CodeExplorer() {
  const [repositories, setRepositories] = useState<SavedRepository[]>([]);
  const [selectedRepository, setSelectedRepository] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [error, setError] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  const [fileMetadata, setFileMetadata] =
    useState<FileMetadata | null>(null);

  useEffect(() => {
    if (!fileContent || !selectedFile) return;

    Prism.highlightAll();
  }, [fileContent, selectedFile]);

  useEffect(() => {
    async function fetchRepositories() {
      try {
        const response = await fetch(
          "http://localhost:4000/api/repositories"
        );

        if (!response.ok) {
          throw new Error("Unable to load repositories.");
        }

        const data = await response.json();
        setRepositories(data.repositories ?? []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Something went wrong."
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchRepositories();
  }, []);

  useEffect(() => {
    if (!selectedRepository) {
      setEntries([]);
      return;
    }

    async function fetchFiles() {
      setIsLoadingFiles(true);
      setError("");

      try {
        const params = new URLSearchParams();

        if (currentPath) {
          params.set("path", currentPath);
        }

        const response = await fetch(
          `http://localhost:4000/api/files/${selectedRepository}?${params}`
        );

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.message || "Unable to load files.");
        }

        setEntries(data.entries);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to load files."
        );
        setEntries([]);
      } finally {
        setIsLoadingFiles(false);
      }
    }

    fetchFiles();
  }, [selectedRepository, currentPath]);

  function openFolder(folderName: string) {
    setCurrentPath((previousPath) =>
      previousPath
        ? `${previousPath}/${folderName}`
        : folderName
    );
  }

  function goBack() {
    setCurrentPath((previousPath) => {
      const segments = previousPath.split("/");
      segments.pop();
      return segments.join("/");
    });
  }

  function selectRepository(repositoryId: string) {
    setSelectedRepository(repositoryId);
    setCurrentPath("");
    setEntries([]);
    setSelectedFile("");
    setFileContent("");
    setFileMetadata(null);
    setError("");
  }

  async function openFile(fileName: string) {
    if (!selectedRepository) return;

    const filePath = currentPath
      ? `${currentPath}/${fileName}`
      : fileName;

    setSelectedFile(filePath);
    setIsLoadingContent(true);
    setFileContent("");
    setFileMetadata(null);
    setError("");

    try {
      const params = new URLSearchParams();
      params.set("path", filePath);

      const response = await fetch(
        `http://localhost:4000/api/files/${selectedRepository}/content?${params}`
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to read file.");
      }

      setFileContent(data.content);
      setFileMetadata(data.metadata ?? null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to read file."
      );
    } finally {
      setIsLoadingContent(false);
    }
  }

  return (
    <div className="code-explorer">
      <header className="explorer-header">
        <div>
          <p className="eyebrow">DEVELOPMENT WORKSPACE</p>
          <h1>Code Explorer</h1>
          <p>Browse and understand your repository.</p>
        </div>
      </header>

      <div className="explorer-layout">
        <aside className="explorer-sidebar">
          <h3>EXPLORER</h3>

          {isLoading ? (
            <p>Loading repositories...</p>
          ) : error && !selectedRepository ? (
            <p>{error}</p>
          ) : (
            <select
              value={selectedRepository}
              onChange={(event) =>
                selectRepository(event.target.value)
              }
            >
              <option value="">Select a repository</option>

              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.fullName}
                </option>
              ))}
            </select>
          )}

          {selectedRepository && (
            <div className="file-tree">
              <div className="file-tree-heading">
                <strong>FILES</strong>

                {currentPath && (
                  <button onClick={goBack} title="Go back">
                    <ArrowLeft size={15} />
                  </button>
                )}
              </div>

              {isLoadingFiles ? (
                <p>Loading files...</p>
              ) : error ? (
                <p>{error}</p>
              ) : entries.length === 0 ? (
                <p>This folder is empty.</p>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.name}
                    className="file-tree-item"
                    disabled={entry.type === "unsupported"}
                    onClick={() => {
                      if (entry.type === "directory") {
                        openFolder(entry.name);
                      } else if (entry.type === "file") {
                        openFile(entry.name);
                      }
                    }}
                  >
                    {entry.type === "directory" ? (
                      <>
                        <ChevronRight size={14} />
                        <Folder size={16} />
                      </>
                    ) : (
                      <>
                        <span className="file-tree-spacer" />
                        <FileCode size={16} />
                      </>
                    )}

                    <span>{entry.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </aside>

        <main className="code-editor">
          {selectedFile ? (
            <div className="editor-content">
              <div className="editor-tab">
                <FileCode size={16} />
                <span>{selectedFile}</span>
              </div>

              {isLoadingContent ? (
                <p className="editor-message">
                  Loading source code...
                </p>
              ) : error ? (
                <p className="editor-message">{error}</p>
              ) : (
                <>
                  {fileMetadata && (
                    <div className="file-metadata">
                      <div className="file-metadata-item">
                        <span>LANGUAGE</span>
                        <strong>{fileMetadata.language}</strong>
                      </div>

                      <div className="file-metadata-item">
                        <span>EXTENSION</span>
                        <strong>
                          {fileMetadata.extension === "none"
                            ? "No extension"
                            : `.${fileMetadata.extension}`}
                        </strong>
                      </div>

                      <div className="file-metadata-item">
                        <span>FILE SIZE</span>
                        <strong>
                          {formatFileSize(fileMetadata.size)}
                        </strong>
                      </div>

                      <div className="file-metadata-item">
                        <span>LINES</span>
                        <strong>{fileMetadata.lineCount}</strong>
                      </div>
                    </div>
                  )}

                  <pre className="code-content line-numbers">
                    <code
                      className={`language-${getLanguageFromFileName(
                        selectedFile.split("/").pop() ?? selectedFile
                      )}`}
                    >
                      {fileContent}
                    </code>
                  </pre>
                </>
              )}
            </div>
          ) : (
            <div className="editor-welcome">
              <Code2 size={48} />
              <h2>Welcome to Code Explorer</h2>
              <p>
                {selectedRepository
                  ? "Select a file to start exploring."
                  : "Select a repository to start exploring."}
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
