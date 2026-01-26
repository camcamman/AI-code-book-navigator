// src/lib/amendmentLinking.ts

import { IndexedChunk, loadCodebookIndex } from "./searchCodebook";

/**
 * Structured reference extracted from a user query.
 * All fields are optional; we match on whatever is present.
 */
export type CodeStructureRef = {
  title?: string;
  chapter?: string;
  section?: string;
};

export type AmendmentAction = "delete" | "replace" | "add" | "modify" | "unknown";

export type AmendmentInfo = {
  action: AmendmentAction;
  targetSectionId: string | null;
};

/**
 * Normalize a string for comparison:
 * - to string
 * - trim
 * - strip trailing punctuation and whitespace
 * - lower-case
 */
function normalize(val: unknown): string {
  return String(val ?? "")
    .trim()
    // strip trailing punctuation that often appears in headings, like "3-1-1.1."
    .replace(/[.:;,\s]+$/, "")
    .toLowerCase();
}

export function normalizeIrcSectionId(raw: string): string | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[)\].,:;]+$/, "");
  if (/^[0-9]/.test(cleaned)) {
    return `R${cleaned}`;
  }
  if (/^[a-z]/.test(cleaned)) {
    return cleaned[0].toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

function extractTargetSectionIdFromText(text: string): string | null {
  const match = text.match(/Section\s+([A-Za-z]?\d+(?:\.\d+)*[A-Za-z]?)/i);
  if (!match || !match[1]) return null;
  return normalizeIrcSectionId(match[1]);
}

function extractTargetSectionIdFromPath(sourcePath: string): string | null {
  const base = String(sourcePath || "").split(/[\\/]/).pop() || "";
  const parts = base.split("_");
  for (const part of parts) {
    const cleaned = part.replace(/\.txt$/i, "");
    if (/^[A-Za-z]?\d+(?:\.\d+)*[A-Za-z]?$/.test(cleaned)) {
      return normalizeIrcSectionId(cleaned);
    }
  }
  return null;
}

function mapOpToAction(op: string): AmendmentAction {
  const lower = String(op || "").toLowerCase();
  if (lower.includes("replace")) return "replace";
  if (lower.includes("delete")) return "delete";
  if (lower.includes("add")) return "add";
  if (lower.includes("modify")) return "modify";
  return "unknown";
}

export function classifyAmendmentAction(text: string): AmendmentAction {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("deleted and replaced") || lower.includes("amended to read as follows")) {
    return "replace";
  }
  if (lower.includes("is deleted")) {
    return "delete";
  }
  if (lower.includes("is added") || lower.includes("new exception is added")) {
    return "add";
  }
  if (lower.includes("is modified") || lower.includes("modified by adding")) {
    return "modify";
  }
  return "unknown";
}

export function getAmendmentInfo(chunk: IndexedChunk): AmendmentInfo {
  const meta = (chunk as any).meta ?? {};
  const metaTarget = meta.targetSectionId ?? meta.sectionId ?? null;
  const targetFromMeta = metaTarget ? normalizeIrcSectionId(String(metaTarget)) : null;
  const targetFromPath = extractTargetSectionIdFromPath(chunk.sourcePath);
  const targetFromText = extractTargetSectionIdFromText(chunk.content || "");
  const targetSectionId = targetFromMeta || targetFromPath || targetFromText;

  let action: AmendmentAction = "unknown";
  if (typeof meta.amendmentAction === "string" && meta.amendmentAction.trim()) {
    action = mapOpToAction(meta.amendmentAction);
  }
  if (action === "unknown") {
    action = classifyAmendmentAction(chunk.content || "");
  }

  if (meta && typeof meta === "object") {
    meta.amendment = { action, targetSectionId };
  }

  return { action, targetSectionId };
}

export function collectAmendmentExclusions(chunks: IndexedChunk[]): {
  excludedSectionIds: Set<string>;
  failClosedNoBase: boolean;
} {
  const excludedSectionIds = new Set<string>();
  let failClosedNoBase = false;

  for (const chunk of chunks) {
    const info = getAmendmentInfo(chunk);
    if (info.action === "delete" || info.action === "replace") {
      if (!info.targetSectionId) {
        failClosedNoBase = true;
      } else {
        excludedSectionIds.add(info.targetSectionId);
      }
    }
  }

  return { excludedSectionIds, failClosedNoBase };
}

/**
 * Extract Title / Chapter / Section references from a natural-language query.
 *
 * Handles patterns like:
 *   "Title 3 Chapter 3-1 Section 3-1-1.1"
 *   "Section 3-1-1.1"
 *   "Sec. 3-1-1.1"
 *   "§ 3-1-1.1"
 *
 * Returns an object with any of { title, chapter, section } that were found.
 * If nothing is detected, returns null.
 */
