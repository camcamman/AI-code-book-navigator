/**
 * scripts/indexAllCodebooks.ts
 *
 * Generic indexer for all codebooks (base + amendments).
 * This is the main way to generate .index.json files for RAG.
 *
 * Run:
 *   npx tsx scripts/indexAllCodebooks.ts
 * Optional:
 *   npx tsx scripts/indexAllCodebooks.ts --codebook irc-utah-2021
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

type MetaValue = string | number | boolean | null;
type ChunkMeta = Record<string, MetaValue>;

type RawChunk = {
  codebookId: string;
  sourcePath: string;
  startLine: number; // 1-based
  endLine: number; // inclusive
  content: string;
  meta?: ChunkMeta;
  deterministicId?: string;
  chunkFileName?: string;
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

type SectionMeta = {
  codeSystem?: string;
  title?: string;
  chapter?: string;
  sectionId?: string;
  sectionTitle?: string;
  sectionLabel?: string;
};

type LineWithNumber = {
  lineNumber: number;
  text: string;
};

type ParsedInputFile = {
  sourcePath: string;
  contentLines: LineWithNumber[];
  page: number | null;
  sectionLabel?: string;
  caption?: string;
  fileMeta: ChunkMeta;
};

type CliArgs = {
  codebookId?: string;
};

/**
 * CONFIG: declare all codebooks you want to index here.
 */
const CODEBOOKS: CodebookConfig[] = [
  {
    id: "irc-utah-2021",
    kind: "base",
    rawType: "multi-file",
    rawDir: "codebooks/IRC-Utah-2021/raw",
    indexPath: "codebooks/IRC-Utah-2021/irc-utah-2021.index.json",
    maxCharsPerChunk: 3000,
  },
  {
    id: "utah-amendments",
    kind: "amendment",
    rawType: "multi-file",
    rawDir: path.join("codebooks", "utah-amendments", "raw"),
    indexPath: path.join(
      "codebooks",
      "utah-amendments",
      "utah-amendments.index.json"
    ),
    maxCharsPerChunk: 4000,
  },
  {
    id: "irc-utah-2021-amendments",
    kind: "amendment",
    rawType: "multi-file",
    rawDir: path.join("codebooks", "irc-utah-2021-amendments", "raw", "items"),
    indexPath: path.join(
      "codebooks",
      "irc-utah-2021-amendments",
      "irc-utah-2021-amendments.index.json"
    ),
    maxCharsPerChunk: 4000,
  },
];

const SECTION_BODY_LINE_RE = /^([A-Z]{1,3}\d{2,4}(?:\.\d+)*)\b(?:\s+(.+))?$/;
const TABLE_LINE_RE = /^TABLE\s+([A-Z0-9.()\-]+)\b\.?\s*(.*)$/i;

let openaiClient: OpenAI | null = null;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--codebook" && argv[i + 1]) {
      args.codebookId = argv[i + 1].trim().toLowerCase();
      i += 1;
    }
  }

  return args;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set in the environment");
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }

  return openaiClient;
}

function toPositiveIntOrNull(value: string): number | null {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function isLikelyHeading(line: string): boolean {
  const t = normalizeWhitespace(line);
  if (!t) return false;
  if (/^SECTION\b/i.test(t)) return true;
  if (TABLE_LINE_RE.test(t)) return true;
  if (SECTION_BODY_LINE_RE.test(t)) return true;
  return false;
}

function parseSectionHeader(headerLine: string): SectionMeta | null {
  const prefix = "SECTION:";
  if (!headerLine.startsWith(prefix)) return null;

  const parts = headerLine
    .slice(prefix.length)
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    return null;
  }

  const meta: SectionMeta = {
    codeSystem: parts[0],
  };

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];

    if (/^Title\b/i.test(p)) {
      meta.title = p;
    } else if (/^Chapter\b/i.test(p)) {
      meta.chapter = p;
    } else if (/^Section\b/i.test(p)) {
      meta.sectionId = p.replace(/^Section\s+/i, "").trim();
    } else if (!meta.sectionTitle) {
      meta.sectionTitle = p;
    }
  }

  if (meta.sectionId) {
    meta.sectionLabel = meta.sectionTitle
      ? `Section ${meta.sectionId} - ${meta.sectionTitle}`
      : `Section ${meta.sectionId}`;
  }

  return meta;
}

