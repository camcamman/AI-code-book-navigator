import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(
  __dirname,
  "..",
  "codebooks",
  "irc-utah-2021-amendments",
  "raw",
  "source"
);
const OUTPUT_DIR = path.resolve(
  __dirname,
  "..",
  "codebooks",
  "irc-utah-2021-amendments",
  "raw",
  "items"
);
const REPORT_PATH = path.resolve(
  __dirname,
  "..",
  "codebooks",
  "irc-utah-2021-amendments",
  "_extract_report.json"
);

type Args = {
  minItems: number;
  allowSuspicious: boolean;
  debug: boolean;
  limit: number | null;
  section: string | null;
};

type Item = {
  index: number;
  startLine: number;
  text: string;
  startLineText: string;
};

type ItemResult = {
  itemNumber: number;
  itemNumberFromSource: number | null;
  sectionId: string | null;
  opType: string;
  length: number;
  outputFile: string;
  suspicious: boolean;
  reasons: string[];
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    minItems: 20,
    allowSuspicious: false,
    debug: false,
    limit: null,
    section: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--min-items" && argv[i + 1]) {
      out.minItems = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith("--min-items=")) {
      out.minItems = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg === "--allow-suspicious") {
      out.allowSuspicious = true;
      continue;
    }
    if (arg === "--debug") {
      out.debug = true;
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      out.limit = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      out.limit = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg === "--section" && argv[i + 1]) {
      out.section = argv[++i];
      continue;
    }
    if (arg.startsWith("--section=")) {
      out.section = arg.split("=", 2)[1];
      continue;
    }
  }

  if (!Number.isFinite(out.minItems) || out.minItems < 0) {
    throw new Error(`Invalid --min-items value: ${out.minItems}`);
  }
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit <= 0)) {
    throw new Error(`Invalid --limit value: ${out.limit}`);
  }

  if (out.section) {
    out.section = normalizeSectionId(out.section);
  }

  return out;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n");
}

function normalizeSectionId(raw: string): string {
  let cleaned = raw.trim().replace(/[.,;:)\]]+$/, "");
  if (!cleaned) return cleaned;
  if (/^[0-9]/.test(cleaned)) {
    cleaned = `R${cleaned}`;
  }
  if (/^[a-z]/.test(cleaned)) {
    cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

function findSourceFile(dir: string): { filePath: string; size: number; ext: string; candidates: string[] } {
  if (!fs.existsSync(dir)) {
    throw new Error(`Source directory not found at: ${dir}`);
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.endsWith(".pdf") || lower.endsWith(".txt");
    });

  if (candidates.length === 0) {
    throw new Error(`No .pdf or .txt files found in source directory: ${dir}`);
  }

  const withSize = candidates.map((name) => {
    const fullPath = path.resolve(dir, name);
    const stat = fs.statSync(fullPath);
    return { name, fullPath, size: stat.size };
  });

  withSize.sort((a, b) => b.size - a.size);
  const chosen = withSize[0];

  if (withSize.length > 1) {
    console.log(
      `[extract] Multiple source files found. Using largest: ${chosen.name} (${chosen.size} bytes)`
    );
  }

  const ext = path.extname(chosen.name).toLowerCase();
  return {
    filePath: chosen.fullPath,
    size: chosen.size,
    ext,
    candidates: candidates.slice().sort(),
  };
}

function extractTextFromPdf(filePath: string): string {
  try {
    const stdout = execFileSync("pdftotext", ["-layout", filePath, "-"], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    const msg =
      err && typeof err.message === "string"
        ? err.message
        : "Unknown error while running pdftotext";
    throw new Error(
      `Failed to extract PDF text with pdftotext. Ensure it is installed (poppler-utils). Details: ${msg}`
    );
  }
}

function readSourceText(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".txt") {
    return fs.readFileSync(filePath, "utf8");
  }
  if (ext === ".pdf") {
    return extractTextFromPdf(filePath);
  }
  throw new Error(`Unsupported source file extension: ${ext}`);
}

