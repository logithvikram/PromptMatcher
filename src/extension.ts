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
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Syncing Dev Agent Prompt Templates...' },
    async () => {
      try {
        log.info('Fetching awesome-copilot templates...');
        await fetchAwesomePrompts(promptsFolder);
        matcher.initialize(promptsFolder);
        log.info('Templates loaded and indexed successfully.');
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
      stream.progress('Analyzing task intent and matching awesome-copilot template...');

      // 1. Build composite query: user prompt + repo context
      const repoContext = buildRepoContext(chatContext);
      const compositeQuery = `${request.prompt} ${repoContext}`;
      log.info(`[Query] composite query length: ${compositeQuery.length} chars`);
      log.info(`[Query] user prompt: ${request.prompt}`);
      log.info(`[Query] repo context snippet: ${repoContext.slice(0, 200)}`);

      // 2. BM25 matching against prompt template library
      const injectedPrompt = matcher.findBestPrompt(compositeQuery);
      log.info(`[Matcher] injected prompt length: ${injectedPrompt.length} chars`);

      // 3. Assemble message payload
      const systemPart = injectedPrompt
        ? `[INSTRUCTION MANUAL]\n${injectedPrompt}\n\n`
        : '';

      const messages = [
        vscode.LanguageModelChatMessage.User(
          `${systemPart}[USER REQUEST]\n${request.prompt}`
        )
      ];

      // 4. Use whatever model the user already selected in the chat UI.
      //    Model selection is 100% the user's responsibility -- no override here.
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
// Repo context builder
// ---------------------------------------------------------------------------

/**
 * Assembles a context string from the current VS Code state:
 *   - Active editor: language ID, file name, selected text snippet
 *   - A window of code around the cursor (+/- 10 lines)
 *   - Open text-editor tab file names (project domain signal)
 *   - Recent chat history turns (last 3 user messages)
 *
 * This string is appended to the user's chat prompt before BM25 scoring
 * so the matcher has richer signal about what the user is working on.
 */
function buildRepoContext(chatContext: vscode.ChatContext): string {
  const parts: string[] = [];

  // --- Active editor signals ---
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    parts.push(`language:${doc.languageId}`);
    parts.push(`file:${path.basename(doc.fileName)}`);

    const selection = editor.selection;
    if (!selection.isEmpty) {
      // Selected text (capped at 500 chars)
      const selectedText = doc.getText(selection).slice(0, 500);
      parts.push(`selection:${selectedText}`);
    }

    // Code window around cursor (+/- 10 lines)
    const cursorLine = selection.active.line;
    const startLine = Math.max(0, cursorLine - 10);
    const endLine = Math.min(doc.lineCount - 1, cursorLine + 10);
    const surroundingCode = doc
      .getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length))
      .slice(0, 800);
    parts.push(`context:${surroundingCode}`);
  }

  // --- Open tab file names ---
  const openTabNames = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => (t.input instanceof vscode.TabInputText ? path.basename(t.input.uri.fsPath) : ''))
    .filter(Boolean)
    .slice(0, 20)
    .join(' ');
  if (openTabNames) {
    parts.push(`openfiles:${openTabNames}`);
  }

  // --- Recent chat history (last 3 user turns) ---
  const recentHistory = chatContext.history
    .filter((h): h is vscode.ChatRequestTurn => h instanceof vscode.ChatRequestTurn)
    .slice(-3)
    .map((h) => h.prompt)
    .join(' ');
  if (recentHistory) {
    parts.push(`history:${recentHistory}`);
  }

  return parts.join(' ');
}

export function deactivate() {}
