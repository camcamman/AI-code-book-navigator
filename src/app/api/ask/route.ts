import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import OpenAI from "openai";
import {
  searchCodebook,
  IndexedChunk,
  loadCodebookIndex,
} from "../../../lib/searchCodebook";
import { AMENDMENT_MAP, getCodebookDef } from "../../../lib/codebookRegistry";
import { getTableAssetInfoForSource } from "../../../lib/tableAssets";
import { resolveTableAssetForRef } from "../../../lib/tableAssetRegistry";
import {
  collectAmendmentExclusions,
  extractStructureFromQuery,
  findAmendmentChunksByStructure,
  normalizeIrcSectionId,
} from "../../../lib/amendmentLinking";
export const runtime = "nodejs";


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CHAT_MODEL = "gpt-5.2";

type AskRequestBody = {
  query: string;
  codebookId?: string;
  topK?: number;
  includeAmendments?: boolean;
  sessionId?: string;
  responseMode?: "answer" | "quotes_raw" | "quotes_organized";
};

type SourceRef = {
  sourceId: number;
  id: string;
  codebookId: string;
  codebookLabel: string;
  sourcePath: string;
  sectionLabel?: string;
  publicUrl?: string;
  startLine: number;
  endLine: number;
  isTable?: boolean;
  tableLabel?: string;
  tablePage?: number;
  tablePdfPath?: string;
  tableImagePath?: string;
  tablePdfUrl?: string;
  tableImageUrl?: string;
};

type AmendmentRef = {
  sourceId: number;
  id: string;
  codebookId: string;
  codebookLabel: string;
  sourcePath: string;
  sectionLabel?: string;
  publicUrl?: string;
  startLine: number;
  endLine: number;
  citation: string;
  fullText: string;
};

type AskResponse = {
  ok: boolean;
  query: string;
  codebookId: string;
  answer: string | null;
  sources: SourceRef[];
  amendments: AmendmentRef[];
  reason?: string;
  error?: string;
};

const MAX_MEMORY_TURNS = 30;

type MemoryEntry = {
  role: "user" | "assistant";
  query?: string;
  answer?: string;
  citations?: SourceRef[];
  topicHint?: string;   // ← ADD THIS
  timestamp: number;
};

const sessionMemory = new Map<string, MemoryEntry[]>();

type SelectedQuote = { sourceId: number; excerpt: string };

type SelectorResult = {
  sections: Array<{
    title: string;
    items: SelectedQuote[];
  }>;
};

let lastSelectorValidationFailReason: string | null = null;

function sentenceHasQuoteAndCitation(s: string): boolean {
  const hasQuote = /"[^"]{3,}"/.test(s);
  const hasCite = /\[source\s+\d+,\s+lines\s+\d+[-–]\d+\]/i.test(s);
  return hasQuote && hasCite;
}

function validateFinalAnswerOrFail(answer: string): boolean {
  const trimmed = answer.trim();
  if (trimmed === "I cannot answer that from the provided code sections.") return true;

  const citations =
    trimmed.match(/\[source\s+\d+,\s+lines\s+\d+[-–]\d+\]/gi) ?? [];
  if (citations.length === 0) return false;

  const quoteCitationPairs =
    trimmed.match(/"[^"]{3,}"[\s\S]{0,120}?\[source\s+\d+,\s+lines\s+\d+[-–]\d+\]/gi) ?? [];

  return quoteCitationPairs.length >= citations.length;
}


function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractExplicitTableRef(query: string): string | null {
  const match = normalizeWhitespace(query).match(
    /\btable\s+([A-Za-z]?\d+(?:\.\d+)*(?:\([0-9A-Za-z]+\))?)/i
  );
  return match?.[1] ? match[1].toUpperCase() : null;
}

function normalizeTableIdentity(value: string | null | undefined): string {
  return normalizeWhitespace(String(value || ""))
    .replace(/^TABLE\s+/i, "")
    .replace(/[–—]/g, "-")
    .replace(/\s*-\s*CONTINUED$/i, "")
    .toUpperCase();
}

function chunkMatchesTableRef(chunk: IndexedChunk, tableRef: string): boolean {
  const meta = (chunk as any).meta ?? {};
  const candidates = [
    typeof meta.tableId === "string" ? meta.tableId : null,
    typeof meta.caption === "string" ? meta.caption : null,
    typeof meta.sectionLabel === "string" ? meta.sectionLabel : null,
    path.basename(chunk.sourcePath || "", path.extname(chunk.sourcePath || "")),
  ];

  const normalizedTarget = normalizeTableIdentity(tableRef);
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeTableIdentity(candidate);
    if (!normalizedCandidate) return false;
    if (normalizedCandidate === normalizedTarget) return true;
    if (normalizedCandidate.includes(normalizedTarget)) return true;
    return false;
  });
}

