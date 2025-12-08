/**
 * scripts/indexAllCodebooks.ts
 *
 * Generic indexer for all codebooks (base + amendments).
 * This effectively replaces the need for a single-purpose indexCodebook.ts.
 * You can keep indexCodebook.ts around if you want, but this file is meant
 * to be the main way you generate all .index.json files going forward.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is not set in the environment");
}

type RawChunk = {
  codebookId: string;
  sourcePath: string;
  startLine: number; // 1-based
  endLine: number; // inclusive
  content: string;
  // Optional metadata (used for amendments, etc.)
  meta?: Record<string, string | number | boolean | null>;
};

type IndexedChunk = RawChunk & {
  id: string;
  embedding: number[];
};

type CodebookConfigSingleFile = {
  id: string;
  kind: "base" | "amendment" | "other";
  rawType: "single-file";
  rawPath: string;
  indexPath: string;
  maxCharsPerChunk: number;
};

type CodebookConfigMultiFile = {
  id: string;
  kind: "base" | "amendment" | "other";
  rawType: "multi-file";
  rawDir: string;
  indexPath: string;
  maxCharsPerChunk: number;
};

type CodebookConfig = CodebookConfigSingleFile | CodebookConfigMultiFile;

/**
 * CONFIG: declare all codebooks you want to index here.
 * Adjust paths to match your actual folder layout.
 */
// const CODEBOOKS: CodebookConfig[] = [
//   {
//     id: "irc-utah-2021",
//     kind: "base",
//     rawType: "single-file",
//     rawPath: "codebooks/test/raw/IRC-Utah-Code-2021_test.txt",
//     indexPath: "codebooks/test/output/IRC-utah-2021-test.index.json",
//     maxCharsPerChunk: 2000,
//   },
// ];

const CODEBOOKS: CodebookConfig[] = [
  {
  id: "irc-utah-2021",
  kind: "base",
  rawType: "single-file",
  rawPath: "codebooks/IRC-Utah-2021/raw/IRC-Utah-Code-2021.txt",
  indexPath: "codebooks/IRC-Utah-2021/irc-utah-2021.index.json",
  maxCharsPerChunk: 2000,
},

  {
    id: "utah-amendments",
    kind: "amendment",
    rawType: "multi-file",
    // Put all amendment .txt files into this directory:
    // codebooks/utah-amendments/raw/*.txt
    rawDir: path.join("codebooks", "utah-amendments", "raw"),
    indexPath: path.join(
      "codebooks",
      "utah-amendments",
      "utah-amendments.index.json"
    ),
    // Most amendment files are small; one chunk per file is fine.
    // We still allow splitting if some files are huge.
    maxCharsPerChunk: 4000,
  },
];

type SectionMeta = {
  codeSystem?: string;   // e.g. "IRC Utah 2021", "Utah Code", "Utah Amendments"
  title?: string;        // e.g. "Title 10"
  chapter?: string;      // e.g. "Chapter 3", "Chapter 9a", "Chapter 3-1"
  sectionId?: string;    // e.g. "R302.2", "10-9a-101", "3-1-1.1"
  sectionTitle?: string; // e.g. "Townhouse separation walls"
  sectionLabel?: string; // e.g. "Section R302.2 – Townhouse separation walls"
};

/**
 * Parse a SECTION header line of the form:
 *
 * SECTION: IRC Utah 2021 | Chapter 3 | Section R302.2 | Townhouse separation walls
 * SECTION: Utah Code | Title 10 | Chapter 9a | Section 10-9a-101 | General provisions
 * SECTION: Utah Amendments | Title 3 | Chapter 3-1 | Section 3-1-1.1 | ...
 */
/**
 * Takes an entire file's text.
 * If first line is a SECTION header, returns { meta, contentLines, headerLinesCount }.
 * Otherwise, returns meta = null, contentLines = all lines, headerLinesCount = 0.
 */
function extractHeaderAndContent(
  fileText: string
): { meta: SectionMeta | null; contentLines: string[]; headerLinesCount: number } {
  const lines = fileText.split(/\r?\n/);
  if (lines.length === 0) {
    return { meta: null, contentLines: [], headerLinesCount: 0 };
  }

  const first = lines[0];
  if (!first.startsWith("SECTION:")) {
    return { meta: null, contentLines: lines, headerLinesCount: 0 };
  }

  const meta = parseSectionHeader(first);
  const contentLines = lines.slice(1); // skip header line for content

  return { meta, contentLines, headerLinesCount: 1 };
}