function isItemStart(line: string): boolean {
  return (
    /^\s*\(\d+\)\s*In\s+IRC,\s+Section/i.test(line) ||
    /^\s*\d+\)\s*In\s+IRC,\s+Section/i.test(line) ||
    /^\s*\d+\.\s*In\s+IRC,\s+Section/i.test(line) ||
    /^\s*In\s+IRC,\s+Section/i.test(line)
  );
}

function splitIntoItems(text: string): Item[] {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));

  const items: Item[] = [];
  let current: string[] = [];
  let currentStartLine = 0;

  const pushCurrent = () => {
    while (current.length > 0 && current[current.length - 1].trim() === "") {
      current.pop();
    }
    if (current.length === 0) return;
    items.push({
      index: items.length,
      startLine: currentStartLine,
      text: current.join("\n"),
      startLineText: current[0],
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isItemStart(line)) {
      if (current.length > 0) {
        pushCurrent();
        current = [];
      }
      currentStartLine = i + 1;
      current.push(line);
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    pushCurrent();
  }

  return items;
}

function parseItemNumber(startLine: string, fallback: number): { value: number; fromSource: number | null } {
  const match = startLine.match(
    /^\s*\(?(\d+)\)?[.)]?\s*In\s+IRC,\s+Section/i
  );
  if (match && match[1]) {
    return { value: Number(match[1]), fromSource: Number(match[1]) };
  }
  return { value: fallback, fromSource: null };
}

function parseSectionId(text: string): string | null {
  const match = text.match(/Section\s+([A-Za-z]?\d+(?:\.\d+)*[A-Za-z]?)/i);
  if (!match || !match[1]) return null;
  const normalized = normalizeSectionId(match[1]);
  return normalized || null;
}

function classifyOpType(text: string): string {
  const lower = text.toLowerCase();
  if (
    lower.includes("definition for") &&
    lower.includes("modified by adding the words") &&
    lower.includes("after the word")
  ) {
    return "modify_definition_insert_after";
  }
  if (lower.includes("deleted and replaced") || lower.includes("amended to read as follows")) {
    return "replace_section";
  }
  if (lower.includes("sentence is added at the end")) {
    return "append_sentence";
  }
  if (lower.includes("new exception is added")) {
    return "add_exception";
  }
  if (lower.includes("definition is added")) {
    return "add_definition";
  }
  return "unknownop";
}

function buildOutputFilename(itemNumber: number, sectionId: string | null, opType: string): string {
  const numberPart = String(itemNumber).padStart(4, "0");
  const sectionPart = sectionId
    ? sectionId.replace(/[^A-Za-z0-9.]+/g, "-")
    : "UNKNOWN";
  const opPart = opType || "unknownop";
  return `${numberPart}_${sectionPart}_${opPart}.txt`;
}