function sectionMetaToChunkMeta(meta: SectionMeta | null): ChunkMeta {
  const out: ChunkMeta = {};
  if (!meta) return out;
  if (meta.codeSystem) out.codeSystem = meta.codeSystem;
  if (meta.title) out.title = meta.title;
  if (meta.chapter) out.chapter = meta.chapter;
  if (meta.sectionId) out.sectionId = meta.sectionId;
  if (meta.sectionTitle) out.sectionTitle = meta.sectionTitle;
  if (meta.sectionLabel) out.sectionLabel = meta.sectionLabel;
  return out;
}

function buildUtahCodeSectionUrl(sectionId: string): string | null {
  const parts = sectionId.split("-");
  if (parts.length < 3) return null;

  const [title, chapter, ...rest] = parts;
  const tail = rest.join("-");
  const fileName = `${title}-${chapter}-S${tail}.html`;
  return `https://le.utah.gov/xcode/Title${title}/Chapter${chapter}/${fileName}`;
}

function parseAmendmentFilename(filename: string): ChunkMeta {
  const base = filename.replace(/\.(txt|json)$/i, "");
  const parts = base.split("_");

  const titlePart = parts.find((p) => p.startsWith("Title-"));
  const chapterPart = parts.find((p) => p.startsWith("Chapter-"));
  const sectionPart = parts.find((p) => p.startsWith("Section-"));

  if (!titlePart || !chapterPart || !sectionPart) {
    return {};
  }

  const titleNumber = titlePart.replace(/^Title-/, "");
  const chapterRaw = chapterPart.replace(/^Chapter-/, "");
  const chapterPieces = chapterRaw.split("-");
  const chapterNumber =
    chapterPieces.length < 2 ? chapterRaw : chapterPieces.slice(1).join("-");
  const sectionId = sectionPart.replace(/^Section-/, "");

  const meta: ChunkMeta = {
    title: titleNumber,
    chapter: `${titleNumber}-${chapterNumber}`,
    section: sectionId,
    sectionLabel: `Title ${titleNumber} Chapter ${chapterRaw} Section ${sectionId}`,
  };

  const publicUrl = buildUtahCodeSectionUrl(sectionId);
  if (publicUrl) {
    meta.publicUrl = publicUrl;
  }

  return meta;
}

function extractTextFromJson(value: unknown): string[] {
  const out: string[] = [];

  const visit = (node: unknown) => {
    if (typeof node === "string") {
      const t = normalizeWhitespace(node);
      if (t) out.push(t);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // avoid embedding vectors in accidental recursive extraction
        if (/^embedding$/i.test(k) || /^vector$/i.test(k)) continue;
        visit(v);
      }
    }
  };

  visit(value);
  return out;
}