export function extractStructureFromQuery(
  query: string
): CodeStructureRef | null {
  const text = query || "";
  const lower = text.toLowerCase();

  const result: CodeStructureRef = {};

  // Title N
  const titleMatch = lower.match(/\btitle\s+([0-9a-z\-\.]+)/i);
  if (titleMatch && titleMatch[1]) {
    result.title = titleMatch[1];
  }

  // Chapter X-Y or X-Y-Z
  const chapterMatch = lower.match(/\bchapter\s+([0-9]+(?:-[0-9a-z]+)+)/i);
  if (chapterMatch && chapterMatch[1]) {
    result.chapter = chapterMatch[1];
  }

  // Section / Sec. / § N-N-N.N etc.
  const sectionMatch = lower.match(
    /\b(?:section|sec\.?|§)\s+([0-9]+(?:-[0-9a-z]+)*(?:\.[0-9a-z]+)*)/i
  );
  if (sectionMatch && sectionMatch[1]) {
    result.section = sectionMatch[1];
  }

  // If we failed all three, return null
  if (!result.title && !result.chapter && !result.section) {
    return null;
  }

  return result;
}

/**
 * Try to extract title / chapter / section from a sourcePath string
 * such as "Title-3_Chapter-3-1_Section-3-1-1.1.txt".
 */
function extractStructureFromPath(path: string): CodeStructureRef {
  const lower = path.toLowerCase();

  let title: string | undefined;
  let chapter: string | undefined;
  let section: string | undefined;

  const titleMatch = lower.match(/title[-_\s]*([0-9a-z.\-]+)/i);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1];
  }

  const chapterMatch = lower.match(/chapter[-_\s]*([0-9]+(?:-[0-9a-z]+)+)/i);
  if (chapterMatch && chapterMatch[1]) {
    chapter = chapterMatch[1];
  }

  const sectionMatch = lower.match(
    /section[-_\s]*([0-9]+(?:-[0-9a-z]+)*(?:\.[0-9a-z]+)*)/i
  );
  if (sectionMatch && sectionMatch[1]) {
    section = sectionMatch[1];
  }

  return {
    title,
    chapter,
    section,
  };
}

/**
 * Options for finding amendment chunks.
 *
 * - If `amendmentChunks` is provided, we filter that list directly.
 * - Otherwise, we load from the amendment codebook index on demand.
 */
export type FindAmendmentOptions = {
  amendmentChunks?: IndexedChunk[];
  amendmentCodebookId?: string; // default: "utah-amendments"
};

/**
 * Given a structural reference (Title / Chapter / Section), return
 * all amendment chunks whose metadata matches that structure.
 *
 * This is deterministic-ish:
 * - We prefer exact matches on meta.title/meta.chapter/meta.section.
 * - We also fall back to parsing from the sourcePath and partial matches.
 *
 * Matching rules:
 * - If structRef.section is present, we match if ANY of:
 *    - meta.section normalized equals the target
 *    - meta.section starts with the target (e.g. "3-1-1.1 general ...")
 *    - the section parsed from sourcePath equals the target
 * - If structRef.chapter is present, similar rules.
 * - If structRef.title is present, similar rules.
 *
 * If structRef is null or empty, we return [].
 */
export function findAmendmentChunksByStructure(
  structRef: CodeStructureRef | null,
  opts: FindAmendmentOptions = {}
): IndexedChunk[] {
  if (!structRef) return [];

  const { amendmentChunks, amendmentCodebookId = "utah-amendments" } = opts;

  // Get amendment chunks: either from caller or by loading the index.
  const allAmendmentChunks: IndexedChunk[] =
    amendmentChunks ?? loadCodebookIndex(amendmentCodebookId);

  const wantsTitle = !!structRef.title;
  const wantsChapter = !!structRef.chapter;
  const wantsSection = !!structRef.section;

  const targetTitle = normalize(structRef.title);
  const targetChapter = normalize(structRef.chapter);
  const targetSection = normalize(structRef.section);

  return allAmendmentChunks.filter((chunk) => {
    const meta = (chunk as any).meta || {};
    const sourcePath = String(chunk.sourcePath || "");

    const metaTitle = normalize(meta.title);
    const metaChapter = normalize(meta.chapter);
    const metaSection = normalize(meta.section);

    const pathStruct = extractStructureFromPath(sourcePath);
    const pathTitle = normalize(pathStruct.title);
    const pathChapter = normalize(pathStruct.chapter);
    const pathSection = normalize(pathStruct.section);

    // If this chunk has neither metadata nor path structure, bail early.
    if (!meta && !sourcePath) return false;

    // Helper: check if candidate matches target loosely
    const matchesField = (candidate: string, target: string): boolean => {
      if (!target) return true; // no target means no constraint
      if (!candidate) return false;
      if (candidate === target) return true;
      if (candidate.startsWith(target)) return true;
      if (candidate.includes(target)) return true;
      return false;
    };

    // Title match (if requested)
    if (wantsTitle) {
      const okTitle =
        matchesField(metaTitle, targetTitle) ||
        matchesField(pathTitle, targetTitle);
      if (!okTitle) return false;
    }

    // Chapter match (if requested)
    if (wantsChapter) {
      const okChapter =
        matchesField(metaChapter, targetChapter) ||
        matchesField(pathChapter, targetChapter);
      if (!okChapter) return false;
    }

    // Section match (if requested)
    if (wantsSection) {
      const okSection =
        matchesField(metaSection, targetSection) ||
        matchesField(pathSection, targetSection);
      if (!okSection) return false;
    }

    return true;
  });
}
