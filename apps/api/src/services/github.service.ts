
import { Octokit } from "octokit";

const octokit = new Octokit();

export async function getRepositoryInfo(
  owner: string,
  repository: string
) {
  try {
    const { data } = await octokit.rest.repos.get({
      owner,
      repo: repository,
    });

    return {
      success: true,
      repository: {
        id: data.id,
        name: data.name,
        fullName: data.full_name,
        description: data.description,
        url: data.html_url,
        language: data.language,
        stars: data.stargazers_count,
        forks: data.forks_count,
        defaultBranch: data.default_branch,
        isPrivate: data.private,
      },
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 404
    ) {
      throw new Error("GitHub repository not found.");
    }

    throw new Error("Unable to retrieve GitHub repository information.");
  }
}
