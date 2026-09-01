# Dev Auto-Prompt Agent — `@dev`

> **A VS Code chat participant that automatically matches the best [awesome-copilot](https://github.com/github/awesome-copilot) prompt template to your request using BM25 semantic search — and injects it as an instruction manual before calling your chosen model.**

---

## ✨ Features

| Feature | Detail |
|---|---|
| 🔍 **BM25 search** | Uses [`fast-bm25`](https://github.com/patelvivekdev/fast-bm25) for accurate, library-grade ranking across awesome-copilot skills, prompts, and agents |
| 🌐 **Universal repo awareness** | Generic scanner for any repository type (Node, Python, Rust, Go, Java, C++, .NET, PHP, Ruby, mobile, DevOps) — lets the model autonomously understand entrypoints & architecture |
| 📚 **awesome-copilot library** | Auto-syncs prompt templates from [github/awesome-copilot](https://github.com/github/awesome-copilot) on first use |
| 🎛️ **Your model, your choice** | Uses whatever model you select in the VS Code chat UI — no override, no lock-in |
| ⚡ **Field-boosted index** | Template `name` (×3), `description` (×2), `tags` (×2), `content` (×1) for precise relevance |

---

## 🖥️ Requirements

- VS Code **≥ 1.90.0** (Chat API required)
- A language model available in VS Code Chat (GitHub Copilot, Antigravity, etc.)
- Node.js **≥ 18** and npm (for building from source)

---

## 🚀 Quick Start (Install from VSIX)

1. Download or build the `.vsix` file (see [Build from Source](#-build-from-source) below)
2. Open VS Code → **Extensions** sidebar → `···` menu → **Install from VSIX…**
3. Select the `.vsix` file
4. Reload VS Code when prompted

---

## 💬 How to Use

Open the Chat panel (`Ctrl+Alt+I` / `Cmd+Alt+I`) and mention `@dev`:

```
@dev <your request>
```

### Examples

```
@dev write unit tests for this TypeScript function
@dev generate a SQL migration script
@dev review my code for security vulnerabilities
@dev explain this Python algorithm
@dev create a REST API endpoint in Express
```

### What happens behind the scenes

```
Your prompt
    +
Universal repo context (file tree, manifests, tech stack, active editor, open tabs)
         │
         ▼
  BM25 search over awesome-copilot templates
         │
         ▼
  Best matching template (if score > 0)
         │
         ▼
  [INSTRUCTION MANUAL & BEST PRACTICES]   ← injected only when a match is found
  <matched template content>

  [WORKSPACE OVERVIEW & ARCHITECTURE]     ← universal layout, manifests & stack
  <file tree, tech stack, config files>

  [USER REQUEST]
  <your original prompt>
         │
         ▼
  Your selected model decides entrypoints/architecture and delivers precise code
```

> If no template matches well enough (BM25 score = 0), your request is forwarded to the model with complete repository context — you always get an answer.

---

## 🔧 Build from Source

### Prerequisites

```bash
node --version   # ≥ 18.x
npm --version    # ≥ 9.x
```

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/<your-username>/PromptMatcher.git
cd PromptMatcher

# 2. Install dependencies
npm install

# 3. Compile (bundles src/ → dist/extension.js)
npm run compile

# 4. Package as VSIX
npm run package
# Produces: dev-chat-agent-<version>.vsix

# 5. Install the VSIX in VS Code
#    Extensions → ··· → Install from VSIX…
```

### Development (watch mode)

```bash
npm run watch
# esbuild re-bundles on every file change
```

Then press **F5** in VS Code to open an Extension Development Host with the extension loaded.

---

## 📁 Project Structure

```
PromptMatcher/
├── src/
│   ├── extension.ts        # Entry point — activates chat participant, builds universal repo context
│   ├── promptFetcher.ts    # Downloads awesome-copilot templates from GitHub on first use
│   └── promptMatcher.ts    # BM25 index (fast-bm25) + findBestPrompt()
├── dist/                   # Compiled output (git-ignored)
├── package.json            # Extension manifest + build scripts
├── tsconfig.json           # TypeScript config
└── .gitignore
```

---

## ⚙️ How the BM25 Matching Works

### Template indexing (on activation)

Each `.md` file from `awesome-copilot` is parsed with `gray-matter` and indexed as a structured document:

| Field | Boost | Source | Purpose |
|---|---|---|---|
| `name` | ×3 | Front-matter `name` / `title` / filename | Highest priority for intent matching |
| `description` | ×2 | Front-matter `description` | High priority for summary matching |
| `tags` | ×2 | Front-matter `tags` | High priority for category keywords |
| `content` | ×1 | Markdown body | Base priority for body text search |

### Query construction (on each request)

The composite query fed to BM25 includes:

| Signal | Example |
|---|---|
| User prompt | `"write unit tests for this function"` |
| Tech stack & manifests | `techstack:.ts (40 files), .json manifest:package.json` |
| Active language | `language:typescript` |
| Active filename | `file:promptMatcher.ts` |
| Selected text | `selection:<up to 1500 chars>` |
| Cursor context | `context:<surrounding lines around cursor>` |
| Open tabs | `openfiles:extension.ts package.json ...` |
| Recent history | `history:<last 3 user messages>` |

---

## 🛠️ npm Scripts Reference

| Script | Command | Description |
|---|---|---|
| `compile` | `npm run compile` | One-shot bundle (`src/ → dist/`) |
| `watch` | `npm run watch` | Watch mode — rebuilds on file change |
| `package` | `npm run package` | Produce `.vsix` for distribution |
| `vscode:prepublish` | (auto) | Runs before `vsce publish` |

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make changes in `src/`
4. Run `npm run compile` to verify the build
5. Open a Pull Request

---

## 📄 License

MIT
