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

  /**
   * Scan `promptsDir` recursively, parse every .md file with gray-matter,
   * and build a BM25 index over the structured fields.
   */
  public initialize(promptsDir: string): void {
    this.records = [];
    const docs: Array<{ name: string; description: string; tags: string; content: string }> = [];

    this.loadDirectory(promptsDir, docs);

    if (docs.length === 0) {
      this.bm25 = null;
      return;
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
  }

  private loadDirectory(
    dir: string,
    docs: Array<{ name: string; description: string; tags: string; content: string }>
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
        const raw = fs.readFileSync(fullPath, 'utf8');
        const { data, content } = matter(raw);

        // Build structured document for BM25 field boosting
        const doc = {
          name: String(data.name || data.title || entry.name),
          description: String(data.description || ''),
          tags: Array.isArray(data.tags)
            ? data.tags.join(' ')
            : String(data.tags || ''),
          content,
        };

        docs.push(doc);
        this.records.push({ filePath: fullPath, content });
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

    const results = this.bm25.search(compositeQuery, 1);

    if (results.length === 0 || results[0].score <= 0) {
      return null;
    }

    const best = results[0];
    return this.records[best.index] ?? null;
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

    const results = this.bm25.search(compositeQuery, topK);
    return results
      .filter((r) => r.score > 0)
      .map((r) => this.records[r.index])
      .filter(Boolean) as PromptRecord[];
  }
}
