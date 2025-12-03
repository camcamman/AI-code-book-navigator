import OpenAI from "openai";
import "dotenv/config"

type RawChunk = {
  codebookId: string;
  filePath: string;
  content: string;
};

type CodeChunk = RawChunk & {
  id: string;
  embedding: number[];
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -------------------------------------
// 1. Example "code book" in memory
// -------------------------------------
const rawChunks: RawChunk[] = [
  {
    codebookId: "default",
    filePath: "src/middleware/auth.ts",
    content: `
export function authMiddleware(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // verify token and attach user to request
  try {
    const user = verifyJWT(token);
    (req as any).user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}
`,
  },
  {
    codebookId: "default",
    filePath: "src/routes/login.ts",
    content: `
import { Router } from "express";
import { createJWT } from "../auth/jwt";

const router = Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  // validate user against database
  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(user, password))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = createJWT(user);
  res.json({ token });
});

export default router;
`,
  },
  {
    codebookId: "default",
    filePath: "src/db/client.ts",
    content: `
import { Pool } from "pg";

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function query(text: string, params?: any[]) {
  return db.query(text, params);
}
`,
  },
];

// -------------------------------------
// 2. Embedding helper
// -------------------------------------
async function getEmbedding(text: string): Promise<number[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in the environment");
  }

  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error("Failed to get embedding from OpenAI response");
  }

  return embedding;
}

// -------------------------------------
// 3. Cosine similarity
// -------------------------------------
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

// -------------------------------------
// 4. Build codebook with embeddings
// -------------------------------------
async function buildCodebook(): Promise<CodeChunk[]> {
  const chunks: CodeChunk[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i];
    const embedding = await getEmbedding(raw.content);

    chunks.push({
      id: String(i),
      codebookId: raw.codebookId,
      filePath: raw.filePath,
      content: raw.content,
      embedding,
    });
  }

  return chunks;
}

// -------------------------------------
// 5. Search function
// -------------------------------------
async function searchCodebook(options: {
  query: string;
  codebookId: string;
  topK?: number;
}): Promise<CodeChunk[]> {
  const { query, codebookId, topK = 3 } = options;

  const allChunks = await buildCodebook();
  const candidateChunks = allChunks.filter(
    (chunk) => chunk.codebookId === codebookId
  );

  if (candidateChunks.length === 0) {
    return [];
  }

  const queryEmbedding = await getEmbedding(query);

  const scored = candidateChunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map((entry) => entry.chunk);
}

// -------------------------------------
// 6. Demo entrypoint
// -------------------------------------
async function main() {
  const query = "How does the auth middleware work?";

  console.log("Query:", query);
  console.log("Searching codebook...\n");

  const results = await searchCodebook({
    query,
    codebookId: "default",
    topK: 3,
  });

  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`Result ${i + 1}:`);
    console.log(`File: ${r.filePath}`);
    console.log("Snippet:");
    console.log(r.content.trim());
    console.log("------------------------------------------------------------\n");
  }
}

main().catch((err) => {
  console.error("Error in semantic search demo:", err);
  process.exit(1);
});