import * as fs from 'fs';
import * as path from 'path';

const REPO_TREE_URL = 'https://api.github.com/repos/github/awesome-copilot/git/trees/main?recursive=1';
const RAW_BASE_URL = 'https://raw.githubusercontent.com/github/awesome-copilot/main/';

export async function fetchAwesomePrompts(outputDir: string): Promise<void> {
  // Check local cache to avoid rate-limiting
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0) {
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const response = await fetch(REPO_TREE_URL, {
    headers: { 'User-Agent': 'VSCode-Dev-Agent' }
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { tree: Array<{ path: string; type: string }> };

  const mdFiles = data.tree.filter(
    (file) =>
      file.type === 'blob' &&
      file.path.endsWith('.md') &&
      (file.path.startsWith('prompts/') ||
        file.path.startsWith('instructions/') ||
        file.path.startsWith('agents/') ||
        file.path.startsWith('skills/') ||
        file.path.startsWith('.github/skills/'))
  );

  // Fetch in small batches to prevent socket exhaustion
  const batchSize = 5;
  let downloaded = 0;

  for (let i = 0; i < mdFiles.length; i += batchSize) {
    const batch = mdFiles.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (file) => {
        const rawUrl = `${RAW_BASE_URL}${file.path}`;
        const contentRes = await fetch(rawUrl);
        if (contentRes.ok) {
          const content = await contentRes.text();
          const destPath = path.join(outputDir, file.path);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, content, 'utf8');
          downloaded++;
        }
      })
    );
  }

  if (downloaded === 0) {
    throw new Error('No prompt templates could be downloaded from awesome-copilot.');
  }
}

