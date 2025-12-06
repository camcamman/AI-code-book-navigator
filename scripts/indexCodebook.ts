import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CODEBOOK_ID = "irc-utah-2021";
const INPUT_TXT_PATH = path.join("codebooks", "raw", "IRC-Utah-Code-2021.txt");
const OUTPUT_INDEX_PATH = path.join(
  "codebooks",
  `${CODEBOOK_ID}.index.json`
);

console.log(CODEBOOK_ID)
console.log(OUTPUT_INDEX_PATH)

// Roughly ~500–800 tokens per chunk depending on text density.
const MAX_CHARS_PER_CHUNK = 2000;

type RawChunk = {
  codebookId: string;
  sourcePath: string;
  startLine: number; // 1-based
  endLine: number;   // inclusive
  content: string;
};

type IndexedChunk = RawChunk & {
  id: string;
  embedding: number[];
};

async function getEmbedding(text: string): Promise<number[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  // You can switch to text-embedding-3-large later if you want higher quality.
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error("No embedding returned from OpenAI");
  }

  return embedding;
}

function chunkTextFile(
  fullText: string,
  codebookId: string,
  sourcePath: string
): RawChunk[] {
  const lines = fullText.split(/\r?\n/);
  const chunks: RawChunk[] = [];

  let currentLines: string[] = [];
  let currentCharCount = 0;
  let chunkStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLength = line.length + 1; // +1 for newline
    const lineNumber = i + 1;

    if (
      currentLines.length > 0 &&
      currentCharCount + lineLength > MAX_CHARS_PER_CHUNK
    ) {
      const content = currentLines.join("\n");
      chunks.push({
        codebookId,
        sourcePath,
        startLine: chunkStartLine,
        endLine: lineNumber - 1,
        content,
      });

      // reset for new chunk
      currentLines = [];
      currentCharCount = 0;
      chunkStartLine = lineNumber;
    }

    currentLines.push(line);
    currentCharCount += lineLength;
  }

  // flush last chunk
  if (currentLines.length > 0) {
    const content = currentLines.join("\n");
    chunks.push({
      codebookId,
      sourcePath,
      startLine: chunkStartLine,
      endLine: lines.length,
      content,
    });
  }

  return chunks;
}

async function buildIndex(): Promise<IndexedChunk[]> {
  if (!fs.existsSync(INPUT_TXT_PATH)) {
    throw new Error(`Input file not found: ${INPUT_TXT_PATH}`);
  }

  console.log(`Reading source text from: ${INPUT_TXT_PATH}`);
  const fullText = fs.readFileSync(INPUT_TXT_PATH, "utf8");

  console.log("Chunking text...");
  const rawChunks = chunkTextFile(fullText, CODEBOOK_ID, INPUT_TXT_PATH);
  console.log(`Created ${rawChunks.length} chunks`);

  const indexedChunks: IndexedChunk[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i];
    console.log(
      `Embedding chunk ${i + 1}/${rawChunks.length} (lines ${raw.startLine}-${raw.endLine})`
    );

    const embedding = await getEmbedding(raw.content);

    indexedChunks.push({
      id: `${CODEBOOK_ID}-${i}`,
      ...raw,
      embedding,
    });
  }

  return indexedChunks;
}

async function main() {
  try {
    const index = await buildIndex();

    console.log(`Writing index to: ${OUTPUT_INDEX_PATH}`);
    fs.writeFileSync(
      OUTPUT_INDEX_PATH,
      JSON.stringify(index, null, 2),
      "utf8"
    );
    console.log("Done.");
  } catch (err) {
    console.error("Error building index:", err);
    process.exit(1);
  }
}

main();
