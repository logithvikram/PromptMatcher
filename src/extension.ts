import * as vscode from 'vscode';
import * as path from 'path';
import { fetchAwesomePrompts } from './promptFetcher';
import { PromptMatcher } from './promptMatcher';

export async function activate(context: vscode.ExtensionContext) {
  // Named output channel -- visible in View -> Output -> "@dev Agent"
  const log = vscode.window.createOutputChannel('@dev Agent', { log: true });
  log.info('Extension activated.');

  const promptsFolder = path.join(context.globalStorageUri.fsPath, 'awesome-prompts');
  log.info(`Prompt cache folder: ${promptsFolder}`);
  const matcher = new PromptMatcher();
  context.subscriptions.push(log);

  // Background initialization for template indexing
  const initPromise = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Syncing Dev Agent Prompt Templates...' },
    async () => {
      try {
        log.info('Fetching awesome-copilot templates...');
        await fetchAwesomePrompts(promptsFolder);
        const count = matcher.initialize(promptsFolder);
        log.info(`Templates loaded and indexed successfully (${count} documents indexed).`);

        // Log all cached template files
        const records = matcher.getRecords();
        log.info(`=== Cached Prompt Templates (${records.length}) ===`);
        records.forEach((record, index) => {
          const relPath = path.relative(promptsFolder, record.filePath).replace(/\\/g, '/');
          log.info(`  [${index + 1}/${records.length}] ${relPath}`);
        });
        log.info('================================================');
      } catch (err: any) {
        log.error(`[Sync] Failed to load templates: ${err.message}`);
        // Extension still works — requests go to model without injected instructions
      }
    }
  );

  // Register VS Code Chat Participant: @dev
  const devAgent = vscode.chat.createChatParticipant(
    'dev-chat-agent.dev',
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      stream.progress('Analyzing task intent, scanning workspace context, and matching template...');

      // Ensure template loading and indexing has completed before matching
      await initPromise;

      // 1. Gather rich workspace, editor, and referenced files context
      const { bm25Context, promptRepoContext } = await gatherFullRepoContext(request, chatContext);

      // 2. Build composite query for BM25 matching
      const compositeQuery = `${request.prompt} ${bm25Context}`.trim();
      log.info(`[Query] composite query length: ${compositeQuery.length} chars`);
      log.info(`[Query] user prompt: ${request.prompt}`);
      log.info(`[Query] repo context snippet: ${bm25Context.slice(0, 200)}`);
      log.info(`[Matcher] Total indexed templates available: ${matcher.documentCount}`);

      // 3. BM25 matching against prompt template library
      const match = matcher.findBestPromptRecord(compositeQuery);
      if (match) {
        const fileName = path.basename(match.filePath);
        log.info(`[Matcher] Selected prompt template: "${fileName}" (${match.filePath})`);
      } else {
        log.info('[Matcher] No prompt template matched. Proceeding with raw user prompt.');
      }
      const injectedPrompt = match ? match.content : '';
      log.info(`[Matcher] injected prompt length: ${injectedPrompt.length} chars`);

      // 4. Assemble full prompt payload with instructions, repo context, and user request
      const payloadSections: string[] = [];

      if (injectedPrompt) {
        payloadSections.push(
          `[INSTRUCTION MANUAL & BEST PRACTICES]\n` +
          `Follow these matched instructions and guidelines to complete the task:\n${injectedPrompt}`
        );
      }

      if (promptRepoContext) {
        payloadSections.push(
          `[WORKSPACE OVERVIEW & ARCHITECTURE CONTEXT]\n` +
          `Analyze the workspace layout, detected technology stack, active editor context, and configuration manifests below to determine the project entrypoints, architecture, and code flow autonomously:\n\n${promptRepoContext}`
        );
      }

      payloadSections.push(`[USER REQUEST]\n${request.prompt}`);

      // Reconstruct conversation history turns
      const messages: vscode.LanguageModelChatMessage[] = [];

      for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const responseText = turn.response
            .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
            .map((part) => part.value.value)
            .join('\n');
          if (responseText) {
            messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
          }
        }
      }

      // Add current request with complete context
      messages.push(vscode.LanguageModelChatMessage.User(payloadSections.join('\n\n')));

      // 5. Use whatever model the user already selected in the chat UI.
      try {
        const model = request.model;
        log.info(`[Model] Using user-selected model: ${model.id}`);

        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
          stream.markdown(chunk);
        }
        log.info('[LLM] Response complete.');
      } catch (err: any) {
        log.error(`[Error] ${err.message}`);
        stream.markdown(`Execution Error: ${err.message}`);
      }
    }
  );

  context.subscriptions.push(devAgent);
}