// ---- END SECTION HEADER PARSING ----

function parseSectionHeader(headerLine: string): SectionMeta | null {
  const prefix = "SECTION:";
  if (!headerLine.startsWith(prefix)) return null;

  // Remove "SECTION:" and split on "|"
  const parts = headerLine
    .slice(prefix.length)
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    // Not enough structure to be useful
    return null;
  }

  const meta: SectionMeta = {};

  // parts[0] = code system/label ("IRC Utah 2021", "Utah Code", etc.)
  meta.codeSystem = parts[0];

  // parts[1] = something like "Chapter 3" or "Title 10" or "Title 10" for Utah Code
  // parts[2] = something like "Section R302.2" or "Section 10-9a-101"
  // parts[3] = optional title ("Townhouse separation walls")

  // Handle simple patterns: "Title 10" / "Chapter 3" / "Chapter 9a" / "Title 3"
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];

    if (/^Title\b/i.test(p)) {
      meta.title = p; // keep full string "Title 10"
    } else if (/^Chapter\b/i.test(p)) {
      meta.chapter = p; // "Chapter 3-1"
    } else if (/^Section\b/i.test(p)) {
      meta.sectionId = p.replace(/^Section\s+/i, "").trim(); // "R302.2", "10-9a-101"
    } else {
      // Likely the section title / description
      if (!meta.sectionTitle) {
        meta.sectionTitle = p;
      }
    }
  }

  if (meta.sectionId) {
    if (meta.sectionTitle) {
      meta.sectionLabel = `Section ${meta.sectionId} – ${meta.sectionTitle}`;
    } else {
      meta.sectionLabel = `Section ${meta.sectionId}`;
    }
  }

  return meta;
}


/**
 * Embedding helper.
 */
async function getEmbedding(text: string): Promise<number[]> {
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

/**
 * Chunk a single large text file (base codebooks).
 * Splits by line, groups into chunks by maxCharsPerChunk.
 */
function chunkSingleFile(
  fullText: string,
  cfg: CodebookConfigSingleFile
): RawChunk[] {
  const { meta: headerMeta, contentLines, headerLinesCount } =
    extractHeaderAndContent(fullText);

  const lines = contentLines;
  const chunks: RawChunk[] = [];

  let currentLines: string[] = [];
  let currentCharCount = 0;
  // First content line is after the header, if present
  let chunkStartLine = headerLinesCount + 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLength = line.length + 1; // +1 for newline
    const lineNumber = headerLinesCount + i + 1; // adjust for header

    if (
      currentLines.length > 0 &&
      currentCharCount + lineLength > cfg.maxCharsPerChunk
    ) {
      const content = currentLines.join("\n");
      chunks.push({
        codebookId: cfg.id,
        sourcePath: cfg.rawPath,
        startLine: chunkStartLine,
        endLine: lineNumber - 1,
        content,
        meta: headerMeta || undefined,
      });

      currentLines = [];
      currentCharCount = 0;
      chunkStartLine = lineNumber;
    }

    currentLines.push(line);
    currentCharCount += lineLength;
  }

  if (currentLines.length > 0) {
    const content = currentLines.join("\n");
    chunks.push({
      codebookId: cfg.id,
      sourcePath: cfg.rawPath,
      startLine: chunkStartLine,
      endLine: headerLinesCount + lines.length,
      content,
      meta: headerMeta || undefined,
    });
  }

  return chunks;
}

/**
 * Parse Title/Chapter/Section from an amendment filename like:
 * "Title-3_Chapter-3-1_Section-3-1-1.1.txt"
 * This is optional metadata; we don't rely on it for search,
 * but it's useful for debugging and display.
 */
function parseAmendmentFilename(filename: string): Record<string, string> {
  const base = filename.replace(/\.txt$/i, "");
  const parts = base.split("_");

  const meta: Record<string, string> = {};
  for (const part of parts) {
    const [key, value] = part.split("-");
    if (!key || value === undefined) continue;

    const normalizedKey = key.toLowerCase(); // "title", "chapter", "section"
    meta[normalizedKey] = value;
  }

  return meta;
}

