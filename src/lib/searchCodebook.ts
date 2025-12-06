// src/lib/searchCodebook.ts
import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Legacy names that should resolve to the new canonical codebook IDs
const CODEBOOK_ALIASES: Record<string, string> = {
  "icc-utah-2021": "irc-utah-2021",
};

// Explicit mappings from canonical codebook IDs to their index file paths
// relative to the /codebooks directory.
const CODEBOOK_INDEX_PATHS: Record<string, string> = {
  // Base IRC Utah 2021 index
  "irc-utah-2021": "IRC-Utah-2021/irc-utah-2021.index.json",
  // Utah amendments index
  "utah-amendments": "utah-amendments/utah-amendments.index.json",
  // Add more as you introduce new codebooks:
  // "some-other-id": "Some-Other-Codebook/some-other-id.index.json",
};

export type IndexedChunk = {
  id: string;
  codebookId: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding: number[];
  meta?: Record<string, any>;
};

type CodebookIndexCache = {
  [codebookId: string]: IndexedChunk[];
};

const indexCache: CodebookIndexCache = {};

/**
 * Resolve a user-provided codebookId to the canonical internal ID.
 * Handles aliases such as "icc-utah-2021" -> "irc-utah-2021".
 */
function resolveCodebookId(codebookId: string): string {
  const trimmed = (codebookId || "").trim();
  if (!trimmed) {
    throw new Error("Empty codebookId");
  }
  const lower = trimmed.toLowerCase();
  return CODEBOOK_ALIASES[lower] ?? lower;
}

/**
 * Load the index JSON for a given codebookId from disk.
 * Results are cached in memory.
 */
export function loadCodebookIndex(codebookId: string): IndexedChunk[] {
  const canonicalId = resolveCodebookId(codebookId);

  if (indexCache[canonicalId]) {
    return indexCache[canonicalId];
  }

  // If we have an explicit mapped path, use it; otherwise fall back
  // to "<canonicalId>.index.json" directly under /codebooks/<canonicalId>.
  const mappedRelPath = CODEBOOK_INDEX_PATHS[canonicalId];

  const indexPath = mappedRelPath
    ? path.join(process.cwd(), "codebooks", mappedRelPath)
    : path.join(
        process.cwd(),
        "codebooks",
        canonicalId,
        `${canonicalId}.index.json`,
      );

  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `Index file not found for codebook '${canonicalId}' at path: ${indexPath}`,
    );
  }

  const raw = fs.readFileSync(indexPath, "utf8");
  const parsed = JSON.parse(raw) as IndexedChunk[];

  indexCache[canonicalId] = parsed;
  return parsed;
}

/**
 * Embed text with OpenAI embeddings API.
 */
async function embedText(text: string): Promise<number[]> {
  const model =
    process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

  const res = await openai.embeddings.create({
    model,
    input: text,
  });

  const embedding = res.data[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("Failed to get embedding from OpenAI");
  }

  return embedding;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: a=${a.length}, b=${b.length}`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export type SearchCodebookParams = {
  query: string;
  codebookId: string;
  topK: number;
};

/**
 * Perform semantic search over a single codebook.
 *
 * 1. Load the codebook index (embedding vectors already computed offline).
 * 2. Embed the query.
 * 3. Compute cosine similarity between query and each chunk.
 * 4. Return the topK chunks sorted by similarity.
 */
export async function searchCodebook(
  params: SearchCodebookParams,
): Promise<IndexedChunk[]> {
  const { query, codebookId, topK } = params;

  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  const chunks = loadCodebookIndex(codebookId);
  if (!chunks || chunks.length === 0) return [];

  // 2. Embed the query
  const queryEmbedding = await embedText(trimmed);

  // 3. Compute similarities
  const scored = chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  // 4. Sort by similarity descending
  scored.sort((a, b) => b.score - a.score);

  // 5. Return top K
  return scored.slice(0, topK).map((entry) => entry.chunk);
}