function parseTextDocument(
  rawLines: string[]
): {
  contentLines: LineWithNumber[];
  page: number | null;
  sectionLabel?: string;
  caption?: string;
  headerMeta: ChunkMeta;
} {
  let page: number | null = null;
  let sectionIdFromHeader: string | null = null;
  let sectionLabel: string | undefined;
  let caption: string | undefined;
  let tableId: string | null = null;
  let tableTitle: string | null = null;
  const headerMeta: ChunkMeta = {};
  const contentLines: LineWithNumber[] = [];

  let inHeader = true;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (inHeader) {
      if (!trimmed) continue;

      const pageMatch = trimmed.match(/^PDF_PAGE:\s*(\d+)$/i);
      if (pageMatch) {
        page = toPositiveIntOrNull(pageMatch[1]);
        continue;
      }

      const sectionIdMatch = trimmed.match(/^SECTION_ID:\s*(.+)$/i);
      if (sectionIdMatch) {
        sectionIdFromHeader = normalizeWhitespace(sectionIdMatch[1]);
        headerMeta.sectionId = sectionIdFromHeader;
        continue;
      }

      const sectionMatch = trimmed.match(/^SECTION:\s*(.+)$/i);
      if (sectionMatch) {
        const parsed = parseSectionHeader(`SECTION: ${sectionMatch[1]}`);
        const mapped = sectionMetaToChunkMeta(parsed);
        for (const [k, v] of Object.entries(mapped)) {
          headerMeta[k] = v;
        }
        if (typeof mapped.sectionLabel === "string") {
          sectionLabel = mapped.sectionLabel;
        }
        if (!sectionIdFromHeader && typeof mapped.sectionId === "string") {
          sectionIdFromHeader = mapped.sectionId;
        }
        continue;
      }

      const captionMatch = trimmed.match(/^CAPTION:\s*(.+)$/i);
      if (captionMatch) {
        caption = normalizeWhitespace(captionMatch[1]);
        continue;
      }

      const tableIdMatch = trimmed.match(/^TABLE_ID:\s*(.+)$/i);
      if (tableIdMatch) {
        tableId = normalizeWhitespace(tableIdMatch[1]);
        headerMeta.tableId = tableId;
        continue;
      }

      const titleMatch = trimmed.match(/^TITLE:\s*(.*)$/i);
      if (titleMatch) {
        tableTitle = normalizeWhitespace(titleMatch[1] || "") || null;
        continue;
      }

      inHeader = false;
    }

    contentLines.push({
      lineNumber: i + 1,
      text: line.replace(/\s+$/, ""),
    });
  }

  if (!sectionLabel) {
    if (sectionIdFromHeader) {
      sectionLabel = `Section ${sectionIdFromHeader}`;
    } else {
      const firstBodyLine = contentLines.find(
        (line) => normalizeWhitespace(line.text).length > 0
      );
      if (firstBodyLine) {
        const first = normalizeWhitespace(firstBodyLine.text);
        const m = first.match(SECTION_BODY_LINE_RE);
        if (m) {
          const secId = m[1];
          const secTitle = normalizeWhitespace(m[2] || "");
          sectionLabel = secTitle
            ? `Section ${secId} - ${secTitle}`
            : `Section ${secId}`;
        }
      }
    }
  }

  if (!caption) {
    if (tableId) {
      if (tableTitle && tableTitle.startsWith("(")) {
        caption = `Table ${tableId}${tableTitle}`;
      } else {
        const titleSuffix = tableTitle ? ` ${tableTitle}` : "";
        caption = `Table ${tableId}${titleSuffix}`.trim();
      }
    }
  }

  if (tableId && !sectionLabel && caption) {
    sectionLabel = caption;
  }

  if (!caption) {
    const firstBodyLine = contentLines.find(
      (line) => normalizeWhitespace(line.text).length > 0
    );
    if (firstBodyLine) {
      const first = normalizeWhitespace(firstBodyLine.text);
      if (TABLE_LINE_RE.test(first)) {
        caption = first;
      }
    }
  }

  const finalContentLines =
    tableId && caption
      ? [{ lineNumber: 0, text: caption }, ...contentLines]
      : contentLines;

  return { contentLines: finalContentLines, page, sectionLabel, caption, headerMeta };
}

