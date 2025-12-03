import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export type IndexedChunk = {
  id: string;
  codebookId: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding: number[];
};

// -----------------------------------------------
// Load an index file (e.g., ICC-Utah-Code-2021.index.json)
// -----------------------------------------------
export function loadCodebookIndex(codebookId: string): IndexedChunk[] {
  const indexFilename = `${codebookId}.index.json`;

  const indexPath = path.join(
    "codebooks",
    "raw",    // adjust if you put them somewhere else
    indexFilename
  );

  if (!fs.existsSync(indexPath)) {
    throw new Error(`Index file not found: ${indexPath}`);
  }

  const raw = fs.readFileSync(indexPath, "utf8");
  const allChunks = JSON.parse(raw) as IndexedChunk[];

  // Ensure only the selected codebook’s chunks are returned
  return allChunks.filter((c) => c.codebookId === codebookId);
}

// -----------------------------------------------
// Get embedding for the user query
// -----------------------------------------------
async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error("Failed to generate embedding");
  }

  return embedding;
}

// -----------------------------------------------
// Cosine similarity
// -----------------------------------------------
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embedding dimension mismatch");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];

    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// -----------------------------------------------
// Main search function
// -----------------------------------------------
export async function searchCodebook(options: {
  query: string;
  codebookId: string;
  topK?: number;
}): Promise<IndexedChunk[]> {
  const { query, codebookId, topK = 5 } = options;

  // 1. Load the embedded index
  const chunks = loadCodebookIndex(codebookId);
  if (chunks.length === 0) {
    throw new Error(`No chunks found for codebook: ${codebookId}`);
  }

  // 2. Embed the user question
  const queryEmbedding = await embedText(query);

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
