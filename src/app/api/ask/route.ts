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
  getAmendmentInfo,
  normalizeIrcSectionId,
} from "../../../lib/amendmentLinking";
export const runtime = "nodejs";


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || "gpt-5.5";
const FALLBACK_CHAT_MODEL = process.env.OPENAI_FALLBACK_CHAT_MODEL || "gpt-5.4";
const SUMMARY_DISCLAIMER =
  "AI-generated plain-language summary. It is not the official code text and may be incomplete or inaccurate.";

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
  aiSummary?: string | null;
  aiSummaryDisclaimer?: string | null;
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
type ExpandedQuote = SelectedQuote & { startLine?: number; endLine?: number };

type SelectorResult = {
  sections: Array<{
    title: string;
    items: ExpandedQuote[];
  }>;
};

let lastSelectorValidationFailReason: string | null = null;

type ChatCompletionParams = Parameters<typeof openai.chat.completions.create>[0];

function shouldFallbackChatModel(error: unknown): boolean {
  const status = (error as any)?.status;
  const message = String((error as any)?.message || (error as any)?.error?.message || "");
  return (
    status === 400 ||
    status === 404 ||
    /model|does not exist|not found|not have access|unsupported/i.test(message)
  );
}

function shouldRetryWithoutTemperature(error: unknown): boolean {
  const param = String((error as any)?.param || (error as any)?.error?.param || "");
  const code = String((error as any)?.code || (error as any)?.error?.code || "");
  const message = String((error as any)?.message || (error as any)?.error?.message || "");
  return (
    param === "temperature" ||
    code === "unsupported_value" && /temperature/i.test(message)
  );
}

async function createChatCompletion(params: ChatCompletionParams): Promise<any> {
  const requestParams =
    String(params.model || "").startsWith("gpt-5.5") && "temperature" in params
      ? (({ temperature: _temperature, ...rest }) => rest)(params as any)
      : params;

  try {
    console.log("[/api/ask] chat model request", { model: requestParams.model });
    return await openai.chat.completions.create(requestParams);
  } catch (error) {
    if ("temperature" in requestParams && shouldRetryWithoutTemperature(error)) {
      const { temperature: _temperature, ...withoutTemperature } = requestParams as any;
      console.warn("[/api/ask] chat model rejected temperature; retrying with default temperature", {
        model: requestParams.model,
      });
      console.log("[/api/ask] chat model request", { model: withoutTemperature.model });
      return openai.chat.completions.create(withoutTemperature);
    }

    if (
      FALLBACK_CHAT_MODEL &&
      requestParams.model !== FALLBACK_CHAT_MODEL &&
      shouldFallbackChatModel(error)
    ) {
      console.warn("[/api/ask] chat model failed; retrying with fallback", {
        model: requestParams.model,
        fallback: FALLBACK_CHAT_MODEL,
        error,
      });
      console.log("[/api/ask] chat model request", { model: FALLBACK_CHAT_MODEL });
      return openai.chat.completions.create({
        ...requestParams,
        model: FALLBACK_CHAT_MODEL,
      });
    }
    throw error;
  }
}

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

async function generateAiSummary(
  query: string,
  answer: string
): Promise<string | null> {
  const trimmed = answer.trim();
  if (!trimmed) return null;
  if (trimmed === "I cannot answer that from the provided code sections.") {
    return null;
  }

  const system = `
You summarize building-code answers into plain language.

Rules:
1) Summarize only what is already stated in the provided answer.
2) Do not add legal interpretation, advice, or "official" wording.
3) Do not invent missing requirements, exceptions, or thresholds.
4) Keep it short: 2 to 5 sentences.
5) Use cautious wording such as "The answer appears to say" or "It appears that".
6) Do not mention sources or citations.
7) Do not quote large blocks of text.
8) If the answer is a numbered list, preserve the main list structure in a compact way.
  `.trim();

  const user = `Question:\n${query}\n\nExact answer to summarize:\n${trimmed}`;

  try {
    const res = await createChatCompletion({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    });

    const summary = res.choices[0]?.message?.content?.trim() || "";
    return summary || null;
  } catch (error) {
    console.warn("[/api/ask] AI summary generation failed", error);
    return null;
  }
}


function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isMetadataLine(line: string): boolean {
  return /^(?:PDF_PAGE|SECTION_ID|SECTION|TITLE|CAPTION|TABLE_ID|SOURCE_URL|EFFECTIVE_DATE|UTAH_CATCHLINE):/.test(
    line.trim()
  );
}