function parseInputFile(
  cfg: CodebookConfigMultiFile,
  sourcePath: string
): ParsedInputFile | null {
  const ext = path.extname(sourcePath).toLowerCase();
  const baseName = path.basename(sourcePath);

  let contentLines: LineWithNumber[] = [];
  let page: number | null = null;
  let sectionLabel: string | undefined;
  let caption: string | undefined;
  let headerMeta: ChunkMeta = {};

  if (ext === ".txt") {
    const rawText = fs.readFileSync(sourcePath, "utf8");
    const parsed = parseTextDocument(rawText.split(/\r?\n/));
    contentLines = parsed.contentLines;
    page = parsed.page;
    sectionLabel = parsed.sectionLabel;
    caption = parsed.caption;
    headerMeta = parsed.headerMeta;
  } else if (ext === ".json") {
    const raw = fs.readFileSync(sourcePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const strings = extractTextFromJson(parsed);
    contentLines = strings.map((text, idx) => ({
      lineNumber: idx + 1,
      text,
    }));

    if (typeof parsed.page === "number" && Number.isFinite(parsed.page)) {
      page = parsed.page > 0 ? parsed.page : null;
    } else if (typeof parsed.pdfPage === "number" && Number.isFinite(parsed.pdfPage)) {
      page = parsed.pdfPage > 0 ? parsed.pdfPage : null;
    }

    if (typeof parsed.sectionLabel === "string") {
      sectionLabel = normalizeWhitespace(parsed.sectionLabel);
    }
    if (typeof parsed.caption === "string") {
      caption = normalizeWhitespace(parsed.caption);
    }
  } else {
    return null;
  }

  const nonEmptyLineCount = contentLines.filter(
    (line) => normalizeWhitespace(line.text).length > 0
  ).length;
  if (nonEmptyLineCount === 0) {
    console.warn(
      `[WARN] Skipping ${sourcePath}: no valid content lines were found.`
    );
    return null;
  }

  const fileMeta: ChunkMeta = {
    filename: baseName,
  };

  for (const [k, v] of Object.entries(headerMeta)) {
    fileMeta[k] = v;
  }

  if (cfg.kind === "amendment") {
    const amendmentMeta = parseAmendmentFilename(baseName);
    for (const [k, v] of Object.entries(amendmentMeta)) {
      fileMeta[k] = v;
    }
  }

  if (page !== null) fileMeta.page = page;
  if (sectionLabel) fileMeta.sectionLabel = sectionLabel;
  if (caption) fileMeta.caption = caption;

  return {
    sourcePath,
    contentLines,
    page,
    sectionLabel,
    caption,
    fileMeta,
  };
}

function splitIntoLogicalUnits(lines: LineWithNumber[]): LineWithNumber[][] {
  const units: LineWithNumber[][] = [];
  let current: LineWithNumber[] = [];

  const flush = () => {
    if (current.length > 0) {
      units.push(current);
      current = [];
    }
  };

  for (const line of lines) {
    const clean = line.text.replace(/\s+$/, "");
    const t = normalizeWhitespace(clean);
    const blank = t.length === 0;
    const heading = isLikelyHeading(t);

    if (blank) {
      flush();
      continue;
    }

    if (heading && current.length > 0) {
      flush();
    }

    current.push({
      lineNumber: line.lineNumber,
      text: clean,
    });
  }

  flush();
  return units;
}

function chunkLogicalUnits(
  units: LineWithNumber[][],
  maxCharsPerChunk: number
): Array<{ startLine: number; endLine: number; content: string }> {
  const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];

  let currentUnits: LineWithNumber[][] = [];
  let currentChars = 0;

  const flush = () => {
    if (currentUnits.length === 0) return;

    const content = currentUnits
      .map((unit) => unit.map((line) => line.text).join("\n"))
      .join("\n\n")
      .trim();

    if (content) {
      const startLine = currentUnits[0][0].lineNumber;
      const lastUnit = currentUnits[currentUnits.length - 1];
      const endLine = lastUnit[lastUnit.length - 1].lineNumber;
      chunks.push({ startLine, endLine, content });
    }

    currentUnits = [];
    currentChars = 0;
  };

  const splitOversizedUnit = (unit: LineWithNumber[]): LineWithNumber[][] => {
    const out: LineWithNumber[][] = [];
    let current: LineWithNumber[] = [];
    let currentChars = 0;

    const flushCurrent = () => {
      if (current.length === 0) return;
      out.push(current);
      current = [];
      currentChars = 0;
    };

    const splitLongLine = (line: LineWithNumber): LineWithNumber[] => {
      if (line.text.length <= maxCharsPerChunk) {
        return [line];
      }

      const parts: LineWithNumber[] = [];
      let start = 0;
      while (start < line.text.length) {
        const slice = line.text.slice(start, start + maxCharsPerChunk);
        parts.push({
          lineNumber: line.lineNumber,
          text: slice,
        });
        start += maxCharsPerChunk;
      }
      return parts;
    };

    for (const line of unit) {
      const splitLines = splitLongLine(line);

      for (const splitLine of splitLines) {
        const lineLength = splitLine.text.length + 1;

        if (current.length > 0 && currentChars + lineLength > maxCharsPerChunk) {
          flushCurrent();
        }

        current.push(splitLine);
        currentChars += lineLength;

        if (currentChars >= maxCharsPerChunk) {
          flushCurrent();
        }
      }
    }

    flushCurrent();
    return out;
  };

  for (const unit of units) {
    const unitContent = unit.map((line) => line.text).join("\n");
    const unitLength = unitContent.length + 2;

    if (unitLength > maxCharsPerChunk) {
      flush();

      const splitUnits = splitOversizedUnit(unit);
      for (const splitUnit of splitUnits) {
        const splitContent = splitUnit.map((line) => line.text).join("\n");
        const splitLength = splitContent.length + 2;

        if (
          currentUnits.length > 0 &&
          currentChars + splitLength > maxCharsPerChunk
        ) {
          flush();
        }

        currentUnits.push(splitUnit);
        currentChars += splitLength;
        flush();
      }
      continue;
    }

    if (
      currentUnits.length > 0 &&
      currentChars + unitLength > maxCharsPerChunk
    ) {
      flush();
    }

    currentUnits.push(unit);
    currentChars += unitLength;
  }

  flush();
  return chunks;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function assignDeterministicChunkNames(
  cfg: CodebookConfig,
  chunks: RawChunk[]
): void {
  const pageCounters = new Map<number, number>();

  for (const chunk of chunks) {
    const rawPage = chunk.meta?.page;
    const page =
      typeof rawPage === "number" && Number.isFinite(rawPage) && rawPage > 0
        ? rawPage
        : 0;

    const sectionIndex = (pageCounters.get(page) || 0) + 1;
    pageCounters.set(page, sectionIndex);

    const fileName = `${cfg.id}_page${page}_section${sectionIndex}.json`;
    const id = fileName.replace(/\.json$/i, "");

    chunk.chunkFileName = fileName;
    chunk.deterministicId = id;
    chunk.meta = {
      ...(chunk.meta || {}),
      codebookId: cfg.id,
      page,
      sectionIndex,
      filename: fileName,
    };
  }
}

function writeChunkArtifacts(cfg: CodebookConfig, chunks: RawChunk[]): void {
  const indexDir = path.dirname(cfg.indexPath);
  const chunkDir = path.join(indexDir, `${cfg.id}.chunks`);
  ensureDir(chunkDir);

  const existing = fs.readdirSync(chunkDir);
  for (const name of existing) {
    if (
      (name.startsWith(`${cfg.id}_page`) && name.endsWith(".json")) ||
      name === `${cfg.id}.embedding-input.jsonl`
    ) {
      fs.unlinkSync(path.join(chunkDir, name));
    }
  }

  const jsonlLines: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const fileName = chunk.chunkFileName || `${cfg.id}_page0_section${i + 1}.json`;
    const id = chunk.deterministicId || fileName.replace(/\.json$/i, "");

    const sectionLabel =
      typeof chunk.meta?.sectionLabel === "string" ? chunk.meta.sectionLabel : null;
    const caption =
      typeof chunk.meta?.caption === "string" ? chunk.meta.caption : null;
    const page = typeof chunk.meta?.page === "number" ? chunk.meta.page : null;

    const artifact = {
      id,
      filename: fileName,
      codebookId: chunk.codebookId,
      sourcePath: chunk.sourcePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      sectionLabel,
      caption,
      page,
      content: chunk.content,
      meta: chunk.meta || {},
    };

    fs.writeFileSync(
      path.join(chunkDir, fileName),
      JSON.stringify(artifact, null, 2),
      "utf8"
    );

    jsonlLines.push(
      JSON.stringify({
        id,
        text: chunk.content,
        metadata: {
          codebookId: chunk.codebookId,
          filename: fileName,
          sourcePath: chunk.sourcePath,
          sectionLabel,
          caption,
          page,
        },
      })
    );
  }

  const jsonlPath = path.join(chunkDir, `${cfg.id}.embedding-input.jsonl`);
  fs.writeFileSync(
    jsonlPath,
    jsonlLines.join("\n") + (jsonlLines.length ? "\n" : ""),
    "utf8"
  );

  console.log(
    `Wrote ${chunks.length} chunk artifact(s) to ${chunkDir} and embedding input JSONL to ${jsonlPath}`
  );
}

