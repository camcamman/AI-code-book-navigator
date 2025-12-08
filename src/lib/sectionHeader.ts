// src/lib/sectionHeader.ts

export type SectionMeta = {
  codeSystem?: string;   // "IRC Utah 2021", "Utah Code", "Utah Amendments"
  title?: string;        // "Title 10", "Title 3"
  chapter?: string;      // "Chapter 3", "Chapter 9a", "Chapter 3-1"
  sectionId?: string;    // "R302.2", "10-9a-101", "3-1-1.1"
  sectionTitle?: string; // "Townhouse separation walls", "General provisions"
  sectionLabel?: string; // "Section R302.2 – Townhouse separation walls"
};

/**
 * Parse a SECTION header line of the form:
 *
 * SECTION: IRC Utah 2021 | Chapter 3 | Section R302.2 | Townhouse separation walls
 * SECTION: Utah Code | Title 10 | Chapter 9a | Section 10-9a-101 | General provisions
 * SECTION: Utah Amendments | Title 3 | Chapter 3-1 | Section 3-1-1.1 | ...
 */
export function parseSectionHeader(headerLine: string): SectionMeta | null {
  const prefix = "SECTION:";
  if (!headerLine.startsWith(prefix)) return null;

  const parts = headerLine
    .slice(prefix.length)
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  const meta: SectionMeta = {};

  // parts[0] = code system / label ("IRC Utah 2021", "Utah Code", etc.)
  meta.codeSystem = parts[0];

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];

    if (/^Title\b/i.test(p)) {
      meta.title = p; // "Title 10"
    } else if (/^Chapter\b/i.test(p)) {
      meta.chapter = p; // "Chapter 3-1"
    } else if (/^Section\b/i.test(p)) {
      meta.sectionId = p.replace(/^Section\s+/i, "").trim(); // "R302.2", "10-9a-101"
    } else {
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
 * Takes an entire file's text.
 * If first line is a SECTION header, returns { meta, contentLines, headerLinesCount }.
 * Otherwise, returns meta = null, contentLines = all lines, headerLinesCount = 0.
 */
export function extractHeaderAndContent(
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
