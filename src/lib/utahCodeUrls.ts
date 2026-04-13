// src/lib/utahCodeUrls.ts
import path from "node:path";

export interface UtahSectionMetadata {
  titleNumber: string;     // e.g. "57" or "78B"
  chapterNumber: string;   // e.g. "12" or "3"
  sectionId: string;       // e.g. "57-12-6" or "78B-3-502"
  sectionLabel: string;    // e.g. "Title 57 Chapter 57-12 Section 57-12-6"
  publicUrl: string | null;
}

function stripSubsectionSuffix(raw: string): string {
  const noParens = raw.split("(")[0] || "";
  return noParens.replace(/[^0-9A-Za-z.]+$/g, "").trim();
}

function buildSectionId(
  title: string,
  chapter: string,
  section: string
): string | null {
  const t = title.trim();
  const c = chapter.trim();
  const s = stripSubsectionSuffix(section);
  if (!t || !c || !s) return null;
  return `${t}-${c}-${s}`;
}

/**
 * Resolve a Utah code citation or label to the official xcode URL.
 *
 * Accepts inputs like:
 * - "15A-3-202"
 * - "15A-3-202(1)"
 * - "Title 15A Chapter 3 Section 202"
 * - "Title 57 Chapter 57-12 Section 57-12-6"
 */
export function resolveUtahCodeUrl(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  // First: look for a full hyphenated citation (Title-Chapter-Section)
  const hyphenMatch = raw.match(
    /([0-9]+[A-Za-z]?)\s*-\s*([0-9A-Za-z]+)\s*-\s*([0-9A-Za-z.]+(?:\([^)]*\))*)/
  );
  if (hyphenMatch) {
    const sectionId = buildSectionId(
      hyphenMatch[1],
      hyphenMatch[2],
      hyphenMatch[3]
    );
    return sectionId ? buildUtahCodeSectionUrl(sectionId) : null;
  }

  // Fallback: parse "Title X Chapter Y Section Z" style labels
  const titleMatch = raw.match(/Title\s+([0-9]+[A-Za-z]?)/i);
  const chapterMatch = raw.match(/Chapter\s+([0-9A-Za-z-]+)/i);
  const sectionMatch = raw.match(/Section\s+([0-9A-Za-z.\-]+(?:\([^)]*\))*)/i);

  if (!titleMatch || !chapterMatch || !sectionMatch) {
    return null;
  }

  const title = titleMatch[1];
  let chapter = chapterMatch[1];
  let section = sectionMatch[1];

  // Normalize chapter/section if they include title prefix
  if (chapter.startsWith(`${title}-`)) {
    chapter = chapter.slice(title.length + 1);
  }
  if (section.startsWith(`${title}-${chapter}-`)) {
    section = section.slice(`${title}-${chapter}-`.length);
  } else if (section.startsWith(`${title}-`)) {
    const rest = section.slice(title.length + 1);
    if (rest.startsWith(`${chapter}-`)) {
      section = rest.slice(chapter.length + 1);
    } else {
      section = rest;
    }
  }

  const sectionId = buildSectionId(title, chapter, section);
  return sectionId ? buildUtahCodeSectionUrl(sectionId) : null;
}

/**
 * Build the official Utah Legislature HTML URL for a section id.
 *
 * Examples:
 *   "57-12-6"    -> https://le.utah.gov/xcode/Title57/Chapter12/57-12-S6.html
 *   "78B-3-502"  -> https://le.utah.gov/xcode/Title78B/Chapter3/78B-3-S502.html
 *   "57-22-5.1"  -> https://le.utah.gov/xcode/Title57/Chapter22/57-22-S5.1.html
 */
export function buildUtahCodeSectionUrl(sectionId: string): string | null {
  const parts = sectionId.split("-");

  // Need at least: title-chapter-section
  if (parts.length < 3) return null;

  const title = parts[0];       // e.g. "57" or "78B"
  const chapter = parts[1];     // e.g. "12" or "3"
  const tail = parts.slice(2).join("-"); // e.g. "6" or "502" or "5.1"

  // Utah pattern: {title}-{chapter}-S{tail}.html
  //   57-12-6    -> 57-12-S6.html
  //   78B-3-502  -> 78B-3-S502.html
  //   57-22-5.1  -> 57-22-S5.1.html
  const fileName = `${title}-${chapter}-S${tail}.html`;

  return `https://le.utah.gov/xcode/Title${title}/Chapter${chapter}/${fileName}`;
}

/**
 * Parse a Utah amendment filename of the form:
 *   Title-57_Chapter-57-12_Section-57-12-6.txt
 *   Title-78B_Chapter-78B-3_Section-78B-3-502.txt
 *
 * And produce clean metadata + official URL.
 */
export function parseUtahAmendmentFilename(
  filePath: string
): UtahSectionMetadata | null {
  const base = path.basename(filePath).replace(/\.txt$/i, "");
  // Expect pieces like: ["Title-57", "Chapter-57-12", "Section-57-12-6"]
  const parts = base.split("_");

  const titlePart = parts.find((p) => p.startsWith("Title-"));
  const chapterPart = parts.find((p) => p.startsWith("Chapter-"));
  const sectionPart = parts.find((p) => p.startsWith("Section-"));

  if (!titlePart || !chapterPart || !sectionPart) {
    return null;
  }

  // Title-57       -> "57"
  // Title-78B      -> "78B"
  const titleNumber = titlePart.replace(/^Title-/, "");

  // Chapter-57-12   -> raw "57-12"   -> chapterNumber "12"
  // Chapter-78B-3   -> raw "78B-3"   -> chapterNumber "3"
  const chapterRaw = chapterPart.replace(/^Chapter-/, "");
  const chapterPieces = chapterRaw.split("-");
  if (chapterPieces.length < 2) {
    // Unexpected; fall back to whole thing as chapter number
    // e.g. chapterRaw "12"
    // this still works for Title57/Chapter12
    const chapterNumber = chapterRaw;
    const sectionId = sectionPart.replace(/^Section-/, "");
    const sectionLabel = `Title ${titleNumber} Chapter ${chapterRaw} Section ${sectionId}`;
    const publicUrl = buildUtahCodeSectionUrl(sectionId);

    return {
      titleNumber,
      chapterNumber,
      sectionId,
      sectionLabel,
      publicUrl,
    };
  }

  // Drop the first piece (title), everything after is the chapter number
  // "57-12"  -> ["57", "12"]     -> "12"
  // "78B-3"  -> ["78B", "3"]     -> "3"
  const chapterNumber = chapterPieces.slice(1).join("-");

  // Section-57-12-6     -> "57-12-6"
  // Section-78B-3-502   -> "78B-3-502"
  const sectionId = sectionPart.replace(/^Section-/, "");

  // Keep your existing human-friendly label style
  const sectionLabel = `Title ${titleNumber} Chapter ${chapterRaw} Section ${sectionId}`;

  const publicUrl = buildUtahCodeSectionUrl(sectionId);

  return {
    titleNumber,
    chapterNumber,
    sectionId,
    sectionLabel,
    publicUrl,
  };
}