/**
 * Embedding helper.
 */
async function getEmbedding(text: string): Promise<number[]> {
  const client = getOpenAIClient();
  const safeText = sanitizeEmbeddingInput(text);
  const response = await client.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    input: safeText,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error("No embedding returned from OpenAI");
  }

  return embedding;
}

function sanitizeEmbeddingInput(text: string): string {
  let safe = String(text ?? "");

  // Ensure the JS string is well-formed before JSON serialization.
  if (typeof (safe as any).toWellFormed === "function") {
    safe = (safe as any).toWellFormed();
  }

  // Remove disallowed control characters that are not meaningful for embeddings.
  safe = safe.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");

  // Normalize line endings and collapse impossible spacing bursts.
  safe = safe.replace(/\r\n?/g, "\n");
  safe = safe.replace(/[ \t]{2,}/g, " ");
  safe = safe.trim();

  // Force a JSON round-trip locally so we fail before the API if serialization is bad.
  safe = JSON.parse(JSON.stringify(safe));

  return safe;
}

/**
 * Chunk a single large text file.
 */
function chunkSingleFile(
  fullText: string,
  cfg: CodebookConfigSingleFile
): RawChunk[] {
  const lines = fullText.split(/\r?\n/).map((text, idx) => ({
    lineNumber: idx + 1,
    text,
  }));

  const units = splitIntoLogicalUnits(lines);
  const blocks = chunkLogicalUnits(units, cfg.maxCharsPerChunk);

  const chunks: RawChunk[] = blocks.map((block) => ({
    codebookId: cfg.id,
    sourcePath: cfg.rawPath,
    startLine: block.startLine,
    endLine: block.endLine,
    content: block.content,
    meta: {
      filename: path.basename(cfg.rawPath),
    },
  }));

  assignDeterministicChunkNames(cfg, chunks);
  return chunks;
}