function isSubheadingLine(line: string): boolean {
  const t = normalizeWhitespace(line);
  if (!t) return false;
  return /^[A-Z][A-Za-z0-9 /&(),.'"-]{1,80}:$/.test(t);
}

function isOrderedListLine(line: string): boolean {
  const t = line.trim();
  return /^(?:\d+\.|[a-z]\.|[A-Z]\.)\s+/.test(t);
}

function readSourceLines(sourcePath: string): Array<{ lineNumber: number; text: string }> | null {
  const resolved = path.resolve(process.cwd(), sourcePath);
  if (!fs.existsSync(resolved)) return null;

  try {
    return fs
      .readFileSync(resolved, "utf8")
      .split(/\r?\n/)
      .map((text, idx) => ({ lineNumber: idx + 1, text: text.replace(/\s+$/g, "") }));
  } catch {
    return null;
  }
}

function findBodyStartIndex(lines: Array<{ lineNumber: number; text: string }>): number {
  for (let i = 0; i < lines.length; i++) {
    const t = normalizeWhitespace(lines[i].text);
    if (!t) continue;
    if (isMetadataLine(t)) continue;
    return i;
  }
  return 0;
}

function extractBlockText(
  lines: Array<{ lineNumber: number; text: string }>,
  startIdx: number,
  endIdx: number
): { excerpt: string; startLine: number; endLine: number } | null {
  const slice = lines.slice(startIdx, endIdx + 1);
  const excerpt = slice.map((line) => line.text).join("\n").trim();
  if (!excerpt) return null;
  return {
    excerpt,
    startLine: slice[0].lineNumber,
    endLine: slice[slice.length - 1].lineNumber,
  };
}

function getWholeSourceBodyExcerpt(
  source: SourceRef
): { excerpt: string; startLine: number; endLine: number } | null {
  const lines = readSourceLines(source.sourcePath);
  if (!lines || lines.length === 0) return null;
  const bodyStart = findBodyStartIndex(lines);
  return extractBlockText(lines, bodyStart, lines.length - 1);
}

type ParsedListBlock = {
  heading: string;
  startLine: number;
  endLine: number;
  items: Array<{ number: number; text: string; startLine: number; endLine: number }>;
};

type ParsedListSection = {
  intro: string;
  introStartLine: number;
  introEndLine: number;
  blocks: ParsedListBlock[];
};

type ParsedAmendmentEdits = {
  scopeHeading: string | null;
  replaceItems: Map<number, string>;
  deleteItems: Set<number>;
  addItems: Array<{ number: number; text: string }>;
};

function parseNumberedListSection(source: SourceRef): ParsedListSection | null {
  const lines = readSourceLines(source.sourcePath);
  if (!lines || lines.length === 0) return null;

  const bodyStart = findBodyStartIndex(lines);
  const bodyLines = lines.slice(bodyStart);
  if (bodyLines.length === 0) return null;

  let firstHeadingIdx = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (isSubheadingLine(bodyLines[i].text) && bodyLines[i + 1] && isOrderedListLine(bodyLines[i + 1].text)) {
      firstHeadingIdx = i;
      break;
    }
  }
  if (firstHeadingIdx === -1) return null;

  const introLines = bodyLines.slice(0, firstHeadingIdx);
  const intro = introLines.map((line) => line.text).join("\n").trim();
  const introStartLine = introLines[0]?.lineNumber ?? bodyLines[0].lineNumber;
  const introEndLine = introLines[introLines.length - 1]?.lineNumber ?? introStartLine;

  const blocks: ParsedListBlock[] = [];
  let i = firstHeadingIdx;
  while (i < bodyLines.length) {
    const line = bodyLines[i];
    if (!(isSubheadingLine(line.text) && bodyLines[i + 1] && isOrderedListLine(bodyLines[i + 1].text))) {
      i += 1;
      continue;
    }

    const heading = normalizeWhitespace(line.text).replace(/:$/, "");
    const blockStartLine = line.lineNumber;
    const items: ParsedListBlock["items"] = [];
    i += 1;

    while (i < bodyLines.length) {
      const current = bodyLines[i];
      if (isSubheadingLine(current.text) && bodyLines[i + 1] && isOrderedListLine(bodyLines[i + 1].text)) {
        break;
      }

      const itemMatch = current.text.trim().match(/^(\d+)\.\s*(.*)$/);
      if (!itemMatch) {
        i += 1;
        continue;
      }

      const itemNumber = Number(itemMatch[1]);
      const itemLines = [itemMatch[2]];
      const itemStartLine = current.lineNumber;
      let itemEndLine = current.lineNumber;
      i += 1;

      while (i < bodyLines.length) {
        const next = bodyLines[i];
        if (next.text.trim().match(/^\d+\.\s+/)) break;
        if (isSubheadingLine(next.text) && bodyLines[i + 1] && isOrderedListLine(bodyLines[i + 1].text)) {
          break;
        }
        itemLines.push(next.text);
        itemEndLine = next.lineNumber;
        i += 1;
      }

      items.push({
        number: itemNumber,
        text: normalizeWhitespace(itemLines.join(" ")),
        startLine: itemStartLine,
        endLine: itemEndLine,
      });
    }

    blocks.push({
      heading,
      startLine: blockStartLine,
      endLine: items[items.length - 1]?.endLine ?? blockStartLine,
      items,
    });
  }

  return blocks.length > 0
    ? { intro, introStartLine, introEndLine, blocks }
    : null;
}

function parseAmendmentEdits(source: SourceRef): ParsedAmendmentEdits {
  const body = getWholeSourceBodyExcerpt(source)?.excerpt || "";
  const normalized = body.replace(/\r\n?/g, "\n");
  const scopeMatch = normalized.match(/under\s+([A-Z][A-Za-z0-9 /&(),.'"-]+),\s+the following changes are made:/i);
  const scopeHeading = scopeMatch?.[1] ? normalizeWhitespace(scopeMatch[1]) : null;

  const replaceItems = new Map<number, string>();
  const deleteItems = new Set<number>();
  const addItems: Array<{ number: number; text: string }> = [];

  for (const match of normalized.matchAll(/Number\s+(\d+)\s+is\s+deleted and replaced with the following:\s*"([^"]+)"/gi)) {
    const itemNumber = Number(match[1]);
    const replacement = normalizeWhitespace(match[2]);
    if (Number.isFinite(itemNumber) && replacement) {
      replaceItems.set(itemNumber, replacement);
    }
  }

  for (const match of normalized.matchAll(/Number\s+(\d+)\s+is\s+deleted\b(?!\s+and\s+replaced)/gi)) {
    const itemNumber = Number(match[1]);
    if (Number.isFinite(itemNumber)) {
      deleteItems.add(itemNumber);
    }
  }

  for (const match of normalized.matchAll(/a new exception is added:\s*"(\d+)\.\s*([^"]+)"/gi)) {
    const itemNumber = Number(match[1]);
    const text = normalizeWhitespace(match[2]);
    if (Number.isFinite(itemNumber) && text) {
      addItems.push({ number: itemNumber, text });
    }
  }

  return { scopeHeading, replaceItems, deleteItems, addItems };
}

function chooseBlockForAdditions(
  blocks: ParsedListBlock[],
  itemNumber: number,
  preferredHeading: string | null
): ParsedListBlock | null {
  if (preferredHeading) {
    const scoped = blocks.find(
      (block) => normalizeWhitespace(block.heading).toLowerCase() === preferredHeading.toLowerCase()
    );
    if (scoped) return scoped;
  }

  let best: ParsedListBlock | null = null;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const block of blocks) {
    const maxNumber = Math.max(...block.items.map((item) => item.number), 0);
    if (maxNumber < itemNumber && itemNumber - maxNumber < bestGap) {
      best = block;
      bestGap = itemNumber - maxNumber;
    }
  }

  return best ?? blocks[0] ?? null;
}

function stripLeadingAmendmentNumber(text: string): string {
  return text.replace(/^\(\d+\)\s*/, "").trim();
}

