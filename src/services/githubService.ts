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

    // Verify repo and token permissions
    try {
      const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
      console.log(`成功連線至倉庫: ${repoData.full_name}, 權限: ${JSON.stringify(repoData.permissions)}`);
      
      if (repoData.permissions && !repoData.permissions.push) {
        throw new Error("您的 Token 對此倉庫沒有 'Push' (寫入) 權限。請檢查 Token 設定。");
      }
    } catch (e: any) {
      if (e.status === 404) {
        throw new Error(`找不到儲存庫 "${owner}/${repo}"。請確認：1. 倉庫已建立 2. 帳號名稱正確 3. Token 有權限看到此倉庫。`);
      }
      if (e.status === 401) {
        throw new Error("GitHub Token 無效或已過期。請重新產生 Token 並更新 Secret。");
      }
      throw new Error(`無法存取 GitHub (狀態碼: ${e.status}): ${e.message}`);
    }

    const results = [];
    for (const filePath of files) {
      try {
        const fullPath = path.join(process.cwd(), filePath);
        if (!fs.existsSync(fullPath)) {
          results.push(`⚠️ ${filePath}: 檔案不存在於伺服器`);
          continue;
        }

        const content = fs.readFileSync(fullPath, "utf8");
        const base64Content = Buffer.from(content).toString("base64");

        // Check if file exists to get SHA
        let sha: string | undefined;
        try {
          const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: filePath,
          });
          if (!Array.isArray(data)) {
            sha = data.sha;
          }
        } catch (e: any) {
          // 404 is fine here, means new file
          if (e.status !== 404) throw e;
        }

        await octokit.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: filePath,
          message: `Sync ${filePath} via ClawWeb Assistant`,
          content: base64Content,
          sha,
        });
        results.push(`✅ ${filePath}`);
      } catch (err: any) {
        results.push(`❌ ${filePath}: ${err.message}`);
      }
    }
    return results.join("\n");
  }
}