function dedupeChunks(chunks: IndexedChunk[]): IndexedChunk[] {
  const seen = new Set<string>();
  const out: IndexedChunk[] = [];
  for (const chunk of chunks) {
    const key = `${chunk.sourcePath}:${chunk.startLine}-${chunk.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chunk);
  }
  return out;
}

function dedupeSourceRefs(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const source of sources) {
    const key =
      source.tablePdfUrl ||
      `${source.sourcePath}:${source.startLine}-${source.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

function findExplicitTableChunks(
  codebookId: string,
  tableRef: string,
  limit = 4
): IndexedChunk[] {
  try {
    const chunks = loadCodebookIndex(codebookId);
    return dedupeChunks(
      chunks.filter((chunk) => chunkMatchesTableRef(chunk, tableRef))
    ).slice(0, limit);
  } catch (error) {
    console.warn("[/api/ask] explicit table lookup failed", { codebookId, tableRef, error });
    return [];
  }
}

function buildSyntheticTableSource(
  codebookId: string,
  tableRef: string
): SourceRef | null {
  const asset = resolveTableAssetForRef(codebookId, tableRef);
  if (!asset) return null;

  return {
    sourceId: 1,
    id: `table-asset-${codebookId}-${tableRef}`,
    codebookId,
    codebookLabel: getCodebookDef(codebookId)?.label ?? codebookId,
    sourcePath: asset.tablePdfPath || `Table ${tableRef}`,
    sectionLabel: asset.tableLabel || `Table ${tableRef}`,
    startLine: 1,
    endLine: 1,
    isTable: true,
    tableLabel: asset.tableLabel || `Table ${tableRef}`,
    tablePage: asset.tablePage || undefined,
    tablePdfPath: asset.tablePdfPath || undefined,
    tableImagePath: asset.tableImagePath || undefined,
    tablePdfUrl: asset.tablePdfUrl || undefined,
    tableImageUrl: asset.tableImageUrl || undefined,
  };
}

function extractJsonObject(text: string): any | null {
  const stripped = (text || "").trim();
  if (!stripped) return null;

  let candidate = stripped;
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractQueryTerms(query: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by",
    "with", "from", "what", "when", "where", "which", "how", "are", "is", "be",
    "does", "do", "tell", "about", "rules", "rule", "construction", "code",
  ]);

  return Array.from(
    new Set(
      normalizeWhitespace(query)
        .toLowerCase()
        .split(/[^a-z0-9.]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !stop.has(t))
    )
  );
}

function buildDeterministicSelectorFallback(
  query: string,
  chunks: IndexedChunk[]
): SelectorResult | null {
  const terms = extractQueryTerms(query);
  if (terms.length === 0 || chunks.length === 0) return null;

  const scored: Array<{ sourceId: number; excerpt: string; score: number }> = [];

  for (let i = 0; i < chunks.length; i++) {
    const sourceId = i + 1;
    const text = chunks[i].content || "";
    if (!text.trim()) continue;

    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    let bestExcerpt = "";
    let bestScore = 0;

    for (const paragraph of paragraphs.length > 0 ? paragraphs : [text.trim()]) {
      const lower = paragraph.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (lower.includes(term)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestExcerpt = paragraph;
      }
    }

    if (bestScore > 0 && bestExcerpt) {
      const excerpt = bestExcerpt.slice(0, 1400).trim();
      if (excerpt) {
        scored.push({ sourceId, excerpt, score: bestScore });
      }
    }
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score || a.sourceId - b.sourceId);

  return {
    sections: [
      {
        title: "Relevant excerpts",
        items: scored.slice(0, 4).map(({ sourceId, excerpt }) => ({
          sourceId,
          excerpt,
        })),
      },
    ],
  };
}

function validateSelectorResult(
  parsed: any,
  chunks: IndexedChunk[]
): SelectorResult | null {
  lastSelectorValidationFailReason = null;

  if (!parsed || typeof parsed !== "object") {
    lastSelectorValidationFailReason = "parsed is not an object";
    return null;
  }
  if (!Array.isArray(parsed.sections)) {
    lastSelectorValidationFailReason = "parsed.sections is not an array";
    return null;
  }

  const maxSections = 4;
  const sections = parsed.sections.slice(0, maxSections);

  const out: SelectorResult["sections"] = [];

  for (const sec of sections) {
    if (!sec || typeof sec !== "object") {
      lastSelectorValidationFailReason = "section is not an object";
      return null;
    }
    if (!isNonEmptyString(sec.title)) {
      lastSelectorValidationFailReason = "section.title missing or empty";
      return null;
    }
    if (!Array.isArray(sec.items)) {
      lastSelectorValidationFailReason = "section.items is not an array";
      return null;
    }

    const items: SelectedQuote[] = [];

    for (const it of sec.items.slice(0, 6)) {
      if (!it || typeof it !== "object") {
        lastSelectorValidationFailReason = "item is not an object";
        continue;
      }
      const sourceId = (it as any).sourceId;
      const excerpt = (it as any).excerpt;

      if (typeof sourceId !== "number" || !Number.isFinite(sourceId)) {
        lastSelectorValidationFailReason = "item.sourceId invalid";
        continue;
      }
      if (!isNonEmptyString(excerpt)) {
        lastSelectorValidationFailReason = "item.excerpt missing or empty";
        continue;
      }

      const chunkIdx = sourceId - 1;
      if (chunkIdx < 0 || chunkIdx >= chunks.length) {
        lastSelectorValidationFailReason = "item.sourceId out of range";
        continue;
      }

      const chunkText = (chunks[chunkIdx].content || "").trim();
      const ex = excerpt.trim();

      // Must be an exact substring of the retrieved chunk (no paraphrase).
      const normalizedChunk = normalizeWhitespace(chunkText);
      const normalizedExcerpt = normalizeWhitespace(ex);
      if (!normalizedChunk.includes(normalizedExcerpt)) {
        lastSelectorValidationFailReason = "excerpt not substring of chunk content";
        continue;
      }

      // Prevent huge dumps
      if (ex.length > 1400) {
        lastSelectorValidationFailReason = "excerpt too long";
        continue;
      }

      items.push({ sourceId, excerpt: ex });
    }

    // Drop empty sections rather than failing.
    if (items.length > 0) out.push({ title: sec.title.trim(), items });
    
  }

  if (out.length === 0) {
    lastSelectorValidationFailReason = "no valid items after filtering";
    return null;
  }

  return { sections: out };
}

function renderOrganizedQuotes(
  selected: SelectorResult,
  sources: SourceRef[]
): string {
  const lines: string[] = [];

  for (const sec of selected.sections) {
    lines.push(sec.title);
    lines.push("");

    for (const item of sec.items) {
      const s = sources[item.sourceId - 1];
      const cite = `[source ${item.sourceId}, lines ${s.startLine}-${s.endLine}]`;
      lines.push(`${cite}`);
      lines.push(item.excerpt);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Trim trailing separators
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines[lines.length - 1] === "---") lines.pop();

  return lines.join("\n");
}

function buildFallbackAnswerFromSelected(
  selected: SelectorResult,
  sources: SourceRef[]
): string | null {
  const sentences: string[] = [];
  const maxSentences = 3;

  for (const sec of selected.sections) {
    for (const item of sec.items) {
      if (sentences.length >= maxSentences) break;
      const src = sources[item.sourceId - 1];
      if (!src) continue;
      const quote = item.excerpt;
      const cite = `[source ${item.sourceId}, lines ${src.startLine}-${src.endLine}]`;
      sentences.push(`The code states: "${quote}" ${cite}.`);
    }
    if (sentences.length >= maxSentences) break;
  }

  return sentences.length > 0 ? sentences.join(" ") : null;
}

function getLastUserQuery(history: { role: string; query?: string }[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role === "user" && h.query && h.query.trim().length > 0) return h.query.trim();
  }
  return null;
}

function getLastTopicHint(history: MemoryEntry[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (
      h.role === "assistant" &&
      typeof h.topicHint === "string" &&
      h.topicHint.trim().length > 0
    ) {
      return h.topicHint.trim();
    }
  }
  return null;
}

function getSessionHistory(sessionId: string): MemoryEntry[] {
  return sessionMemory.get(sessionId) ?? [];
}

function saveSessionHistory(sessionId: string, history: MemoryEntry[]) {
  if (history.length > MAX_MEMORY_TURNS) {
    history = history.slice(history.length - MAX_MEMORY_TURNS);
  }
  sessionMemory.set(sessionId, history);
}

// Build a single context string from chunks
function buildContext(
  chunks: IndexedChunk[]): 
  { contextText: string; sources: SourceRef[] } {
  const lines: string[] = [];
  const sources: SourceRef[] = [];

  chunks.forEach((chunk, idx) => {
    const sourceId = idx + 1;

    const meta = (chunk as any).meta ?? {};
    const rawSectionLabel: string | undefined =
      typeof meta.sectionLabel === "string" ? meta.sectionLabel :
      typeof meta.header === "string" ? meta.header :
      typeof meta.sectionId === "string" ? meta.sectionId :
      undefined;
    const tableAsset = getTableAssetInfoForSource({
      codebookId: chunk.codebookId,
      sourcePath: chunk.sourcePath,
      meta,
    });
    const sectionLabel = rawSectionLabel || tableAsset?.tableLabel || undefined;

    const publicUrl: string | undefined =
      typeof meta.publicUrl === "string" ? meta.publicUrl : undefined;

    const label = sectionLabel || chunk.sourcePath || `Source ${sourceId}`;
    const header = `[source ${sourceId}, lines ${chunk.startLine}-${chunk.endLine}] ${label}`;

    lines.push(header);
    lines.push(chunk.content);
    lines.push("");

    sources.push({
      sourceId,
      id: chunk.id,
      codebookId: chunk.codebookId,
      codebookLabel: getCodebookDef(chunk.codebookId)?.label ?? chunk.codebookId,
      sourcePath: chunk.sourcePath,
      sectionLabel,
      publicUrl,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      isTable: tableAsset?.isTable,
      tableLabel: tableAsset?.tableLabel || undefined,
      tablePage: tableAsset?.tablePage || undefined,
      tablePdfPath: tableAsset?.tablePdfPath || undefined,
      tableImagePath: tableAsset?.tableImagePath || undefined,
      tablePdfUrl: tableAsset?.tablePdfUrl || undefined,
      tableImageUrl: tableAsset?.tableImageUrl || undefined,
    });
  });

  return { contextText: lines.join("\n"), sources };
}

function buildQuotesRaw(chunks: IndexedChunk[]): { answer: string; sources: SourceRef[] } {
  const out: string[] = [];
  const sources: SourceRef[] = [];

  chunks.forEach((chunk, idx) => {
    const sourceId = idx + 1;
    const meta = (chunk as any).meta ?? {};

    const rawSectionLabel: string | undefined =
      typeof meta.sectionLabel === "string" ? meta.sectionLabel :
      typeof meta.header === "string" ? meta.header :
      typeof meta.sectionId === "string" ? meta.sectionId :
      undefined;
    const tableAsset = getTableAssetInfoForSource({
      codebookId: chunk.codebookId,
      sourcePath: chunk.sourcePath,
      meta,
    });
    const sectionLabel = rawSectionLabel || tableAsset?.tableLabel || undefined;

    const publicUrl: string | undefined =
      typeof meta.publicUrl === "string" ? meta.publicUrl : undefined;

    sources.push({
      sourceId,
      id: chunk.id,
      codebookId: chunk.codebookId,
      codebookLabel: getCodebookDef(chunk.codebookId)?.label ?? chunk.codebookId,
      sourcePath: chunk.sourcePath,
      sectionLabel,
      publicUrl,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      isTable: tableAsset?.isTable,
      tableLabel: tableAsset?.tableLabel || undefined,
      tablePage: tableAsset?.tablePage || undefined,
      tablePdfPath: tableAsset?.tablePdfPath || undefined,
      tableImagePath: tableAsset?.tableImagePath || undefined,
      tablePdfUrl: tableAsset?.tablePdfUrl || undefined,
      tableImageUrl: tableAsset?.tableImageUrl || undefined,
    });

    const label = sectionLabel || chunk.sourcePath || `Source ${sourceId}`;

    out.push(
      `[source ${sourceId}, lines ${chunk.startLine}-${chunk.endLine}] ${label}\n` +
      chunk.content.trim()
    );
  });

  return { answer: out.join("\n\n---\n\n"), sources };
  }

type SourceCitation = {
  sourceId: number;
  startLine: number;
  endLine: number;
  index: number;
  endIndex: number;
};

type Contribution = {
  sourceId: number;
  type: "quote" | "paraphrase" | "structural";
  spans: Array<{ start: number; end: number }>;
};

type SourceRegistry = {
  usedSourceIds: Set<number>;
  usedSources: SourceRef[];
};

function parseCitationsFromText(text: string): SourceCitation[] {
  const out: SourceCitation[] = [];
  const pattern = /\[source\s+(\d+),\s+lines\s+(\d+)[-–](\d+)\]/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const sourceId = Number(match[1]);
    const startLine = Number(match[2]);
    const endLine = Number(match[3]);
    if (!Number.isFinite(sourceId) || !Number.isFinite(startLine) || !Number.isFinite(endLine)) {
      continue;
    }
    out.push({
      sourceId,
      startLine,
      endLine,
      index: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function registerSource(
  registry: SourceRegistry,
  sourceId: number,
  sourcesById: Map<number, SourceRef>
): void {
  const src = sourcesById.get(sourceId);
  if (!src) {
    throw new Error(`SOURCE_MISSING: sourceId ${sourceId} not found in sources list`);
  }
  const resolvedPath = path.resolve(src.sourcePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `SOURCE_FILE_MISSING: sourceId ${sourceId} path ${src.sourcePath} not found`
    );
  }
  if (!registry.usedSourceIds.has(sourceId)) {
    registry.usedSourceIds.add(sourceId);
    registry.usedSources.push(src);
  }
}

function buildUsedSourcesAndRewrite(
  answer: string,
  sources: SourceRef[],
  contentBySourceId: Map<number, string>,
  debugEnabled: boolean
): { answer: string; usedSources: SourceRef[]; contributions: Contribution[] } {
  const citations = parseCitationsFromText(answer);
  if (citations.length === 0) {
    return { answer, usedSources: [], contributions: [] };
  }

  const sourcesById = new Map<number, SourceRef>();
  for (const s of sources) sourcesById.set(s.sourceId, s);
  const registry: SourceRegistry = { usedSourceIds: new Set(), usedSources: [] };
  const contributionsById = new Map<number, Contribution>();

  for (const cite of citations) {
    registerSource(registry, cite.sourceId, sourcesById);
    const entry = contributionsById.get(cite.sourceId) ?? {
      sourceId: cite.sourceId,
      type: "quote",
      spans: [],
    };
    entry.spans.push({ start: cite.index, end: cite.endIndex });
    contributionsById.set(cite.sourceId, entry);
  }

  const orderedSourceIds = registry.usedSources.map((s) => s.sourceId);
  const remap = new Map<number, number>();
  orderedSourceIds.forEach((id, idx) => remap.set(id, idx + 1));
  const originalByNew = new Map<number, number>();
  for (const [oldId, newId] of remap.entries()) {
    originalByNew.set(newId, oldId);
  }

  const rewritten = answer.replace(
    /\[source\s+(\d+),\s+lines\s+(\d+)[-–](\d+)\]/gi,
    (full, idStr, start, end) => {
      const oldId = Number(idStr);
      const newId = remap.get(oldId);
      if (!newId) {
        throw new Error(`GHOST_SOURCE_VIOLATION: citation references source ${oldId}`);
      }
      return `[source ${newId}, lines ${start}-${end}]`;
    }
  );

  const usedSources = registry.usedSources.map((src) => {
    const newId = remap.get(src.sourceId);
    if (!newId) return src;
    return { ...src, sourceId: newId };
  });

  const referenced = parseCitationsFromText(rewritten);
  const referencedIds = new Set(referenced.map((c) => c.sourceId));
  for (const src of usedSources) {
    if (!referencedIds.has(src.sourceId)) {
      throw new Error(
        `GHOST_SOURCE_VIOLATION: listed source ${src.sourceId} not referenced in answer`
      );
    }
  }
  for (const id of referencedIds) {
    if (id < 1 || id > usedSources.length) {
      throw new Error(`GHOST_SOURCE_VIOLATION: citation references unknown source ${id}`);
    }
  }
  const seenPaths = new Map<string, number>();
  for (const src of usedSources) {
    const prior = seenPaths.get(src.sourcePath);
    if (prior && prior !== src.sourceId) {
      throw new Error(
        `GHOST_SOURCE_VIOLATION: duplicate sourcePath for ids ${prior} and ${src.sourceId}`
      );
    }
    seenPaths.set(src.sourcePath, src.sourceId);
  }

  const seenHashes = new Map<string, number>();
  for (const src of usedSources) {
    const resolvedPath = path.resolve(src.sourcePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `GHOST_SOURCE_VIOLATION: source file missing for ${src.sourcePath}`
      );
    }
    if (src.codebookId === "irc-utah-2021-amendments") {
      const requiredRoot = path.resolve(
        "codebooks",
        "irc-utah-2021-amendments",
        "raw",
        "items"
      );
      if (!resolvedPath.startsWith(requiredRoot)) {
        throw new Error(
          `GHOST_SOURCE_VIOLATION: amendment source outside items dir ${src.sourcePath}`
        );
      }
    }
    const originalId = originalByNew.get(src.sourceId);
    if (!originalId) {
      throw new Error(
        `GHOST_SOURCE_VIOLATION: missing original id for source ${src.sourceId}`
      );
    }
    const content = contentBySourceId.get(originalId);
    if (content === undefined) {
      throw new Error(
        `GHOST_SOURCE_VIOLATION: missing content for source ${src.sourceId}`
      );
    }
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const prior = seenHashes.get(hash);
    if (prior && prior !== src.sourceId) {
      throw new Error(
        `GHOST_SOURCE_VIOLATION: duplicate content hash for sources ${prior} and ${src.sourceId}`
      );
    }
    seenHashes.set(hash, src.sourceId);
  }

  if (debugEnabled) {
    const rows = registry.usedSources.map((s) => {
      const newId = remap.get(s.sourceId);
      const contrib = contributionsById.get(s.sourceId);
      return {
        sourceId: newId ?? s.sourceId,
        sourcePath: s.sourcePath,
        contribution: contrib?.type ?? "quote",
        spans: contrib?.spans ?? [],
      };
    });
    console.log("[/api/ask] source contributions", rows);
  }

  const contributions: Contribution[] = [];
  for (const id of orderedSourceIds) {
    const entry = contributionsById.get(id);
    if (entry) {
      contributions.push(entry);
    }
  }

  return { answer: rewritten, usedSources, contributions };
}

function buildAmendmentRefsFromUsedSources(
  usedSources: SourceRef[],
  chunksByPath: Map<string, IndexedChunk>
): AmendmentRef[] {
  const out: AmendmentRef[] = [];
  for (const src of usedSources) {
    if (src.codebookId !== "irc-utah-2021-amendments") continue;
    const chunk = chunksByPath.get(src.sourcePath);
    if (!chunk) {
      throw new Error(
        `GHOST_SOURCE_VIOLATION: missing chunk for amendment source ${src.sourcePath}`
      );
    }
    const meta = (chunk as any).meta ?? {};
    const sectionLabel: string | undefined =
      typeof meta.sectionLabel === "string" ? meta.sectionLabel :
      typeof meta.header === "string" ? meta.header :
      typeof meta.sectionId === "string" ? meta.sectionId :
      typeof meta.section === "string" ? meta.section :
      undefined;
    const publicUrl: string | undefined =
      typeof meta.publicUrl === "string" ? meta.publicUrl : undefined;
    const citation = `[source ${src.sourceId}, lines ${chunk.startLine}-${chunk.endLine}]`;
    out.push({
      sourceId: src.sourceId,
      id: chunk.id,
      codebookId: chunk.codebookId,
      codebookLabel: getCodebookDef(chunk.codebookId)?.label ?? chunk.codebookId,
      sourcePath: chunk.sourcePath,
      sectionLabel,
      publicUrl,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      citation,
      fullText: chunk.content,
    });
  }
  return out;
}

export async function POST(request: Request) {
  let body: AskRequestBody;

  try {
    body = (await request.json()) as AskRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const rawQuery = body.query || "";
  const query = rawQuery.trim();
  const baseCodebookId = body.codebookId || "irc-utah-2021";
  const topK = body.topK ?? 6;
  const includeAmendments = body.includeAmendments ?? true;
  const responseMode = body.responseMode;

  const rawSessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const sessionId = rawSessionId.length > 0 ? rawSessionId : null;
  const hasSessionId = sessionId !== null;

  console.log("[/api/ask] request", {
    query,
    baseCodebookId,
    includeAmendments,
    topK,
    hasSessionId,
    responseMode,
  });

  if (!query) {
    const res: AskResponse = {
      ok: false,
      query,
      codebookId: baseCodebookId,
      answer: null,
      sources: [],
      amendments: [],
      reason: "Missing or empty 'query' field.",
    };
    return NextResponse.json(res, { status: 400 });
  }

  const baseDef = getCodebookDef(baseCodebookId);
  if (!baseDef || baseDef.isAmendment) {
    console.log("[/api/ask] baseDef check", {
      baseDefExists: Boolean(baseDef),
      baseDefIsAmendment: Boolean(baseDef?.isAmendment),
      amendmentCodebookId: AMENDMENT_MAP[baseCodebookId],
    });
    const res: AskResponse = {
      ok: false,
      query,
      codebookId: baseCodebookId,
      answer: null,
      sources: [],
      amendments: [],
      reason: `Invalid base codebookId: ${baseCodebookId}`,
    };
    return NextResponse.json(res, { status: 400 });
  }

  // ----------------------------
  // Session memory (still useful for retrieval anchoring)
  // ----------------------------
  const history: MemoryEntry[] =
    sessionId !== null ? getSessionHistory(sessionId) : [];

  // ----------------------------
  // Context-aware retrieval query
  // ----------------------------
  let effectiveQuery = query;

  const hasCodeLike =
    /\b([a-z]\d{3,}(\.\d+)*)\b/i.test(query) ||
    /\b\d{1,3}-\d{1,3}-\d+(\.\d+)?\b/.test(query);

  const anchoringApplied = !hasCodeLike && history.length > 0;
  if (!hasCodeLike && history.length > 0) {
    const hint = getLastTopicHint(history) ?? getLastUserQuery(history);
    if (hint) {
      effectiveQuery = `${hint}\n\nFollow-up question:\n${query}`;
    }
  }

  console.log("[/api/ask] query context", {
    hasCodeLike,
    anchoringApplied,
    effectiveQueryPreview: effectiveQuery.slice(0, 500),
  });

  const structuralRef = extractStructureFromQuery(query);
  const explicitTableRef = extractExplicitTableRef(query);
  console.log("[/api/ask] structuralRef", structuralRef);
  console.log("[/api/ask] explicitTableRef", explicitTableRef);

  // ----------------------------
  // Retrieve base + amendments
  // ----------------------------
  const amendmentCodebookId = AMENDMENT_MAP[baseCodebookId];
  console.log("[/api/ask] amendment mapping", {
    baseDefExists: Boolean(baseDef),
    baseDefIsAmendment: Boolean(baseDef?.isAmendment),
    amendmentCodebookId,
  });

  const baseChunks = await searchCodebook({
    query: effectiveQuery,
    codebookId: baseCodebookId,
    topK,
  });

  const explicitTableChunks =
    explicitTableRef !== null
      ? findExplicitTableChunks(baseCodebookId, explicitTableRef, topK)
      : [];

  console.log(
    "[/api/ask] baseChunks",
    baseChunks.length,
    baseChunks.slice(0, 3).map((chunk) => {
      const meta = (chunk as any).meta ?? {};
      return {
        sourcePath: chunk.sourcePath,
        sectionLabel: meta.sectionLabel ?? meta.sectionId ?? undefined,
        lines: `${chunk.startLine}-${chunk.endLine}`,
        preview: (chunk.content || "").slice(0, 200),
      };
    })
  );

  let amendmentChunks: IndexedChunk[] = [];
  if (includeAmendments) {
    if (amendmentCodebookId) {
      try {
        const structuralAmendmentChunks =
          structuralRef && (structuralRef.section || structuralRef.chapter || structuralRef.title)
            ? findAmendmentChunksByStructure(structuralRef, {
                amendmentCodebookId,
              })
            : [];

        if (structuralAmendmentChunks.length > 0) {
          amendmentChunks = structuralAmendmentChunks.slice(0, topK);
        } else {
          amendmentChunks = await searchCodebook({
            query: effectiveQuery,
            codebookId: amendmentCodebookId,
            topK,
          });
        }
      } catch (e) {
        console.warn("Amendment search failed:", e);
      }
    }
  }

  if (includeAmendments && amendmentCodebookId) {
    if (amendmentChunks.length === 0) {
      console.warn("NO AMENDMENT CHUNKS RETRIEVED (check mapping/index/query).");
    }
    console.log(
      "[/api/ask] amendmentChunks",
      amendmentChunks.length,
      amendmentChunks.slice(0, 5).map((chunk) => {
        const meta = (chunk as any).meta ?? {};
        return {
          sourcePath: chunk.sourcePath,
          sectionLabel: meta.sectionLabel ?? meta.sectionId ?? meta.section ?? undefined,
          lines: `${chunk.startLine}-${chunk.endLine}`,
          preview: (chunk.content || "").slice(0, 250),
        };
      })
    );
  }

  const { excludedSectionIds, failClosedNoBase } =
    collectAmendmentExclusions(amendmentChunks);

  let filteredBaseChunks = dedupeChunks([
    ...explicitTableChunks,
    ...baseChunks,
  ]);
  if (failClosedNoBase) {
    filteredBaseChunks = [];
  } else if (excludedSectionIds.size > 0) {
    filteredBaseChunks = filteredBaseChunks.filter((chunk) => {
      const meta = (chunk as any).meta ?? {};
      const sectionIdRaw =
        typeof meta.sectionId === "string" ? meta.sectionId : null;
      if (!sectionIdRaw) return true;
      const sectionId = normalizeIrcSectionId(sectionIdRaw);
      return sectionId === null || !excludedSectionIds.has(sectionId);
    });
  }

  const allChunks: IndexedChunk[] = dedupeChunks([
    ...filteredBaseChunks,
    ...amendmentChunks,
  ]);
  const chunksByPath = new Map<string, IndexedChunk>();
  for (const chunk of allChunks) {
    if (chunk.sourcePath) {
      chunksByPath.set(chunk.sourcePath, chunk);
    }
  }

  console.log("[/api/ask] allChunks", {
    total: allChunks.length,
    amendmentCount: amendmentCodebookId
      ? allChunks.filter((c) => c.codebookId === amendmentCodebookId).length
      : 0,
    baseCount: allChunks.filter((c) => c.codebookId === baseCodebookId).length,
  });

  const { sources: srcs } = buildQuotesRaw(allChunks);
  const directTableSource =
    explicitTableRef !== null
      ? buildSyntheticTableSource(baseCodebookId, explicitTableRef)
      : null;
  const explicitTableSources =
    explicitTableRef !== null
      ? dedupeSourceRefs([
          ...srcs.filter((src, idx) => chunkMatchesTableRef(allChunks[idx], explicitTableRef)),
          ...(directTableSource ? [directTableSource] : []),
        ]).map((src, idx) => ({ ...src, sourceId: idx + 1 }))
      : [];

  if (allChunks.length === 0) {
    console.log("[/api/ask] summary", {
      baseChunks: baseChunks.length,
      amendmentChunks: amendmentChunks.length,
      allChunks: allChunks.length,
      selectorSelected: false,
      reason: "no chunks retrieved",
    });
    const res: AskResponse = {
      ok: false,
      query,
      codebookId: baseCodebookId,
      answer: null,
      sources: explicitTableSources,
      amendments: [],
      reason: "I cannot answer that from the provided code sections.",
    };
    return NextResponse.json(res, { status: 200 });
  }

  // Build context for selector (has [source N] headers)
  const { contextText } = buildContext(allChunks);
  console.log("[/api/ask] contextText", {
    length: contextText.length,
    preview: contextText.slice(0, 500),
  });

  // ----------------------------
  // ALWAYS: organized quotes selector + strict validation
  // ----------------------------
  const selectorSystem = `
    You are selecting quoted evidence from building code excerpts.

    HARD RULES (must follow exactly):
    1) You may ONLY return JSON.
    2) You may ONLY use text that appears verbatim in the provided excerpts.
    3) Every excerpt you return MUST be an exact substring of the source text.
    4) You MUST NOT paraphrase, summarize, or restate code requirements.
    5) Use up to 4 sections total.
    6) Each section may contain up to 6 excerpts.
    7) Return { "cannotAnswer": true } ONLY if you cannot find ANY relevant verbatim excerpts related to the question.
    8) You may select relevant excerpts even if they do not support a definitive yes/no conclusion.

    Output format (and no other format is allowed):

    {
      "sections": [
        {
          "title": "<short neutral label derived from the question>",
          "items": [
            {
              "sourceId": <number>,
              "excerpt": "<verbatim quoted text>"
            }
          ]
        }
      ]
    }

    Do not add commentary.
    Do not add explanations.
    Do not add conclusions.
    Do not infer yes or no unless the text explicitly states it.
    Do not combine multiple excerpts into one.
  `;



  const ANSWER_SYSTEM_PROMPT = `
 a building-code answering assistant operating under strict extractive rules.

    ABSOLUTE RULES (violations invalidate the answer):
    1) You may use ONLY the provided code excerpts.
    2) You MUST NOT paraphrase, summarize, reinterpret, or restate any code language.
    3) Every sentence that asserts a requirement, permission, prohibition, exception,
      definition, threshold, or condition MUST contain:
      a) at least one verbatim quote copied exactly from the provided excerpts,
          enclosed in double quotes, AND
      b) an inline citation in the exact format:
          [source N, lines A–B].
    4) If a sentence cannot be directly supported by a verbatim quote,
      you MUST NOT write that sentence.
    5) You MUST NOT infer “yes”, “no”, “allowed”, “required”, or similar conclusions
      unless the quoted text explicitly states it.
    6) If the provided excerpts do not directly support a definitive answer,
      you MUST respond with exactly:
      "I cannot answer that from the provided code sections."

    STYLE CONSTRAINTS:
    - Write in normal sentence format (no bullet points).
    - Use only short neutral lead-ins if needed, such as:
      "The code states:", "It further states:", "An amendment states:".
    - Do NOT explain what the code means.
    - Do NOT add reasoning, commentary, examples, or interpretations.
    - Do NOT mention model behavior or limitations.

    OUTPUT CONSTRAINTS:
    - 1 to 6 sentences maximum.
    - Every non-empty sentence MUST include a verbatim quote and a citation.
    - Citations must correspond to the quoted text exactly.
  `;

  const wantsOkVsNot =
    /\b(when|okay|ok)\b/i.test(query) && /\b(24|16)\b/.test(query);

  const preferred =
    wantsOkVsNot
      ? "Use exactly two sections titled:\n" +
        "1) \"24 inches o.c. is OK when\"\n" +
        "2) \"24 inches o.c. is NOT OK / 16 inches is required when\"\n"
      : "Use up to 3 sections with short titles that match the question.\n";

  const selectorUser =
    `User question:\n${query}\n\n` +
    `${preferred}\n` +
    "Select the most relevant verbatim excerpts that relate to the question, even if they are not definitive.\n" +
    "Only return { \"cannotAnswer\": true } if no relevant excerpts exist at all.\n" +
    "Provided excerpts (do not alter text; only select exact substrings):\n\n" +
    contextText +
    "\n\nReturn JSON in this shape:\n" +
    "{\n" +
    "  \"sections\": [\n" +
    "    { \"title\": \"...\", \"items\": [ {\"sourceId\": 1, \"excerpt\": \"exact substring\"} ] }\n" +
    "  ]\n" +
    "}\n";
  console.log("[/api/ask] selectorUser", {
    length: selectorUser.length,
    preview: selectorUser.slice(0, 300),
  });

  let selected: SelectorResult | null = null;
  let selectorJsonParsed = false;

  try {
    const sel = await openai.chat.completions.create({
      model: CHAT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: selectorSystem },
        { role: "user", content: selectorUser },
      ],
      temperature: 0,
    });

    const raw = sel.choices[0]?.message?.content ?? "";
    console.log("SELECTOR RAW OUTPUT:", raw);

    let parsed: any = null;
    parsed = extractJsonObject(raw);
    selectorJsonParsed = parsed !== null;
    if (!selectorJsonParsed) {
      console.log("SELECTOR JSON PARSE FAILED");
    }
    console.log("SELECTOR JSON PARSED:", selectorJsonParsed);

    if (parsed && parsed.cannotAnswer === true) {
      console.log("SELECTOR SAID cannotAnswer=true");
      selected = null;
    } else {
      selected = validateSelectorResult(parsed, allChunks);
    }

    if (!selected && lastSelectorValidationFailReason) {
      console.log("SELECTOR VALIDATION FAILED:", lastSelectorValidationFailReason);
    }
    console.log("SELECTOR VALID:", Boolean(selected));
  } catch (e) {
    console.log("SELECTOR CALL FAILED", e);
    selected = null;
  }

  if (!selected) {
    const deterministic = buildDeterministicSelectorFallback(query, allChunks);
    if (deterministic) {
      console.log("SELECTOR FALLBACK: using deterministic excerpt selection");
      selected = deterministic;
    }
  }

  if (!selected) {
    console.log("[/api/ask] summary", {
      baseChunks: baseChunks.length,
      amendmentChunks: amendmentChunks.length,
      allChunks: allChunks.length,
      selectorSelected: false,
      reason: "selector returned cannotAnswer or invalid",
    });
    return NextResponse.json(
      {
        ok: false,
        query,
        codebookId: baseCodebookId,
        answer: null,
        sources: explicitTableSources,
        amendments: [],
        reason: "I cannot answer that from the provided code sections.",
      },
      { status: 200 }
    );
  }


  const organizedAnswer = renderOrganizedQuotes(selected, srcs);

  // ----------------------------
  // Answer model: sentence format, but every definitive sentence must quote + cite
  // ----------------------------
  const answerUser =
    `Question:\n${query}\n\n` +
    `You MUST answer in normal sentences.\n` +
    `Every sentence that makes a definitive claim MUST include a verbatim quote in double quotes from the provided excerpts AND an inline citation like [source N, lines A–B].
` +
    `If you cannot do that from the provided excerpts, output exactly: I cannot answer that from the provided code sections.

` +
    `Provided excerpts (use only these):\n\n` +
    organizedAnswer;

  let finalAnswer = organizedAnswer; // fallback if model fails

  try {
    const ans = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: ANSWER_SYSTEM_PROMPT },
        { role: "user", content: answerUser },
      ],
      temperature: 0,
    });

    finalAnswer = ans.choices[0]?.message?.content?.trim() || finalAnswer;
  } catch (e) {
    console.warn("ANSWER MODEL FAILED:", e);
    finalAnswer = organizedAnswer;
  }

  // 🔒 ENFORCEMENT GOES HERE (after model runs)
  if (!validateFinalAnswerOrFail(finalAnswer)) {
    const fallback = buildFallbackAnswerFromSelected(selected, srcs);
    if (fallback && validateFinalAnswerOrFail(fallback)) {
      finalAnswer = fallback;
    } else {
      console.log("[/api/ask] summary", {
        baseChunks: baseChunks.length,
        amendmentChunks: amendmentChunks.length,
        allChunks: allChunks.length,
        selectorSelected: true,
        reason: "final answer failed validation",
      });
      return NextResponse.json(
        {
          ok: false,
          query,
          codebookId: baseCodebookId,
          answer: null,
          sources: explicitTableSources,
          amendments: [],
          reason: "I cannot answer that from the provided code sections.",
        },
        { status: 200 }
      );
    }
  }

  const cannotAnswerPhrase =
    "I cannot answer that from the provided code sections.";
  const contentBySourceId = new Map<number, string>();
  allChunks.forEach((chunk, idx) => {
    contentBySourceId.set(idx + 1, chunk.content || "");
  });
  const { answer: rewrittenAnswer, usedSources } =
    finalAnswer.trim() === cannotAnswerPhrase
      ? { answer: finalAnswer, usedSources: [] }
      : buildUsedSourcesAndRewrite(
          finalAnswer,
          srcs,
          contentBySourceId,
          process.env.DEBUG_SOURCES === "1"
        );
  finalAnswer = rewrittenAnswer;

  if (finalAnswer.trim() === cannotAnswerPhrase) {
    return NextResponse.json(
      {
        ok: false,
        query,
        codebookId: baseCodebookId,
        answer: null,
        sources: explicitTableSources,
        amendments: [],
        reason: "I cannot answer that from the provided code sections.",
      },
      { status: 200 }
    );
  }

  if (finalAnswer.trim() !== cannotAnswerPhrase && usedSources.length === 0) {
    throw new Error("SOURCE_RECONCILIATION_FAILED: no citations found in answer");
  }

  // Optional: store topic hint for follow-up retrieval (no “answer text” memory needed)
  const now = Date.now();
  if (sessionId !== null) {
    const topicHint = usedSources[0]?.sectionLabel || usedSources[0]?.sourcePath || undefined;

    const updatedHistory: MemoryEntry[] = [
      ...history,
      { role: "user", query, timestamp: now },
      { role: "assistant", answer: null as any, citations: usedSources, topicHint, timestamp: now },
    ];

    saveSessionHistory(sessionId, updatedHistory);
  }

  console.log("[/api/ask] summary", {
    baseChunks: baseChunks.length,
    amendmentChunks: amendmentChunks.length,
    allChunks: allChunks.length,
    selectorSelected: true,
    reason: "ok",
  });

  const amendmentRefs = buildAmendmentRefsFromUsedSources(
    usedSources,
    chunksByPath
  );

  const res: AskResponse = {
    ok: true,
    query,
    codebookId: baseCodebookId,
    answer: finalAnswer,
    sources: usedSources,
    amendments: amendmentRefs,
  };


  return NextResponse.json(res, { status: 200 });
}
