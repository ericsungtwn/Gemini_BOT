import { Octokit } from "octokit";
import fs from "fs";
import path from "path";

export class GitHubService {
  private getOptions() {
    const token = process.env.GITHUB_TOKEN?.trim();
    const repoPath = process.env.GITHUB_REPO?.trim();

    if (!token || !repoPath) {
      throw new Error("GitHub 設定缺失：請確認 Secrets 中的 GITHUB_TOKEN 已設定，且 GITHUB_REPO 格式為 '帳號/儲存庫'");
    }

    const parts = repoPath.split("/");
    if (parts.length !== 2) {
      throw new Error(`GITHUB_REPO 格式錯誤 ("${repoPath}")。應為 '帳號/儲存庫' (例如: ericsungtwn/Gemini_BOT)`);
    }

    return {
      octokit: new Octokit({ auth: token }),
      owner: parts[0],
      repo: parts[1]
    };
  }

  async syncFiles(files: string[]) {
    const { octokit, owner, repo } = this.getOptions();

    console.log(`正在嘗試同步到 GitHub: ${owner}/${repo}`);

    // 1. Verify repo and get default branch
    let defaultBranch = "main";
    try {
      const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
      defaultBranch = repoData.default_branch;
      
      if (repoData.permissions && !repoData.permissions.push) {
        throw new Error("您的 Token 對此倉庫沒有 'Push' (寫入) 權限。");
      }
    } catch (e: any) {
      if (e.status === 404) throw new Error(`找不到儲存库 "${owner}/${repo}"`);
      throw e;
    }

    // 2. Get the latest commit SHA of the default branch
    const { data: refData } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    const latestCommitSha = refData.object.sha;

    // 3. Get the tree SHA of the latest commit
    const { data: commitData } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: latestCommitSha,
    });
    const baseTreeSha = commitData.tree.sha;

    // 4. Prepare the tree changes
    const treeItems = [];
    const syncResults = [];

    for (const filePath of files) {
      const fullPath = path.join(process.cwd(), filePath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf8");
        treeItems.push({
          path: filePath,
          mode: "100644" as const,
          type: "blob" as const,
          content: content,
        });
        syncResults.push(`✅ ${filePath}`);
      } else {
        syncResults.push(`⚠️ ${filePath}: 檔案不存在`);
      }
    }

    if (treeItems.length === 0) {
      return "沒有檔案需要同步";
    }

    // 5. Create a new tree
    const { data: newTreeData } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    // 6. Create a new commit
    const { data: newCommitData } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: `Sync ${treeItems.length} files - ClawWeb v2.0 Bundle`,
      tree: newTreeData.sha,
      parents: [latestCommitSha],
    });

    // 7. Update the reference
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
      sha: newCommitData.sha,
    });

    return `同步成功！已將 ${treeItems.length} 個檔案打包為單一 Commit。\n\n詳細清單：\n${syncResults.join("\n")}`;
  }
}