function validateItem(
  text: string,
  sectionId: string | null,
  opType: string
): string[] {
  const reasons: string[] = [];
  if (text.length <= 120) {
    reasons.push("text_too_short");
  }
  if (!/In\s+IRC,\s+Section/i.test(text)) {
    reasons.push("missing_in_irc_section_phrase");
  }
  if (!sectionId) {
    reasons.push("missing_section_id");
  }
  if (opType === "replace_section" && sectionId) {
    const quotedBlocks = Array.from(text.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    if (quotedBlocks.length > 0) {
      const containsId = quotedBlocks.some((q) =>
        q.toUpperCase().includes(sectionId.toUpperCase())
      );
      if (!containsId) {
        reasons.push("section_id_not_in_quoted_block");
      }
    }
  }
  return reasons;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const { filePath, size, ext, candidates } = findSourceFile(SOURCE_DIR);
  if (candidates.length > 1) {
    console.log(`[extract] Source candidates: ${candidates.join(", ")}`);
  }

  console.log(`[extract] Using source file: ${filePath}`);
  console.log(`[extract] Source size: ${size} bytes`);
  console.log(`[extract] Source type: ${ext}`);

  const rawText = normalizeText(readSourceText(filePath));
  console.log(`[extract] Extracted text length: ${rawText.length} chars`);
  if (rawText.length < 200) {
    console.warn("[extract] WARNING: Extracted text length < 200 chars");
  }

  const items = splitIntoItems(rawText);
  console.log(`[extract] Items detected: ${items.length}`);

  if (items.length === 0) {
    throw new Error("No amendment items detected. Check input text formatting.");
  }

  ensureDir(OUTPUT_DIR);
  ensureDir(path.dirname(REPORT_PATH));

  const results: ItemResult[] = [];
  let written = 0;
  let suspiciousCount = 0;
  let skipped = 0;

  const limit = args.limit ?? Number.POSITIVE_INFINITY;
  const sectionFilter = args.section;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const fallbackNumber = i + 1;
    const numberInfo = parseItemNumber(item.startLineText, fallbackNumber);

    const sectionId = parseSectionId(item.text);
    if (sectionFilter && sectionId !== sectionFilter) {
      skipped++;
      continue;
    }

    if (written >= limit) {
      skipped++;
      continue;
    }

    const opType = classifyOpType(item.text);
    const cleanedText = item.text.replace(/[ \t]+$/gm, "").trim();

    if (cleanedText.length < 200) {
      console.warn(
        `[extract] WARNING: Item ${numberInfo.value} text length < 200 chars (len=${cleanedText.length})`
      );
    }

    const reasons = validateItem(cleanedText, sectionId, opType);
    const suspicious = reasons.length > 0;
    if (suspicious) {
      suspiciousCount++;
    }

    const outputFile = buildOutputFilename(numberInfo.value, sectionId, opType);
    const outPath = path.resolve(OUTPUT_DIR, outputFile);

    const header = `SECTION: IRC Utah Amendments 2021 | Item ${numberInfo.value} | Target ${
      sectionId ?? "UNKNOWN"
    } | Op ${opType}`;

    const outText = `${header}\n\n${cleanedText}\n`;
    fs.writeFileSync(outPath, outText, "utf8");
    written++;

    const result: ItemResult = {
      itemNumber: numberInfo.value,
      itemNumberFromSource: numberInfo.fromSource,
      sectionId,
      opType,
      length: cleanedText.length,
      outputFile,
      suspicious,
      reasons,
    };

    results.push(result);

    if (args.debug) {
      const preview = cleanedText.slice(0, 150).replace(/\s+/g, " ");
      console.log(
        `[item ${numberInfo.value}] section=${sectionId ?? "UNKNOWN"} op=${opType} len=${
          cleanedText.length
        } preview="${preview}"`
      );
    }
  }

  const report = {
    sourceFile: filePath,
    sourceSizeBytes: size,
    totalItemsDetected: items.length,
    minItemsRequired: args.minItems,
    written,
    suspiciousCount,
    skipped,
    results,
    suspicious: results.filter((r) => r.suspicious),
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(
    `[extract] Summary: attempted=${items.length}, written=${written}, suspicious=${suspiciousCount}, skipped=${skipped}`
  );
  console.log(`[extract] Report written to: ${REPORT_PATH}`);

  if (items.length < args.minItems) {
    console.error(
      `[extract] ERROR: Only ${items.length} items detected, below minimum ${args.minItems}`
    );
    process.exit(1);
  }

  if (suspiciousCount > 0 && !args.allowSuspicious) {
    console.error(
      `[extract] ERROR: ${suspiciousCount} suspicious items found (use --allow-suspicious to bypass)`
    );
    process.exit(1);
  }
}

try {
  main();
} catch (err: any) {
  const msg = err && err.message ? err.message : String(err);
  console.error(`[extract] FATAL: ${msg}`);
  process.exit(1);
}