// ---------------------------------------------------------------------------
// Generic Workspace & Repository Context Gatherer (Universal for All Repo Types)
// ---------------------------------------------------------------------------

interface ContextResult {
  bm25Context: string;
  promptRepoContext: string;
}

/**
 * Common configuration/manifest file patterns across all major programming
 * languages, build tools, and frameworks.
 */
const GENERIC_MANIFEST_PATTERNS = [
  // Node / TS / JS / Deno / Bun
  'package.json',
  'tsconfig.json',
  'deno.json',
  'bunfig.toml',
  // Python
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Pipfile',
  'environment.yml',
  // Rust
  'Cargo.toml',
  // Go
  'go.mod',
  'go.work',
  // Java / Kotlin / JVM
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  // C / C++ / Native
  'CMakeLists.txt',
  'Makefile',
  'meson.build',
  // .NET / C# / F#
  '*.sln',
  '*.csproj',
  // Ruby
  'Gemfile',
  // PHP
  'composer.json',
  // Swift / Dart / Mobile
  'Package.swift',
  'pubspec.yaml',
  // Containers & Infrastructure
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
  'main.tf',
  // Documentation / Project Overview
  'README.md',
  'README.txt',
  'README',
];

const EXCLUDED_DIRS_GLOB =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**,**/out/**,**/target/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/bin/**,**/obj/**,**/vendor/**,**/.next/**,**/.turbo/**}';

/**
 * Gathers complete, generic repository context from:
 *   1. User-attached chat references (#file, #codebase, #selection, etc.)
 *   2. Active text editor (file name, language, selection, surrounding code)
 *   3. Open tabs across editor groups
 *   4. Generic workspace file tree & tech stack language breakdown
 *   5. Key project manifests / configuration files across any repo type
 *   6. Recent chat history turns
 */