function cleanupEditedCodeText(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flexiblePhrasePattern(phrase: string): RegExp | null {
  const normalized = normalizeWhitespace(phrase);
  if (!normalized) return null;
  const parts = normalized.split(/\s+/).map(escapeRegExp);
  return new RegExp(parts.join("\\s+"), "i");
}

function replacePhraseOnce(text: string, phrase: string, replacement: string): {
  text: string;
  changed: boolean;
} {
  const pattern = flexiblePhrasePattern(phrase);
  if (!pattern) return { text, changed: false };
  if (!pattern.test(text)) return { text, changed: false };
  return {
    text: text.replace(pattern, replacement),
    changed: true,
  };
}

function deletePhraseOnce(text: string, phrase: string): { text: string; changed: boolean } {
  return replacePhraseOnce(text, phrase, "");
}

function insertAfterPhraseOnce(text: string, anchor: string, insertion: string): {
  text: string;
  changed: boolean;
} {
  const pattern = flexiblePhrasePattern(anchor);
  if (!pattern) return { text, changed: false };
  if (!pattern.test(text)) return { text, changed: false };
  return {
    text: text.replace(pattern, (match) => `${match} ${insertion}`),
    changed: true,
  };
}

function insertBeforePhraseOnce(text: string, anchor: string, insertion: string): {
  text: string;
  changed: boolean;
} {
  const pattern = flexiblePhrasePattern(anchor);
  if (!pattern) return { text, changed: false };
  if (!pattern.test(text)) return { text, changed: false };
  return {
    text: text.replace(pattern, (match) => `${insertion} ${match}`),
    changed: true,
  };
}

function deleteLastSentence(text: string): { text: string; changed: boolean } {
  const trimmed = text.trimEnd();
  const match = trimmed.match(/([\s\S]*?)([^.!?]*[.!?])\s*$/);
  if (!match || !match[1]) return { text, changed: false };
  return { text: match[1].trimEnd(), changed: true };
}

function normalizeQuotedReplacement(text: string): string {
  return normalizeWhitespace(text).replace(/^\d+\.\s+/, "");
}

function sourceFromChunk(chunk: IndexedChunk, sourceId: number): SourceRef {
  const source: SourceRef = {
    sourceId,
    id: chunk.id,
    codebookId: chunk.codebookId,
    codebookLabel: getCodebookDef(chunk.codebookId)?.label ?? chunk.codebookId,
    sourcePath: chunk.sourcePath,
    sectionLabel: buildSourceLabel(chunk),
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  };
  const full = getWholeSourceBodyExcerpt(source);
  if (full) {
    source.startLine = full.startLine;
    source.endLine = full.endLine;
  }
  return source;
}

function buildAmendmentRefsFromSources(
  amendmentSources: SourceRef[],
  usedSources: SourceRef[]
): AmendmentRef[] {
  const sourceIdByPath = new Map(
    usedSources.map((source) => [source.sourcePath, source.sourceId])
  );
  const out: AmendmentRef[] = [];

  for (const source of amendmentSources) {
    const sourceId = sourceIdByPath.get(source.sourcePath);
    if (!sourceId) continue;
    out.push({
      sourceId,
      id: source.id,
      codebookId: source.codebookId,
      codebookLabel: source.codebookLabel,
      sourcePath: source.sourcePath,
      sectionLabel: source.sectionLabel,
      publicUrl: source.publicUrl,
      startLine: source.startLine,
      endLine: source.endLine,
      citation: `[source ${sourceId}, lines ${source.startLine}-${source.endLine}]`,
      fullText: getWholeSourceBodyExcerpt(source)?.excerpt || "",
    });
  }

  return out;
}

function applyGenericAmendmentToText(
  currentText: string,
  amendmentText: string
): { text: string; changed: boolean } {
  let nextText = currentText;
  let changed = false;
  const amendment = stripLeadingAmendmentNumber(amendmentText.replace(/\r\n?/g, "\n"));

  const wholeReplace =
    amendment.match(
      /\b(?:IRC,\s*)?Section\s+[A-Za-z]?\d+(?:\.\d+)*[A-Za-z]?,?\s+is\s+deleted and replaced with the following:\s*"([\s\S]+)"\.?\s*$/i
    ) ||
    amendment.match(/\b(?:IRC,\s*)?Section\s+[A-Za-z]?\d+(?:\.\d+)*[A-Za-z]?,?\s+is\s+amended to read as follows:\s*"([\s\S]+)"\.?\s*$/i);
  if (wholeReplace?.[1]) {
    return { text: cleanupEditedCodeText(wholeReplace[1]), changed: true };
  }

  if (/\b(?:IRC,\s*)?Section\s+[A-Za-z]?\d+(?:\.\d+)*[A-Za-z]?,?\s+is\s+deleted\.?\s*$/i.test(amendment)) {
    return { text: "", changed: true };
  }

  for (const match of amendment.matchAll(
    /\b(?:the\s+)?words?\s+"([^"]+)"\s+(?:are|is)\s+deleted and replaced with\s+(?:the\s+words?\s+)?"([^"]+)"/gi
  )) {
    const applied = replacePhraseOnce(nextText, match[1], match[2]);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  for (const match of amendment.matchAll(
    /\b(?:the\s+)?word\s+"([^"]+)"\s+is\s+replaced with\s+(?:the\s+word\s+)?"([^"]+)"/gi
  )) {
    const applied = replacePhraseOnce(nextText, match[1], match[2]);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  for (const match of amendment.matchAll(
    /\b(?:the\s+)?number\s+"?([^",.;]+)"?\s+is\s+(?:deleted and )?replaced with\s+"?([^",.;]+)"?/gi
  )) {
    const applied = replacePhraseOnce(nextText, match[1], match[2]);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  for (const match of amendment.matchAll(
    /\b(?:the\s+)?words?\s+"([^"]+)"\s+(?:are|is)\s+deleted\b/gi
  )) {
    const applied = deletePhraseOnce(nextText, match[1]);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  for (const match of amendment.matchAll(/\bstrike\s+the\s+words?\s+"([^"]+)"/gi)) {
    const applied = deletePhraseOnce(nextText, match[1]);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  for (const match of amendment.matchAll(
    /\b(?:the\s+)?words?\s+"([^"]+)"\s+(?:are|is)\s+added after\s+(?:the\s+)?words?\s+"([^"]+)"/gi
  )) {
    const applied = insertAfterPhraseOnce(nextText, match[2], match[1]);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  for (const match of amendment.matchAll(
    /\bafter\s+(?:the\s+)?words?\s+"([^"]+)"\s+add\s+(?:the\s+words?\s+)?"([^"]+)"/gi
  )) {
    const applied = insertAfterPhraseOnce(nextText, match[1], match[2]);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  for (const match of amendment.matchAll(
    /\b(?:the\s+)?words?\s+"([^"]+)"\s+(?:are|is)\s+added before\s+(?:the\s+)?words?\s+"([^"]+)"/gi
  )) {
    const applied = insertBeforePhraseOnce(nextText, match[2], match[1]);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  for (const match of amendment.matchAll(
    /\b(?:the\s+following\s+sentence|the\s+following)\s+is\s+added at the end of (?:the\s+)?(?:section|paragraph):\s*"([\s\S]+?)"/gi
  )) {
    nextText = `${nextText.trimEnd()}\n${normalizeWhitespace(match[1])}`;
    changed = true;
  }

  for (const match of amendment.matchAll(
    /\ba\s+new\s+(?:exception|section|subsection|number\s+\d+)\s+is\s+added(?:\s+as\s+follows)?:\s*"([\s\S]+?)"/gi
  )) {
    nextText = `${nextText.trimEnd()}\n${normalizeWhitespace(match[1])}`;
    changed = true;
  }

  for (const match of amendment.matchAll(
    /\bthe\s+following\s+exception\s+is\s+added:\s*"([\s\S]+?)"/gi
  )) {
    nextText = `${nextText.trimEnd()}\n${normalizeWhitespace(match[1])}`;
    changed = true;
  }

  if (/\bthe last sentence is deleted\b/i.test(amendment)) {
    const applied = deleteLastSentence(nextText);
    nextText = applied.text;
    changed = applied.changed || changed;
  }

  const deleteRestMatch = amendment.match(
    /\bafter\s+(?:the\s+)?word\s+"([^"]+)"\s+add\s+"([^"]+)"\s+and\s+delete\s+the\s+rest\s+of\s+the\s+section/i
  );
  if (deleteRestMatch) {
    const anchorPattern = flexiblePhrasePattern(deleteRestMatch[1]);
    if (anchorPattern) {
      const anchorMatch = anchorPattern.exec(nextText);
      if (anchorMatch && anchorMatch.index >= 0) {
        nextText =
          nextText.slice(0, anchorMatch.index + anchorMatch[0].length) +
          ` ${deleteRestMatch[2]}`;
        changed = true;
      }
    }
  }

  return {
    text: cleanupEditedCodeText(nextText),
    changed,
  };
}

function buildAmendedTextSectionAnswer(
  query: string,
  baseChunks: IndexedChunk[],
  allChunks: IndexedChunk[],
  amendmentCodebookId: string | undefined
): { answer: string; sources: SourceRef[]; amendments: AmendmentRef[] } | null {
  if (!amendmentCodebookId) return null;

  const baseSectionIds = extractBaseSectionIdsFromChunks(baseChunks);
  if (baseSectionIds.length === 0) return null;

  for (const sectionId of baseSectionIds) {
    const baseChunk = baseChunks.find((chunk) => getBaseChunkSectionId(chunk) === sectionId);
    if (!baseChunk) continue;

    const amendmentPairs = allChunks
      .map((chunk) => chunk)
      .filter((chunk) => chunk.codebookId === amendmentCodebookId)
      .filter((chunk) => amendmentMentionsTargetSection(chunk, sectionId));
    if (amendmentPairs.length === 0) continue;

    const baseSource = sourceFromChunk(baseChunk, 1);
    const baseBody = getWholeSourceBodyExcerpt(baseSource);
    if (!baseBody?.excerpt) continue;

    const amendmentSources = amendmentPairs.map((chunk, idx) =>
      sourceFromChunk(chunk, idx + 2)
    );

    let amendedText = baseBody.excerpt;
    let anyChanges = false;

    for (const amendmentSource of amendmentSources) {
      const amendmentBody = getWholeSourceBodyExcerpt(amendmentSource)?.excerpt || "";
      const applied = applyGenericAmendmentToText(amendedText, amendmentBody);
      amendedText = applied.text;
      anyChanges = applied.changed || anyChanges;
    }

    if (!anyChanges) continue;

    const sectionLabel = baseSource.sectionLabel || `Section ${sectionId}`;
    const usedSources = dedupeSourceRefs([baseSource, ...amendmentSources]).map((source, idx) => ({
      ...source,
      sourceId: idx + 1,
    }));

    return {
      answer: `${sectionLabel}\n\n${amendedText}`,
      sources: usedSources,
      amendments: buildAmendmentRefsFromSources(amendmentSources, usedSources),
    };
  }

  return null;
}

function buildAmendedCodeAnswer(
  query: string,
  baseChunks: IndexedChunk[],
  allChunks: IndexedChunk[],
  amendmentCodebookId: string | undefined
): { answer: string; sources: SourceRef[]; amendments: AmendmentRef[] } | null {
  return (
    buildMergedNumberedListAnswer(query, baseChunks, allChunks, amendmentCodebookId) ||
    buildAmendedTextSectionAnswer(query, baseChunks, allChunks, amendmentCodebookId)
  );
}

async function buildAiAssistedAmendedCodeAnswer(
  query: string,
  baseChunks: IndexedChunk[],
  allChunks: IndexedChunk[],
  amendmentCodebookId: string | undefined,
  targetSectionIds: string[]
): Promise<{ answer: string; sources: SourceRef[]; amendments: AmendmentRef[] } | null> {
  if (!amendmentCodebookId) return null;
  const uniqueTargets = Array.from(new Set(targetSectionIds));
  if (uniqueTargets.length !== 1) return null;

  const sectionId = uniqueTargets[0];
  const baseChunk = baseChunks.find((chunk) => {
    const chunkSectionId = getBaseChunkSectionId(chunk);
    return chunkSectionId ? sectionMatchesExactly(chunkSectionId, sectionId) : false;
  });
  if (!baseChunk) return null;

  const amendmentChunks = allChunks
    .filter((chunk) => chunk.codebookId === amendmentCodebookId)
    .filter((chunk) => amendmentMentionsTargetSection(chunk, sectionId));
  if (amendmentChunks.length === 0) return null;

  const baseSource = sourceFromChunk(baseChunk, 1);
  const amendmentSources = amendmentChunks.map((chunk, idx) => sourceFromChunk(chunk, idx + 2));
  const baseText = getWholeSourceBodyExcerpt(baseSource)?.excerpt || baseChunk.content || "";
  if (!baseText.trim()) return null;

  const amendmentText = amendmentSources
    .map((source, idx) => {
      const text = getWholeSourceBodyExcerpt(source)?.excerpt || amendmentChunks[idx]?.content || "";
      return `Amendment ${idx + 1}:\n${text}`;
    })
    .join("\n\n---\n\n");

  const system = `
You compose an AI-assisted amended-code draft from provided building-code text.

Rules:
1) Use only the base section text and amendment text provided.
2) Apply amendments as literally as possible.
3) Preserve section labels, headings, and numbered lists when possible.
4) Do not add legal advice, interpretation, examples, or commentary.
5) If the base text is incomplete or too damaged to merge perfectly, still produce the best amended draft and put a short explanation in mergeNotes.
6) Return JSON only.
  `.trim();

  const user =
    `User question:\n${query}\n\n` +
    `Target section:\n${sectionId}\n\n` +
    `Base section text:\n${baseText}\n\n` +
    `Amendments to apply:\n${amendmentText}\n\n` +
    `Return JSON in this shape:\n` +
    `{ "amendedText": "...", "mergeNotes": ["..."] }`;

  try {
    const response = await createChatCompletion({
      model: CHAT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const parsed = extractJsonObject(raw);
    const amendedText = typeof parsed?.amendedText === "string" ? parsed.amendedText.trim() : "";
    if (!amendedText) return null;

    const mergeNotes: string[] = Array.isArray(parsed?.mergeNotes)
      ? parsed.mergeNotes
          .filter((note: unknown): note is string => typeof note === "string" && note.trim().length > 0)
          .map((note: string) => note.trim())
      : [];
    const usedSources = dedupeSourceRefs([baseSource, ...amendmentSources]).map((source, idx) => ({
      ...source,
      sourceId: idx + 1,
    }));

    const lines = [
      "AI-assisted amended code draft. Verify against the listed base and amendment sources.",
      "",
      baseSource.sectionLabel || `Section ${sectionId}`,
      "",
      amendedText,
    ];
    if (mergeNotes.length > 0) {
      lines.push("", "Merge notes:", ...mergeNotes.map((note) => `- ${note}`));
    }

    return {
      answer: lines.join("\n"),
      sources: usedSources,
      amendments: buildAmendmentRefsFromSources(amendmentSources, usedSources),
    };
  } catch (error) {
    console.warn("[/api/ask] AI-assisted amended-code merge failed", error);
    return null;
  }
}

function buildMergedNumberedListAnswer(
  query: string,
  baseChunks: IndexedChunk[],
  allChunks: IndexedChunk[],
  amendmentCodebookId: string | undefined
): { answer: string; sources: SourceRef[]; amendments: AmendmentRef[] } | null {
  if (!amendmentCodebookId) return null;

  const baseSectionIds = extractBaseSectionIdsFromChunks(baseChunks);
  if (baseSectionIds.length === 0) return null;

  const queryLower = query.toLowerCase();

  for (const sectionId of baseSectionIds) {
    const baseChunk = baseChunks.find((chunk) => getBaseChunkSectionId(chunk) === sectionId);
    if (!baseChunk) continue;

    const baseSource: SourceRef = {
      sourceId: 1,
      id: baseChunk.id,
      codebookId: baseChunk.codebookId,
      codebookLabel: getCodebookDef(baseChunk.codebookId)?.label ?? baseChunk.codebookId,
      sourcePath: baseChunk.sourcePath,
      sectionLabel: buildSourceLabel(baseChunk),
      startLine: baseChunk.startLine,
      endLine: baseChunk.endLine,
    };

    const parsedBase = parseNumberedListSection(baseSource);
    if (!parsedBase) continue;

    const amendmentPairs = allChunks
      .map((chunk, idx) => ({ chunk, sourceId: idx + 1 }))
      .filter(({ chunk }) => chunk.codebookId === amendmentCodebookId)
      .filter(({ chunk }) => amendmentMentionsTargetSection(chunk, sectionId));

    if (amendmentPairs.length === 0) continue;

    const amendmentSources: SourceRef[] = amendmentPairs.map(({ chunk, sourceId }) => {
      const source: SourceRef = {
        sourceId,
        id: chunk.id,
        codebookId: chunk.codebookId,
        codebookLabel: getCodebookDef(chunk.codebookId)?.label ?? chunk.codebookId,
        sourcePath: chunk.sourcePath,
        sectionLabel: buildSourceLabel(chunk),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      };
      const full = getWholeSourceBodyExcerpt(source);
      if (full) {
        source.startLine = full.startLine;
        source.endLine = full.endLine;
      }
      return source;
    });

    const amendedBlocks: ParsedListBlock[] = parsedBase.blocks.map((block) => ({
      heading: block.heading,
      startLine: block.startLine,
      endLine: block.endLine,
      items: block.items.map((item) => ({ ...item })),
    }));

    let anyChanges = false;
    let preferredHeading: string | null =
      amendedBlocks.find((block) => queryLower.includes(block.heading.toLowerCase()))?.heading ?? null;

    for (const amendmentSource of amendmentSources) {
      const edits = parseAmendmentEdits(amendmentSource);
      if (edits.scopeHeading && !preferredHeading) {
        preferredHeading = edits.scopeHeading;
      }

      const targetBlocks =
        edits.scopeHeading
          ? amendedBlocks.filter(
              (block) =>
                normalizeWhitespace(block.heading).toLowerCase() ===
                normalizeWhitespace(edits.scopeHeading || "").toLowerCase()
            )
          : amendedBlocks;

      const appliedReplacements = new Set<number>();

      for (const block of targetBlocks) {
        block.items = block.items
          .filter((item) => !edits.deleteItems.has(item.number))
          .map((item) => {
            const replacement = edits.replaceItems.get(item.number);
            if (!replacement) return item;
            anyChanges = true;
            appliedReplacements.add(item.number);
            const normalizedReplacement = replacement.match(/^\d+\.\s+/)
              ? replacement.replace(/^\d+\.\s+/, "")
              : replacement;
            return { ...item, text: normalizedReplacement };
          });
        if (edits.deleteItems.size > 0) {
          anyChanges = true;
        }
      }

      for (const [itemNumber, replacement] of edits.replaceItems.entries()) {
        if (appliedReplacements.has(itemNumber)) continue;
        const block = chooseBlockForAdditions(
          amendedBlocks,
          itemNumber,
          edits.scopeHeading || preferredHeading
        );
        if (!block) continue;
        const normalizedReplacement = replacement.match(/^\d+\.\s+/)
          ? replacement.replace(/^\d+\.\s+/, "")
          : replacement;
        block.items.push({
          number: itemNumber,
          text: normalizedReplacement,
          startLine: amendmentSource.startLine,
          endLine: amendmentSource.endLine,
        });
        block.items.sort((a, b) => a.number - b.number);
        anyChanges = true;
      }

      for (const add of edits.addItems) {
        const block = chooseBlockForAdditions(amendedBlocks, add.number, edits.scopeHeading || preferredHeading);
        if (!block) continue;
        if (!block.items.some((item) => item.number === add.number)) {
          block.items.push({
            number: add.number,
            text: add.text,
            startLine: amendmentSource.startLine,
            endLine: amendmentSource.endLine,
          });
          block.items.sort((a, b) => a.number - b.number);
          anyChanges = true;
        }
      }
    }

    if (!anyChanges) continue;

    const targetBlock =
      preferredHeading
        ? amendedBlocks.find(
            (block) =>
              normalizeWhitespace(block.heading).toLowerCase() === preferredHeading!.toLowerCase()
          )
        : amendedBlocks[0];
    if (!targetBlock) continue;

    const baseBody = getWholeSourceBodyExcerpt(baseSource);
    if (baseBody) {
      baseSource.startLine = baseBody.startLine;
      baseSource.endLine = baseBody.endLine;
    }

    const answerLines: string[] = [];
    const sectionLabel = baseSource.sectionLabel || `Section ${sectionId}`;
    answerLines.push(sectionLabel);
    answerLines.push("");
    if (parsedBase.intro) {
      answerLines.push(parsedBase.intro);
      answerLines.push("");
    }
    answerLines.push(`${targetBlock.heading}:`);
    for (const item of targetBlock.items) {
      answerLines.push(`${item.number}. ${item.text}`);
    }

    const usedSources = dedupeSourceRefs([baseSource, ...amendmentSources]).map((source, idx) => ({
      ...source,
      sourceId: idx + 1,
    }));
    const sourceIdByPath = new Map(
      usedSources.map((source) => [source.sourcePath, source.sourceId])
    );

    const amendments: AmendmentRef[] = [];
    for (const source of amendmentSources) {
      const sourceId = sourceIdByPath.get(source.sourcePath);
      if (!sourceId) continue;
      amendments.push({
        sourceId,
        id: source.id,
        codebookId: source.codebookId,
        codebookLabel: source.codebookLabel,
        sourcePath: source.sourcePath,
        sectionLabel: source.sectionLabel,
        startLine: source.startLine,
        endLine: source.endLine,
        citation: `[source ${sourceId}, lines ${source.startLine}-${source.endLine}]`,
        fullText: getWholeSourceBodyExcerpt(source)?.excerpt || "",
      });
    }

    return {
      answer: answerLines.join("\n"),
      sources: usedSources,
      amendments,
    };
  }

  return null;
}

function findPreferredSourceExcerpt(
  source: SourceRef,
  excerpt: string
): { excerpt: string; startLine: number; endLine: number } | null {
  const lines = readSourceLines(source.sourcePath);
  if (!lines || lines.length === 0) return null;

  const normalizedExcerpt = normalizeWhitespace(excerpt);
  if (!normalizedExcerpt) return null;

  const bodyStart = findBodyStartIndex(lines);
  const contentLines = lines.slice(bodyStart);

  for (let i = 0; i < contentLines.length; i++) {
    if (!isSubheadingLine(contentLines[i].text)) continue;
    if (i + 1 >= contentLines.length || !isOrderedListLine(contentLines[i + 1].text)) continue;

    let end = i + 1;
    while (end + 1 < contentLines.length) {
      const next = contentLines[end + 1];
      const nextNext = contentLines[end + 2];
      if (
        isSubheadingLine(next.text) &&
        nextNext &&
        isOrderedListLine(nextNext.text)
      ) {
        break;
      }
      end += 1;
    }

    const block = extractBlockText(contentLines, i, end);
    if (!block) continue;
    if (normalizeWhitespace(block.excerpt).includes(normalizedExcerpt)) {
      return block;
    }
  }

  const bodyBlock = extractBlockText(contentLines, 0, contentLines.length - 1);
  if (!bodyBlock) return null;
  if (normalizeWhitespace(bodyBlock.excerpt).includes(normalizedExcerpt)) {
    return bodyBlock;
  }

  return null;
}

function expandSelectedAgainstSourceFiles(
  selected: SelectorResult,
  sources: SourceRef[]
): { selected: SelectorResult; sources: SourceRef[] } {
  const clonedSources = sources.map((source) => ({ ...source }));
  const seenByKey = new Set<string>();

  const expandedSections = selected.sections
    .map((section) => {
      const items: ExpandedQuote[] = [];

      for (const item of section.items) {
        const source = clonedSources[item.sourceId - 1];
        const expanded =
          source && !source.isTable
            ? findPreferredSourceExcerpt(source, item.excerpt)
            : null;

        const nextItem: ExpandedQuote = expanded
          ? {
              sourceId: item.sourceId,
              excerpt: expanded.excerpt,
              startLine: expanded.startLine,
              endLine: expanded.endLine,
            }
          : item;

        if (expanded && source) {
          source.startLine = expanded.startLine;
          source.endLine = expanded.endLine;
        }

        const key = `${item.sourceId}:${normalizeWhitespace(nextItem.excerpt)}`;
        if (seenByKey.has(key)) continue;
        seenByKey.add(key);
        items.push(nextItem);
      }

      return {
        title: section.title,
        items,
      };
    })
    .filter((section) => section.items.length > 0);

  return {
    selected: { sections: expandedSections },
    sources: clonedSources,
  };
}

function forceIncludeMatchedAmendments(
  selected: SelectorResult,
  sources: SourceRef[],
  chunks: IndexedChunk[],
  targetSectionIds: string[]
): { selected: SelectorResult; sources: SourceRef[] } {
  if (targetSectionIds.length === 0) {
    return { selected, sources };
  }

  const wanted = new Set(targetSectionIds);
  const outSources = sources.map((source) => ({ ...source }));
  const sections = selected.sections.map((section) => ({
    title: section.title,
    items: [...section.items],
  }));
  const existingIds = new Set(
    sections.flatMap((section) => section.items.map((item) => item.sourceId))
  );

  const forcedItems: ExpandedQuote[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.codebookId !== "irc-utah-2021-amendments") continue;
    const info = getAmendmentInfo(chunk);
    if (!info.targetSectionId || !wanted.has(info.targetSectionId)) continue;

    const sourceId = i + 1;
    if (existingIds.has(sourceId)) continue;

    const source = outSources[sourceId - 1];
    if (!source) continue;

    const wholeBody = getWholeSourceBodyExcerpt(source);
    if (wholeBody) {
      source.startLine = wholeBody.startLine;
      source.endLine = wholeBody.endLine;
      forcedItems.push({
        sourceId,
        excerpt: wholeBody.excerpt,
        startLine: wholeBody.startLine,
        endLine: wholeBody.endLine,
      });
    } else {
      forcedItems.push({
        sourceId,
        excerpt: chunk.content,
      });
    }
    existingIds.add(sourceId);
  }

  if (forcedItems.length === 0) {
    return { selected, sources: outSources };
  }

  const amendmentTitle =
    targetSectionIds.length === 1
      ? `Amendments to Section ${targetSectionIds[0]}`
      : "Amendments";

  sections.push({
    title: amendmentTitle,
    items: forcedItems,
  });

  return {
    selected: { sections },
    sources: outSources,
  };
}

function buildExtractiveAnswerFromSelected(
  selected: SelectorResult,
  sources: SourceRef[]
): string | null {
  const out: string[] = [];

  for (const section of selected.sections) {
    out.push(section.title);
    out.push("");

    for (const item of section.items) {
      const src = sources[item.sourceId - 1];
      if (!src) continue;
      out.push(`[source ${item.sourceId}, lines ${src.startLine}-${src.endLine}]`);
      out.push(item.excerpt);
      out.push("");
    }
  }

  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.length > 0 ? out.join("\n") : null;
}

function shouldPreferExtractiveAnswer(selected: SelectorResult): boolean {
  return selected.sections.some((section) =>
    section.items.some(
      (item) =>
        item.excerpt.length > 350 ||
        item.excerpt.split(/\r?\n/).some((line) => isOrderedListLine(line))
    )
  );
}

function extractExplicitTableRef(query: string): string | null {
  const match = normalizeWhitespace(query).match(
    /\btable\s+([A-Za-z]?\d+(?:\.\d+)*(?:\([0-9A-Za-z]+\))?)/i
  );
  return match?.[1] ? match[1].toUpperCase() : null;
}

function extractExplicitSectionRef(query: string): string | null {
  const text = normalizeWhitespace(query);
  const labeled = text.match(/\b(?:section|sec\.?|§)\s+([A-Za-z]?\d+(?:\.\d+)*)/i);
  const raw = labeled?.[1] ?? text.match(/\b([RPEGMN]\d{3,}(?:\.\d+)*)\b/i)?.[1];
  return raw ? normalizeIrcSectionId(raw) : null;
}

function extractBaseSectionIdsFromChunks(chunks: IndexedChunk[]): string[] {
  const ids = new Set<string>();

  for (const chunk of chunks) {
    const normalizedChunkId = getBaseChunkSectionId(chunk);
    if (normalizedChunkId) {
      ids.add(normalizedChunkId);
    }
  }

  return Array.from(ids);
}

function normalizeSectionForMatch(value: string | null | undefined): string | null {
  const normalized = value ? normalizeIrcSectionId(value) : null;
  if (!normalized) return null;
  return normalized.toUpperCase();
}

function sectionNumberPart(value: string | null | undefined): string | null {
  const normalized = normalizeSectionForMatch(value);
  if (!normalized) return null;
  return normalized.replace(/^[A-Z]+/, "");
}

function sectionMatchesTarget(candidate: string | null | undefined, target: string): boolean {
  const normalizedCandidate = normalizeSectionForMatch(candidate);
  const normalizedTarget = normalizeSectionForMatch(target);
  if (!normalizedCandidate || !normalizedTarget) return false;
  if (normalizedCandidate === normalizedTarget) return true;
  const candidateNumber = sectionNumberPart(normalizedCandidate);
  const targetNumber = sectionNumberPart(normalizedTarget);
  return Boolean(candidateNumber && targetNumber && candidateNumber === targetNumber);
}

function sectionMatchesExactly(candidate: string | null | undefined, target: string): boolean {
  const normalizedCandidate = normalizeSectionForMatch(candidate);
  const normalizedTarget = normalizeSectionForMatch(target);
  return Boolean(normalizedCandidate && normalizedTarget && normalizedCandidate === normalizedTarget);
}

function compareSectionNumber(a: string, b: string): number {
  const aParts = (sectionNumberPart(a) || "").split(".").map((part) => Number.parseInt(part, 10));
  const bParts = (sectionNumberPart(b) || "").split(".").map((part) => Number.parseInt(part, 10));
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = Number.isFinite(aParts[i]) ? aParts[i] : 0;
    const bv = Number.isFinite(bParts[i]) ? bParts[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function sectionRangeIncludes(start: string, end: string, target: string): boolean {
  const normalizedStart = normalizeSectionForMatch(start);
  const normalizedEnd = normalizeSectionForMatch(end);
  const normalizedTarget = normalizeSectionForMatch(target);
  if (!normalizedStart || !normalizedEnd || !normalizedTarget) return false;
  const startPrefix = normalizedStart.match(/^[A-Z]+/)?.[0] || "";
  const endPrefix = normalizedEnd.match(/^[A-Z]+/)?.[0] || startPrefix;
  const targetPrefix = normalizedTarget.match(/^[A-Z]+/)?.[0] || startPrefix;
  if (startPrefix && targetPrefix && startPrefix !== targetPrefix && endPrefix !== targetPrefix) {
    return false;
  }
  return (
    compareSectionNumber(normalizedStart, normalizedTarget) <= 0 &&
    compareSectionNumber(normalizedTarget, normalizedEnd) <= 0
  );
}

function amendmentMentionsTargetSection(chunk: IndexedChunk, targetSectionId: string): boolean {
  const info = getAmendmentInfo(chunk);
  if (info.targetSectionId && sectionMatchesTarget(info.targetSectionId, targetSectionId)) {
    return true;
  }

  const haystack = `${chunk.sourcePath || ""}\n${chunk.content || ""}`;
  const targetNumber = sectionNumberPart(targetSectionId);
  if (!targetNumber) return false;

  const directSectionPattern = new RegExp(
    `\\b(?:Section|Sections|IRC Section|IRC, Section)\\s+[A-Z]?${targetNumber.replace(/\./g, "\\.")}\\b`,
    "i"
  );
  if (directSectionPattern.test(haystack)) return true;

  const filenamePattern = new RegExp(
    `[_\\s(][A-Z]?${targetNumber.replace(/\./g, "\\.")}(?:[_)\\s.]|$)`,
    "i"
  );
  if (filenamePattern.test(haystack)) return true;

  for (const match of haystack.matchAll(
    /\bSections?\s+([A-Za-z]?\d+(?:\.\d+)*)\s+through\s+([A-Za-z]?\d+(?:\.\d+)*)/gi
  )) {
    if (sectionRangeIncludes(match[1], match[2], targetSectionId)) return true;
  }

  return false;
}

function getBaseChunkSectionId(chunk: IndexedChunk): string | null {
  const meta = (chunk as any).meta ?? {};
  const rawMetaId =
    typeof meta.sectionId === "string"
      ? meta.sectionId
      : typeof meta.sectionLabel === "string"
      ? meta.sectionLabel
      : null;

  const normalizedMetaId = rawMetaId
    ? normalizeIrcSectionId(
        rawMetaId.replace(/^Section\s+/i, "").split(/\s+-\s+/, 1)[0].trim()
      )
    : null;
  if (normalizedMetaId) {
    return normalizedMetaId;
  }

  const baseName = path.basename(chunk.sourcePath || "", path.extname(chunk.sourcePath || ""));
  const match = baseName.match(/section_([A-Za-z]?\d+(?:\.\d+)*)/i);
  const normalizedPathId = match?.[1] ? normalizeIrcSectionId(match[1]) : null;
  if (normalizedPathId) {
    return normalizedPathId;
  }

  const firstLine = String(chunk.content || "")
    .split(/\r?\n/, 1)[0]
    ?.trim();
  const firstLineMatch = firstLine?.match(/^([A-Za-z]?\d+(?:\.\d+)*)\b/);
  const normalizedFirstLineId = firstLineMatch?.[1]
    ? normalizeIrcSectionId(firstLineMatch[1])
    : null;
  if (normalizedFirstLineId) {
    return normalizedFirstLineId;
  }

  return null;
}

function buildSourceLabel(chunk: IndexedChunk): string | undefined {
  const meta = (chunk as any).meta ?? {};
  const explicitLabel =
    typeof meta.sectionLabel === "string"
      ? meta.sectionLabel
      : typeof meta.header === "string"
      ? meta.header
      : undefined;
  if (explicitLabel) return explicitLabel;

  const inferredSectionId = getBaseChunkSectionId(chunk);
  if (inferredSectionId) {
    return `Section ${inferredSectionId}`;
  }

  const tableAsset = getTableAssetInfoForSource({
    codebookId: chunk.codebookId,
    sourcePath: chunk.sourcePath,
    meta,
  });
  if (tableAsset?.tableLabel) {
    return tableAsset.tableLabel;
  }

  return undefined;
}

function findAmendmentChunksByBaseSections(
  amendmentCodebookId: string,
  baseChunks: IndexedChunk[],
): IndexedChunk[] {
  const targetSectionIds = new Set(extractBaseSectionIdsFromChunks(baseChunks));
  if (targetSectionIds.size === 0) return [];

  try {
    const amendmentIndex = loadCodebookIndex(amendmentCodebookId);
    const matched = amendmentIndex.filter((chunk) => {
      for (const targetSectionId of targetSectionIds) {
        if (amendmentMentionsTargetSection(chunk, targetSectionId)) return true;
      }
      return false;
    });
    return dedupeChunks(matched);
  } catch (error) {
    console.warn("[/api/ask] amendment by base-section lookup failed", {
      amendmentCodebookId,
      targetSectionIds: Array.from(targetSectionIds),
      error,
    });
    return [];
  }
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

function findExplicitSectionChunks(
  codebookId: string,
  sectionRef: string,
  limit = 8
): IndexedChunk[] {
  try {
    const chunks = loadCodebookIndex(codebookId);
    return dedupeChunks(
      chunks.filter((chunk) => {
        const sectionId = getBaseChunkSectionId(chunk);
        return sectionId ? sectionMatchesExactly(sectionId, sectionRef) : false;
      })
    ).slice(0, limit);
  } catch (error) {
    console.warn("[/api/ask] explicit section lookup failed", {
      codebookId,
      sectionRef,
      error,
    });
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
      const excerpt = bestExcerpt.slice(0, 6000).trim();
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
      if (ex.length > 6000) {
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
  return buildExtractiveAnswerFromSelected(selected, sources);
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
    const tableAsset = getTableAssetInfoForSource({
      codebookId: chunk.codebookId,
      sourcePath: chunk.sourcePath,
      meta,
    });
    const sectionLabel = buildSourceLabel(chunk) || tableAsset?.tableLabel || undefined;

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

    const tableAsset = getTableAssetInfoForSource({
      codebookId: chunk.codebookId,
      sourcePath: chunk.sourcePath,
      meta,
    });
    const sectionLabel = buildSourceLabel(chunk) || tableAsset?.tableLabel || undefined;

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
  const explicitSectionRef = extractExplicitSectionRef(query);
  console.log("[/api/ask] structuralRef", structuralRef);
  console.log("[/api/ask] explicitTableRef", explicitTableRef);
  console.log("[/api/ask] explicitSectionRef", explicitSectionRef);

  // ----------------------------
  // Retrieve base + amendments
  // ----------------------------
  const amendmentCodebookId = AMENDMENT_MAP[baseCodebookId];
  console.log("[/api/ask] amendment mapping", {
    baseDefExists: Boolean(baseDef),
    baseDefIsAmendment: Boolean(baseDef?.isAmendment),
    amendmentCodebookId,
  });

  const searchedBaseChunks = await searchCodebook({
    query: effectiveQuery,
    codebookId: baseCodebookId,
    topK,
  });

  const explicitSectionChunks =
    explicitSectionRef !== null
      ? findExplicitSectionChunks(baseCodebookId, explicitSectionRef, topK)
      : [];

  const baseChunks = dedupeChunks([
    ...explicitSectionChunks,
    ...searchedBaseChunks,
  ]);

  const explicitTableChunks =
    explicitTableRef !== null
      ? findExplicitTableChunks(baseCodebookId, explicitTableRef, topK)
      : [];
  const amendmentAnchorChunks =
    explicitSectionChunks.length > 0 ? explicitSectionChunks : baseChunks;
  const baseSectionIds = extractBaseSectionIdsFromChunks(amendmentAnchorChunks);

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

        const baseAnchoredAmendmentChunks = findAmendmentChunksByBaseSections(
          amendmentCodebookId,
          amendmentAnchorChunks
        );

        const deterministicAmendmentChunks = dedupeChunks([
          ...structuralAmendmentChunks,
          ...baseAnchoredAmendmentChunks,
        ]);

        if (deterministicAmendmentChunks.length > 0) {
          amendmentChunks = deterministicAmendmentChunks;
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
    console.log("[/api/ask] amendment target sections", baseSectionIds);
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
      const sectionId = getBaseChunkSectionId(chunk);
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

  const amendedCodeAnswer = buildAmendedCodeAnswer(
    query,
    filteredBaseChunks,
    allChunks,
    amendmentCodebookId
  );
  if (amendedCodeAnswer) {
    const aiSummary = await generateAiSummary(query, amendedCodeAnswer.answer);
    console.log("[/api/ask] summary", {
      baseChunks: baseChunks.length,
      amendmentChunks: amendmentChunks.length,
      allChunks: allChunks.length,
      selectorSelected: false,
      reason: "deterministic amended-code merge",
    });

    return NextResponse.json(
      {
        ok: true,
        query,
        codebookId: baseCodebookId,
        answer: amendedCodeAnswer.answer,
        aiSummary,
        aiSummaryDisclaimer: aiSummary ? SUMMARY_DISCLAIMER : null,
        sources: amendedCodeAnswer.sources,
        amendments: amendedCodeAnswer.amendments,
      },
      { status: 200 }
    );
  }

  const aiAssistedAmendedCodeAnswer = await buildAiAssistedAmendedCodeAnswer(
    query,
    filteredBaseChunks,
    allChunks,
    amendmentCodebookId,
    baseSectionIds
  );
  if (aiAssistedAmendedCodeAnswer) {
    const aiSummary = await generateAiSummary(
      query,
      aiAssistedAmendedCodeAnswer.answer
    );
    console.log("[/api/ask] summary", {
      baseChunks: baseChunks.length,
      amendmentChunks: amendmentChunks.length,
      allChunks: allChunks.length,
      selectorSelected: false,
      reason: "ai-assisted amended-code merge",
    });

    return NextResponse.json(
      {
        ok: true,
        query,
        codebookId: baseCodebookId,
        answer: aiAssistedAmendedCodeAnswer.answer,
        aiSummary,
        aiSummaryDisclaimer: aiSummary ? SUMMARY_DISCLAIMER : null,
        sources: aiAssistedAmendedCodeAnswer.sources,
        amendments: aiAssistedAmendedCodeAnswer.amendments,
      },
      { status: 200 }
    );
  }

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
    9) If a relevant excerpt is part of a numbered or lettered list, prefer the ENTIRE list block from its heading through the last list item before the next heading.
    10) Otherwise, prefer the full relevant subsection/body text over a tiny snippet.

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
    const sel = await createChatCompletion({
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

  const expanded = expandSelectedAgainstSourceFiles(selected, srcs);
  const forced = forceIncludeMatchedAmendments(
    expanded.selected,
    expanded.sources,
    allChunks,
    baseSectionIds
  );
  selected = forced.selected;
  const answerSources = forced.sources;

  const organizedAnswer = renderOrganizedQuotes(selected, answerSources);
  const preferExtractiveAnswer = shouldPreferExtractiveAnswer(selected);

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

  if (!preferExtractiveAnswer) {
    try {
      const ans = await createChatCompletion({
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
  }

  // 🔒 ENFORCEMENT GOES HERE (after model runs)
  if (!preferExtractiveAnswer && !validateFinalAnswerOrFail(finalAnswer)) {
    const fallback = buildFallbackAnswerFromSelected(selected, answerSources);
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
          answerSources,
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
  const aiSummary = await generateAiSummary(query, finalAnswer);

  const res: AskResponse = {
    ok: true,
    query,
    codebookId: baseCodebookId,
    answer: finalAnswer,
    aiSummary,
    aiSummaryDisclaimer: aiSummary ? SUMMARY_DISCLAIMER : null,
    sources: usedSources,
    amendments: amendmentRefs,
  };


  return NextResponse.json(res, { status: 200 });
}