/**
 * Chunk many source files in a directory.
 */
function chunkMultiFile(cfg: CodebookConfigMultiFile): RawChunk[] {
  if (!fs.existsSync(cfg.rawDir)) {
    console.warn(
      `[WARN] Raw directory missing for ${cfg.id}: ${cfg.rawDir}. Skipping this codebook.`
    );
    return [];
  }

  const dirEntries = fs.readdirSync(cfg.rawDir, { withFileTypes: true });
  const names = new Set(dirEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));

  const entries = dirEntries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      if (entry.name.startsWith("_")) return false;

      const lower = entry.name.toLowerCase();
      if (!lower.endsWith(".txt") && !lower.endsWith(".json")) return false;

      // Prefer text exports when both .txt and .json versions of the same artifact exist.
      if (lower.endsWith(".json")) {
        const txtName = entry.name.replace(/\.json$/i, ".txt");
        if (names.has(txtName)) return false;
      }

      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0) {
    console.warn(
      `[WARN] Raw directory appears incomplete for ${cfg.id}: ${cfg.rawDir} has no .txt/.json files.`
    );
    return [];
  }

  const chunks: RawChunk[] = [];
  let skippedFiles = 0;

  for (const entry of entries) {
    const fullPath = path.join(cfg.rawDir, entry.name);
    let parsed: ParsedInputFile | null = null;

    try {
      parsed = parseInputFile(cfg, fullPath);
    } catch (err) {
      skippedFiles += 1;
      console.warn(
        `[WARN] Skipping ${fullPath}: failed to parse source file (${String(err)}).`
      );
      continue;
    }

    if (!parsed) {
      skippedFiles += 1;
      continue;
    }

    const units = splitIntoLogicalUnits(parsed.contentLines);
    const blocks = chunkLogicalUnits(units, cfg.maxCharsPerChunk);

    if (blocks.length === 0) {
      skippedFiles += 1;
      console.warn(
        `[WARN] Skipping ${fullPath}: no logical chunks produced from content.`
      );
      continue;
    }

    for (const block of blocks) {
      const meta: ChunkMeta = {
        ...(parsed.fileMeta || {}),
      };
      if (parsed.page !== null) meta.page = parsed.page;
      if (parsed.sectionLabel) meta.sectionLabel = parsed.sectionLabel;
      if (parsed.caption) meta.caption = parsed.caption;

      chunks.push({
        codebookId: cfg.id,
        sourcePath: fullPath,
        startLine: block.startLine,
        endLine: block.endLine,
        content: block.content,
        meta,
      });
    }
  }

  if (chunks.length === 0) {
    console.warn(
      `[WARN] Raw directory appears incomplete for ${cfg.id}: no valid chunks produced from ${entries.length} file(s).`
    );
    return [];
  }

  if (skippedFiles > 0) {
    console.warn(
      `[WARN] ${cfg.id}: skipped ${skippedFiles} file(s) due to invalid or empty content.`
    );
  }

  assignDeterministicChunkNames(cfg, chunks);
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
      console.warn(
        `[WARN] Input file missing for ${cfg.id}: ${cfg.rawPath}. Skipping this codebook.`
      );
      return [];
    }
    const fullText = fs.readFileSync(cfg.rawPath, "utf8");
    rawChunks = chunkSingleFile(fullText, cfg);
  } else {
    rawChunks = chunkMultiFile(cfg);
  }

  if (rawChunks.length === 0) {
    console.warn(`[WARN] No chunks created for '${cfg.id}'.`);
    return [];
  }

  // Always write deterministic, embedding-friendly chunk artifacts.
  writeChunkArtifacts(cfg, rawChunks);

  // Ensure target directory exists.
  const indexDir = path.dirname(cfg.indexPath);
  ensureDir(indexDir);

  console.log(
    `Created ${rawChunks.length} chunks for codebook '${cfg.id}'. Embedding...`
  );

  const indexedChunks: IndexedChunk[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i];
    console.log(
      `  [${cfg.id}] Embedding chunk ${i + 1}/${rawChunks.length} (lines ${raw.startLine}-${raw.endLine})`
    );

    let embedding: number[];
    try {
      embedding = await getEmbedding(raw.content);
    } catch (error) {
      console.error(
        `[${cfg.id}] Embedding failed for source ${raw.sourcePath} lines ${raw.startLine}-${raw.endLine}`
      );
      console.error(
        `[${cfg.id}] Failing chunk preview: ${JSON.stringify(
          sanitizeEmbeddingInput(raw.content).slice(0, 500)
        )}`
      );
      throw error;
    }

    indexedChunks.push({
      id: raw.deterministicId || `${cfg.id}-${i}`,
      ...raw,
      embedding,
    });
  }

  console.log(`Writing index for '${cfg.id}' to: ${cfg.indexPath}`);
  fs.writeFileSync(cfg.indexPath, JSON.stringify(indexedChunks, null, 2), "utf8");

  return indexedChunks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const selectedCodebooks = args.codebookId
    ? CODEBOOKS.filter((cfg) => cfg.id.toLowerCase() === args.codebookId)
    : CODEBOOKS;

  if (selectedCodebooks.length === 0) {
    console.warn(
      `[WARN] Unknown codebook id '${args.codebookId}'. Nothing to index.`
    );
    return;
  }

  let indexedCodebookCount = 0;
  let totalChunkCount = 0;
  let hadFailure = false;

  for (const cfg of selectedCodebooks) {
    try {
      const indexed = await buildIndexForCodebook(cfg);
      if (indexed.length > 0) {
        indexedCodebookCount += 1;
        totalChunkCount += indexed.length;
      }
    } catch (err) {
      hadFailure = true;
      console.error(`\nError indexing codebook '${cfg.id}':`, err);
    }
  }

  if (indexedCodebookCount === 0) {
    console.warn(
      "\nNo codebooks were indexed. Check whether the source directory exists and contains parsed files."
    );
    return;
  }

  console.log(
    `\nIndexed ${indexedCodebookCount} codebook(s), ${totalChunkCount} total chunk(s).`
  );

  if (hadFailure) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\nFatal indexing error:", err);
  process.exit(1);
});