async function gatherFullRepoContext(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext
): Promise<ContextResult> {
  const bm25Parts: string[] = [];
  const promptSections: string[] = [];

  // --- 1. Process explicit user references (#file, #codebase, etc.) ---
  if (request.references && request.references.length > 0) {
    const refTexts: string[] = [];
    for (const ref of request.references) {
      try {
        if (ref.value instanceof vscode.Uri) {
          const fileBytes = await vscode.workspace.fs.readFile(ref.value);
          const fileContent = Buffer.from(fileBytes).toString('utf8');
          const rel = vscode.workspace.asRelativePath(ref.value);
          refTexts.push(`### Referenced File: ${rel}\n\`\`\`\n${fileContent.slice(0, 6000)}\n\`\`\``);
          bm25Parts.push(`file:${path.basename(rel)}`);
        } else if (ref.value && typeof ref.value === 'object' && 'uri' in ref.value && ref.value.uri instanceof vscode.Uri) {
          const loc = ref.value as vscode.Location;
          const fileBytes = await vscode.workspace.fs.readFile(loc.uri);
          const fileContent = Buffer.from(fileBytes).toString('utf8');
          const rel = vscode.workspace.asRelativePath(loc.uri);
          refTexts.push(`### Referenced Location: ${rel}\n\`\`\`\n${fileContent.slice(0, 6000)}\n\`\`\``);
          bm25Parts.push(`file:${path.basename(rel)}`);
        }
      } catch {
        // Skip unreadable reference
      }
    }
    if (refTexts.length > 0) {
      promptSections.push(`## Explicit User References:\n${refTexts.join('\n\n')}`);
    }
  }

  // --- 2. Active text editor context ---
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    bm25Parts.push(`language:${doc.languageId}`);
    bm25Parts.push(`file:${path.basename(doc.fileName)}`);

    const selection = editor.selection;
    if (!selection.isEmpty) {
      const selectedText = doc.getText(selection).slice(0, 1500);
      bm25Parts.push(`selection:${selectedText}`);
      promptSections.push(`## Active Editor File: ${relPath} (${doc.languageId})\n### Selected Code:\n\`\`\`${doc.languageId}\n${selectedText}\n\`\`\``);
    } else {
      // Include surrounding code or full file if reasonably sized (< 400 lines)
      let codeSnippet = '';
      if (doc.lineCount <= 400) {
        codeSnippet = doc.getText().slice(0, 10000);
      } else {
        const cursorLine = selection.active.line;
        const startLine = Math.max(0, cursorLine - 40);
        const endLine = Math.min(doc.lineCount - 1, cursorLine + 40);
        codeSnippet = doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length));
      }
      bm25Parts.push(`context:${codeSnippet.slice(0, 500)}`);
      promptSections.push(`## Active Editor File: ${relPath} (${doc.languageId})\n\`\`\`${doc.languageId}\n${codeSnippet}\n\`\`\``);
    }
  }

  // --- 3. Open tabs signal ---
  const openTabNames = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : ''))
    .filter(Boolean)
    .slice(0, 25);

  if (openTabNames.length > 0) {
    bm25Parts.push(`openfiles:${openTabNames.map((f) => path.basename(f)).join(' ')}`);
    promptSections.push(`## Currently Open Tabs in Editor:\n${openTabNames.map((f) => `- ${f}`).join('\n')}`);
  }

  // --- 4. Generic Workspace Structure, Tech Stack & Manifests ---
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    try {
      // Sample workspace files across the project
      const files = await vscode.workspace.findFiles('**/*', EXCLUDED_DIRS_GLOB, 60);

      const relFiles = files.map((f) => vscode.workspace.asRelativePath(f)).sort();

      // Compute file extension distribution to detect repository tech stack
      const extCounts: Record<string, number> = {};
      for (const rel of relFiles) {
        const ext = path.extname(rel).toLowerCase();
        if (ext) {
          extCounts[ext] = (extCounts[ext] || 0) + 1;
        }
      }

      const topExtensions = Object.entries(extCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([ext, count]) => `${ext} (${count} files)`)
        .join(', ');

      if (topExtensions) {
        bm25Parts.push(`techstack:${topExtensions}`);
      }

      if (relFiles.length > 0) {
        const treeInfo = [
          `## Workspace File Tree Structure (Sample of ${Math.min(relFiles.length, 50)} files):`,
          topExtensions ? `Primary file types detected: ${topExtensions}` : '',
          '```',
          ...relFiles.slice(0, 50),
          '```',
        ]
          .filter(Boolean)
          .join('\n');

        promptSections.push(treeInfo);
      }

      // Read key project manifest and config files dynamically across ecosystems
      const manifestContents: string[] = [];
      const visitedFiles = new Set<string>();

      for (const pattern of GENERIC_MANIFEST_PATTERNS) {
        if (manifestContents.length >= 6) {
          break; // Limit total manifest files to keep token payload optimal
        }

        const matches = await vscode.workspace.findFiles(pattern, EXCLUDED_DIRS_GLOB, 2);
        for (const uri of matches) {
          const rel = vscode.workspace.asRelativePath(uri);
          if (visitedFiles.has(rel)) {
            continue;
          }
          visitedFiles.add(rel);

          try {
            const raw = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(raw).toString('utf8');
            // Trim to max 2500 chars per config file
            const snippet = text.length > 2500 ? `${text.slice(0, 2500)}\n... [truncated]` : text;
            manifestContents.push(`### Configuration / Manifest: ${rel}\n\`\`\`\n${snippet}\n\`\`\``);
            bm25Parts.push(`manifest:${path.basename(rel)}`);

            if (manifestContents.length >= 6) {
              break;
            }
          } catch {
            // Skip unreadable file
          }
        }
      }

      if (manifestContents.length > 0) {
        promptSections.push(`## Repository Manifests & Configuration:\n${manifestContents.join('\n\n')}`);
      }
    } catch {
      // Workspace scan failure handled silently
    }
  }

  // --- 5. Recent chat history for BM25 query ---
  const recentHistory = chatContext.history
    .filter((h): h is vscode.ChatRequestTurn => h instanceof vscode.ChatRequestTurn)
    .slice(-3)
    .map((h) => h.prompt)
    .join(' ');
  if (recentHistory) {
    bm25Parts.push(`history:${recentHistory}`);
  }

  return {
    bm25Context: bm25Parts.join(' '),
    promptRepoContext: promptSections.join('\n\n'),
  };
}

export function deactivate() {}