/**
 * Chunk many small text files in a directory (amendments).
 * Each file is treated as one or more chunks depending on size.
 */
function chunkMultiFile(
  cfg: CodebookConfigMultiFile
): RawChunk[] {
  if (!fs.existsSync(cfg.rawDir)) {
    throw new Error(`Raw directory not found for ${cfg.id}: ${cfg.rawDir}`);
  }

  const entries = fs.readdirSync(cfg.rawDir, { withFileTypes: true });
  const chunks: RawChunk[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".txt")) continue;

    const fullPath = path.join(cfg.rawDir, entry.name);
    const fullText = fs.readFileSync(fullPath, "utf8");

    // 1) Extract SECTION header (if present)
    const { meta: headerMeta, contentLines, headerLinesCount } =
      extractHeaderAndContent(fullText);

    const lines = contentLines;

    // 2) Metadata from filename (used for amendments, etc.)
    const fileMeta =
      cfg.kind === "amendment" ? parseAmendmentFilename(entry.name) : {};

    const combinedMeta = {
      ...(headerMeta || {}),
      ...(fileMeta || {}),
    };

    let currentLines: string[] = [];
    let currentCharCount = 0;
    let chunkStartLine = headerLinesCount + 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLength = line.length + 1;
      const lineNumber = headerLinesCount + i + 1;

      if (
        currentLines.length > 0 &&
        currentCharCount + lineLength > cfg.maxCharsPerChunk
      ) {
        const content = currentLines.join("\n");
        chunks.push({
          codebookId: cfg.id,
          sourcePath: fullPath,
          startLine: chunkStartLine,
          endLine: lineNumber - 1,
          content,
          meta: combinedMeta,
        });

        currentLines = [];
        currentCharCount = 0;
        chunkStartLine = lineNumber;
      }

      currentLines.push(line);
      currentCharCount += lineLength;
    }

    if (currentLines.length > 0) {
      const content = currentLines.join("\n");
      chunks.push({
        codebookId: cfg.id,
        sourcePath: fullPath,
        startLine: chunkStartLine,
        endLine: headerLinesCount + lines.length,
        content,
        meta: combinedMeta,
      });
    }
  }

  return chunks;
}

/**
 * Build index for a single codebook config.
 */
async function buildIndexForCodebook(cfg: CodebookConfig): Promise<IndexedChunk[]> {
  console.log(`\n=== Indexing codebook: ${cfg.id} (${cfg.rawType}) ===`);

  let rawChunks: RawChunk[] = [];

  if (cfg.rawType === "single-file") {
    if (!fs.existsSync(cfg.rawPath)) {
      throw new Error(`Input file not found for ${cfg.id}: ${cfg.rawPath}`);
    }
    console.log(`Reading source text from: ${cfg.rawPath}`);
    const fullText = fs.readFileSync(cfg.rawPath, "utf8");
    rawChunks = chunkSingleFile(fullText, cfg);
  } else {
    rawChunks = chunkMultiFile(cfg);
  }

  console.log(
    `Created ${rawChunks.length} chunks for codebook '${cfg.id}'. Embedding...`
  );

  const indexedChunks: IndexedChunk[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i];
    console.log(
      `  [${cfg.id}] Embedding chunk ${i + 1}/${rawChunks.length} (lines ${raw.startLine}-${raw.endLine})`
    );

    const embedding = await getEmbedding(raw.content);

    indexedChunks.push({
      id: `${cfg.id}-${i}`,
      ...raw,
      embedding,
    });
  }

  // Ensure target directory exists
  const indexDir = path.dirname(cfg.indexPath);
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true });
  }

  console.log(`Writing index for '${cfg.id}' to: ${cfg.indexPath}`);
  fs.writeFileSync(cfg.indexPath, JSON.stringify(indexedChunks, null, 2), "utf8");

  return indexedChunks;
}

/**
 * Main: index all configured codebooks.
 */
async function main() {
  try {
    for (const cfg of CODEBOOKS) {
      await buildIndexForCodebook(cfg);
    }

    console.log("\nAll codebooks indexed successfully.");
  } catch (err) {
    console.error("\nError indexing codebooks:", err);
    process.exit(1);
  }
}

main();
