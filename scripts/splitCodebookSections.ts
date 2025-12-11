// scripts/splitCodebookSections.ts

import fs from "fs";
import path from "path";

type CodebookSplitConfig = {
  codebookId: string;
  codeSystemLabel: string;
  inputPath: string;
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
const CODEBOOK_CONFIGS: Record<string, CodebookSplitConfig> = {
  /**
   * IRC Utah 2021 – single big file:
   *   codebooks/IRC-Utah-2021/raw/IRC-Utah-Code-2021.txt
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
    inputPath: path.join(
      "codebooks",
      "IRC-Utah-2021",
      "raw",
      "IRC-Utah-Code-2021.txt"
    ),
    outputDir: path.join("codebooks", "IRC-Utah-2021", "raw", "sections"),
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
    inputPath: path.join("codebooks", "utah-state-code", "raw", "Utah-Code.txt"),
    outputDir: path.join("codebooks", "utah-state-code", "raw", "sections"),
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
  const { codeSystemLabel, inputPath, outputDir, chapterRegex, sectionRegex } =
    config;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  ensureDir(outputDir);

  const raw = fs.readFileSync(inputPath, "utf8");
  const lines = raw.split(/\r?\n/);

  let currentChapter: string | null = null;
  let currentSectionId: string | null = null;
  let currentSectionTitle: string | null = null;
  let currentSectionLines: string[] = [];
  let sectionCount = 0;

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

  console.log(
    `Done. Wrote ${sectionCount} section file(s) to ${outputDir} from ${inputPath}`
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
