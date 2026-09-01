import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { BM25 } from 'fast-bm25';

/**
 * Internal metadata kept per prompt file so we can retrieve the raw
 * markdown content after BM25 returns a document index.
 */
export interface PromptRecord {
  filePath: string;
  content: string;
}

export class PromptMatcher {
  /** BM25 index — rebuilt on every initialize() call */
  private bm25: BM25 | null = null;

  /** Parallel array to bm25 documents — holds the actual file content */
  private records: PromptRecord[] = [];

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  public get documentCount(): number {
    return this.records.length;
  }

  public getRecords(): PromptRecord[] {
    return [...this.records];
  }

  /**
   * Scan `promptsDir` recursively, parse every .md file with gray-matter,
   * and build a BM25 index over the structured fields.
   * @returns number of documents successfully indexed.
   */
  public initialize(promptsDir: string): number {
    this.records = [];
    const docs: Array<Record<string, string>> = [];

    this.loadDirectory(promptsDir, docs);

    if (docs.length === 0) {
      this.bm25 = null;
      return 0;
    }

    this.bm25 = new BM25(docs, {
      // BM25 tuning params
      k1: 1.5,
      b: 0.75,
      minLength: 2,
      // Give name/description/tags more importance than raw body content
      fieldBoosts: {
        name: 3,
        description: 2,
        tags: 2,
        content: 1,
      },
    });

    return docs.length;
  }

  private loadDirectory(
    dir: string,
    docs: Array<Record<string, string>>
  ): void {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.loadDirectory(fullPath, docs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          let data: Record<string, any> = {};
          let content = raw;

          try {
            const parsed = matter(raw);
            data = parsed.data || {};
            content = parsed.content || raw;
          } catch {
            // If YAML frontmatter fails to parse, fallback to using raw content
            content = raw;
          }

          // Build structured document for BM25 field boosting
          // Fast-BM25 throws 'Input text cannot be null or empty' if any field value is empty.
          // Therefore, only include fields with non-empty trimmed strings.
          const docName = String(data.name || data.title || entry.name).trim();
          const doc: Record<string, string> = {
            name: docName || entry.name,
          };

          const desc = String(data.description || '').trim();
          if (desc) {
            doc.description = desc;
          }

          const rawTags = Array.isArray(data.tags)
            ? data.tags.join(' ')
            : String(data.tags || '');
          const tags = rawTags.trim();
          if (tags) {
            doc.tags = tags;
          }

          const cleanContent = (content || '').trim();
          if (cleanContent) {
            doc.content = cleanContent;
          } else {
            doc.content = doc.name;
          }

          docs.push(doc);
          this.records.push({ filePath: fullPath, content });
        } catch {
          // Skip unreadable files without failing the entire index load
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  /**
   * Find the single best matching prompt record given a composite query string.
   * Returns the matched PromptRecord (file path and content) for the highest-scoring
   * BM25 result (only when score > 0), or null if no match is found.
   */
  public findBestPromptRecord(compositeQuery: string): PromptRecord | null {
    if (!this.bm25 || this.records.length === 0) {
      return null;
    }

    const query = (compositeQuery || '').trim();
    if (!query) {
      return null;
    }

    try {
      const results = this.bm25.search(query, 1);

      if (results.length === 0 || results[0].score <= 0) {
        return null;
      }

      const best = results[0];
      return this.records[best.index] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Find the single best matching prompt given a composite query string.
   *
   * @param compositeQuery  Pre-built query that combines the user prompt with
   *                        repo context (active file language, open tab names,
   *                        selected code, etc.).  The caller is responsible for
   *                        assembling this string — see extension.ts.
   * @returns The raw markdown content of the best matching prompt file,
   *          or an empty string if no index has been built yet.
   */
  public findBestPrompt(compositeQuery: string): string {
    const record = this.findBestPromptRecord(compositeQuery);
    return record?.content ?? '';
  }

  /**
   * Return the top-N matching prompts (useful for debugging / multi-prompt injection).
   */
  public findTopPrompts(compositeQuery: string, topK = 3): PromptRecord[] {
    if (!this.bm25 || this.records.length === 0) {
      return [];
    }

    const query = (compositeQuery || '').trim();
    if (!query) {
      return [];
    }

    try {
      const results = this.bm25.search(query, topK);
      return results
        .filter((r) => r.score > 0)
        .map((r) => this.records[r.index])
        .filter(Boolean) as PromptRecord[];
    } catch {
      return [];
    }
  }
}
