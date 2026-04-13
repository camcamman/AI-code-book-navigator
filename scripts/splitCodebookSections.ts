// scripts/splitCodebookSections.ts

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type CodebookSplitConfig = {
  codebookId: string;
  codeSystemLabel: string;
  rawDir: string;
  outputDir: string;
  /**
   * Optional chapter detector.
   * If present, used to track the current chapter number/name.
   * Example (IRC):
   *   "CHAPTER 3 BUILDING PLANNING" -> chapter "3"
   */
  chapterRegex?: RegExp;
  /**
   * REQUIRED: section start detector.
   * Must match a single line that begins a new section.
   * The match data is passed to parseSection().
   */
  sectionRegex: RegExp;
  /**
   * Given a regex match for a section line, return:
   * - sectionId: e.g. "R302.2"
   * - sectionTitle: e.g. "Townhouse separation walls"
   */
  parseSection(match: RegExpMatchArray): {
    sectionId: string;
    sectionTitle: string | null;
  };
};

/**
 * CONFIG: add new codebooks here as you go.
 */
const codebookDir = path.resolve(
  __dirname,
  "..",
  "codebooks",
  "IRC-Utah-2021"
);

const CODEBOOK_CONFIGS: Record<string, CodebookSplitConfig> = {
  /**
   * IRC Utah 2021 – single big file:
   *   codebooks/IRC-Utah-2021/raw/<single .txt file>
   *
   * Sections look like:
   *   R302.2 Townhouse separation walls.
   *   R302.2.1 Something more specific.
   *
   * Chapters look like:
   *   CHAPTER 3 BUILDING PLANNING
  */
  "irc-utah-2021": {
    codebookId: "irc-utah-2021",
    codeSystemLabel: "IRC Utah 2021",
    rawDir: path.join(codebookDir, "raw"),
    outputDir: path.join(codebookDir, "raw", "sections"),
    chapterRegex: /^CHAPTER\s+(\d+)\b/i,
    sectionRegex: /^(R\d{3}(?:\.\d+)*)(?:\s+(.+))?$/,
    parseSection(match) {
      const sectionId = match[1]; // "R302.2"
      const titleRaw = match[2] || "";
      const sectionTitle = titleRaw.replace(/\s*\.$/, "").trim() || null;
      return { sectionId, sectionTitle };
    },
  },

  // EXAMPLE STUB: when you’re ready to add Utah state code, copy this and adapt:
  /*
  "utah-state-code": {
    codebookId: "utah-state-code",
    codeSystemLabel: "Utah Code",
    rawDir: path.resolve(__dirname, "..", "codebooks", "utah-state-code", "raw"),
    outputDir: path.resolve(
      __dirname,
      "..",
      "codebooks",
      "utah-state-code",
      "raw",
      "sections"
    ),
    chapterRegex: /^Chapter\s+([0-9A-Za-z-]+)/i,
    sectionRegex: /^(\d+-\d+[a-zA-Z]?(?:-\d+)*)(?:\.\s*(.+))?$/,
    parseSection(match) {
      const sectionId = match[1]; // "10-9a-101"
      const titleRaw = match[2] || "";
      const sectionTitle = titleRaw.replace(/\s*\.$/, "").trim() || null;
      return { sectionId, sectionTitle };
    },
  },
  */
};

function slugifyForFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function splitCodebook(config: CodebookSplitConfig) {
  const { codeSystemLabel, rawDir, outputDir, chapterRegex, sectionRegex } =
    config;

  if (!fs.existsSync(rawDir)) {
    throw new Error(`Raw directory not found at: ${rawDir}`);
  }

  ensureDir(outputDir);

  const entries = fs.readdirSync(rawDir, { withFileTypes: true });
  const txtFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"))
    .map((entry) => entry.name);
  const sectionTxtFiles = txtFiles.filter((name) =>
    name.toLowerCase().startsWith("section_")
  );
  const tableTxtFiles = txtFiles.filter((name) =>
    name.toLowerCase().startsWith("table_")
  );
  const inputFiles = sectionTxtFiles.length > 0 ? sectionTxtFiles : txtFiles;

  if (inputFiles.length === 0) {
    throw new Error(`No .txt files found in raw directory: ${rawDir}`);
  }

  let sectionCount = 0;
  let tableCount = 0;

  for (const inputFile of inputFiles) {
    const inputPath = path.resolve(rawDir, inputFile);
    const raw = fs.readFileSync(inputPath, "utf8");
    const lines = raw.split(/\r?\n/);

    let currentChapter: string | null = null;
    let currentSectionId: string | null = null;
    let currentSectionTitle: string | null = null;
    let currentSectionLines: string[] = [];

    function flushCurrentSection() {
      if (!currentSectionId || currentSectionLines.length === 0) {
        return;
      }

      const chapterLabel = currentChapter
        ? `Chapter ${currentChapter}`
        : "Chapter ?";

      const sectionTitle = currentSectionTitle || "(no title)";
      const header = `SECTION: ${codeSystemLabel} | ${chapterLabel} | Section ${currentSectionId} | ${sectionTitle}`;

      const fileBase = `${config.codebookId}-${currentSectionId}`;
      const titleSlug = slugifyForFilename(sectionTitle);
      const fileName = titleSlug
        ? `${fileBase}_${titleSlug}.txt`
        : `${fileBase}.txt`;

      const outPath = path.join(outputDir, fileName);
      const content = [header, ...currentSectionLines].join("\n");

      fs.writeFileSync(outPath, content, "utf8");
      sectionCount++;

      currentSectionId = null;
      currentSectionTitle = null;
      currentSectionLines = [];
    }

    for (const line of lines) {
      const trimmed = line.trim();

      // Track chapter headers if we have a chapter regex
      if (chapterRegex) {
        const chapMatch = trimmed.match(chapterRegex);
        if (chapMatch) {
          // For IRC, chapMatch[1] is like "3"
          currentChapter = chapMatch[1];
          continue;
        }
      }

      // Detect new section
      const secMatch = trimmed.match(sectionRegex);
      if (secMatch) {
        // New section: flush previous one
        flushCurrentSection();

        const { sectionId, sectionTitle } = config.parseSection(secMatch);
        currentSectionId = sectionId;
        currentSectionTitle = sectionTitle;
        currentSectionLines = [];

        // Include this header line itself in the section body
        currentSectionLines.push(line);
        continue;
      }

      // If inside a section, accumulate lines
      if (currentSectionId) {
        currentSectionLines.push(line);
      } else {
        // Lines before first section are ignored for now (preamble).
      }
    }

    // Flush last section
    flushCurrentSection();
  }

  function parseTableFile(raw: string) {
    const lines = raw.split(/\r?\n/);
    let tableId = "";
    let title = "";
    const columns: string[] = [];
    const rows: string[] = [];
    const footnotes: string[] = [];
    let mode: "title" | "columns" | "rows" | "footnotes" | null = null;
    let currentRow: string | null = null;

    function pushRow() {
      if (currentRow) {
        rows.push(currentRow.trim());
        currentRow = null;
      }
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("TABLE_ID:")) {
        pushRow();
        tableId = trimmed.slice("TABLE_ID:".length).trim();
        mode = null;
        continue;
      }
      if (trimmed.startsWith("TITLE:")) {
        pushRow();
        title = trimmed.slice("TITLE:".length).trim();
        mode = title ? null : "title";
        continue;
      }
      if (trimmed === "COLUMNS:") {
        pushRow();
        mode = "columns";
        continue;
      }
      if (trimmed === "ROWS:") {
        pushRow();
        mode = "rows";
        continue;
      }
      if (trimmed === "FOOTNOTES:") {
        pushRow();
        mode = "footnotes";
        continue;
      }

      if (mode === "title") {
        if (trimmed) {
          title = trimmed;
          mode = null;
        }
        continue;
      }

      if (trimmed.startsWith("- ")) {
        const value = trimmed.slice(2).trim();
        if (mode === "columns") {
          columns.push(value);
        } else if (mode === "rows") {
          pushRow();
          currentRow = value;
        } else if (mode === "footnotes") {
          footnotes.push(value);
        }
        continue;
      }

      if (mode === "rows" && trimmed) {
        currentRow = currentRow ? `${currentRow} ${trimmed}` : trimmed;
      }
    }

    pushRow();

    return { tableId, title, columns, rows, footnotes };
  }

  for (const inputFile of tableTxtFiles) {
    const inputPath = path.resolve(rawDir, inputFile);
    const raw = fs.readFileSync(inputPath, "utf8");
    const { tableId, title, columns, rows, footnotes } = parseTableFile(raw);

    if (!tableId) {
      continue;
    }

    const tableTitle = title || null;
    const headerTitle = tableTitle || `Table ${tableId}`;
    const header = `SECTION: ${codeSystemLabel} | Chapter ? | Section Table ${tableId} | ${headerTitle}`;

    const contentLines: string[] = [];
    contentLines.push(`TABLE ${tableId}${tableTitle ? ` — ${tableTitle}` : ""}`);
    if (columns.length > 0) {
      contentLines.push(`COLUMNS: ${columns.join(" | ")}`);
    }
    if (rows.length > 0) {
      contentLines.push("ROWS:");
      for (const row of rows) {
        contentLines.push(`- ${row}`);
      }
    }
    if (footnotes.length > 0) {
      contentLines.push("FOOTNOTES:");
      for (const note of footnotes) {
        contentLines.push(`- ${note}`);
      }
    }

    const fileBase = `${config.codebookId}-table-${tableId}`;
    const titleSlug = slugifyForFilename(tableTitle || "");
    const fileName = titleSlug
      ? `${fileBase}_${titleSlug}.txt`
      : `${fileBase}.txt`;

    const outPath = path.join(outputDir, fileName);
    const content = [header, ...contentLines].join("\n");

    fs.writeFileSync(outPath, content, "utf8");
    tableCount++;
  }

  console.log(
    `Done. Wrote ${sectionCount} section file(s) and ${tableCount} table file(s) to ${outputDir} from ${inputFiles.length} input file(s)`
  );
}

// ------------------------
// CLI entrypoint
// ------------------------

function main() {
  const codebookIdFromArg = process.argv[2];
  const codebookIdFromEnv = process.env.CODEBOOK_ID;
  const codebookId = codebookIdFromArg || codebookIdFromEnv;

  if (!codebookId) {
    const available = Object.keys(CODEBOOK_CONFIGS).join(", ");
    console.error(
      `Usage: ts-node scripts/splitCodebookSections.ts <codebookId>\n` +
        `Available codebookIds: ${available}`
    );
    process.exit(1);
  }

  const cfg = CODEBOOK_CONFIGS[codebookId];
  if (!cfg) {
    const available = Object.keys(CODEBOOK_CONFIGS).join(", ");
    console.error(
      `Unknown codebookId: ${codebookId}. Available: ${available}`
    );
    process.exit(1);
  }

  splitCodebook(cfg);
}

main();
