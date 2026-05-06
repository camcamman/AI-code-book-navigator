import fs from "node:fs";
import path from "node:path";
import { getCodebookDef } from "./codebookRegistry";
import { IndexedChunk, loadCodebookIndex } from "./searchCodebook";

export type DefinitionMatchReason = "query" | "answer";

export type DefinitionSource = {
  id: string;
  codebookId: string;
  codebookLabel: string;
  sourcePath: string;
  sectionLabel?: string;
  publicUrl?: string;
  startLine: number;
  endLine: number;
  fullText?: string;
};

export type DefinitionRef = {
  term: string;
  definition: string;
  baseDefinition?: string | null;
  amendedDefinition?: string | null;
  isAmended: boolean;
  matchReason: DefinitionMatchReason;
  source?: DefinitionSource;
  amendmentSources: DefinitionSource[];
  mergeNotes?: string[];
};

type DefinitionRegistryEntry = Omit<DefinitionRef, "matchReason"> & {
  normalizedTerm: string;
  rank: number;
};

type DefinitionRegistry = {
  entries: DefinitionRegistryEntry[];
  byTerm: Map<string, DefinitionRegistryEntry>;
};

const registryCache = new Map<string, DefinitionRegistry>();

const STOP_TERMS = new Set([
  "ABOUT",
  "ACCORDING",
  "AFTER",
  "AMENDMENT",
  "ANSWER",
  "ARE",
  "BUILDING",
  "CODE",
  "COULD",
  "DEFINE",
  "DEFINITION",
  "DOES",
  "FROM",
  "HAVE",
  "MEAN",
  "PLEASE",
  "REQUIRE",
  "REQUIRES",
  "RULE",
  "RULES",
  "SECTION",
  "SAY",
  "TELL",
  "THAT",
  "THE",
  "THIS",
  "WHAT",
  "WHEN",
  "WHERE",
  "WHICH",
  "WITH",
]);

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isMetadataLine(line: string): boolean {
  return /^(?:PDF_PAGE|SECTION_ID|SECTION|TITLE|CAPTION|TABLE_ID|SOURCE_URL|EFFECTIVE_DATE|UTAH_CATCHLINE):/i.test(
    line.trim()
  );
}

function normalizeDefinitionTerm(term: string): string {
  return normalizeWhitespace(term)
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s*[:.]\s*$/g, "")
    .toUpperCase();
}

function definitionKey(term: string): string {
  return normalizeDefinitionTerm(term).replace(/[^A-Z0-9]/g, "");
}

function validDefinitionTerm(term: string): boolean {
  const normalized = normalizeDefinitionTerm(term);
  if (normalized.length < 3 || normalized.length > 90) return false;
  if (/^[A-Z]?\d+(?:\.\d+)*$/.test(normalized)) return false;
  if (/\.\s*\./.test(normalized)) return false;
  if (/\b[A-Z]?\d{3,}(?:\.\d+)*\b/.test(normalized)) return false;
  if (/^(?:SECTION|TABLE|FIGURE|CHAPTER|PART|PDF_PAGE|ROWS|COLUMNS)\b/.test(normalized)) {
    return false;
  }
  const letters = normalized.replace(/[^A-Z]/g, "");
  if (letters.length < 3) return false;
  if (STOP_TERMS.has(normalized)) return false;
  return true;
}

function parseDefinitionStart(line: string):
  | { term: string; firstDefinitionLine: string }
  | null {
  const trimmed = line.trim();
  if (!trimmed || isMetadataLine(trimmed)) return null;
  if (/^[A-Z]?\d{2,}(?:\.\d+)*\b/.test(trimmed)) return null;

  const match = trimmed.match(
    /^([A-Z][A-Z0-9 /(),.'"%&-]{2,90})\s*[:.]\s*(.*)$/
  );
  if (!match) return null;

  const term = normalizeDefinitionTerm(match[1]);
  if (!validDefinitionTerm(term)) return null;
  return {
    term,
    firstDefinitionLine: match[2]?.trim() || "",
  };
}

function readLines(sourcePath: string): string[] | null {
  const resolved = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(process.cwd(), sourcePath);
  if (!fs.existsSync(resolved)) return null;
  try {
    return fs.readFileSync(resolved, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

function getLineRangeText(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join("\n").trim();
}

function bodyStartIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeWhitespace(lines[i] || "");
    if (!line) continue;
    if (isMetadataLine(line)) continue;
    return i;
  }
  return 0;
}

function chunkForSourcePath(chunks: IndexedChunk[], sourcePath: string): IndexedChunk | null {
  return chunks.find((chunk) => chunk.sourcePath === sourcePath) ?? null;
}

function sourceLabelForChunk(chunk: IndexedChunk | null): string | undefined {
  const meta = (chunk as any)?.meta ?? {};
  const sectionLabel =
    typeof meta.sectionLabel === "string"
      ? meta.sectionLabel
      : typeof meta.header === "string"
      ? meta.header
      : typeof meta.sectionId === "string"
      ? `Section ${meta.sectionId}`
      : undefined;
  return sectionLabel;
}

function publicUrlForChunk(chunk: IndexedChunk | null, lines: string[]): string | undefined {
  const meta = (chunk as any)?.meta ?? {};
  if (typeof meta.publicUrl === "string") return meta.publicUrl;
  const urlLine = lines.find((line) => line.startsWith("SOURCE_URL:"));
  return urlLine ? urlLine.replace(/^SOURCE_URL:\s*/i, "").trim() : undefined;
}

function sourceFromRange(
  codebookId: string,
  sourcePath: string,
  startLine: number,
  endLine: number,
  chunks: IndexedChunk[],
  lines: string[]
): DefinitionSource {
  const chunk = chunkForSourcePath(chunks, sourcePath);
  return {
    id: chunk?.id || `${codebookId}:${sourcePath}:${startLine}-${endLine}`,
    codebookId,
    codebookLabel: getCodebookDef(codebookId)?.label ?? codebookId,
    sourcePath,
    sectionLabel: sourceLabelForChunk(chunk),
    publicUrl: publicUrlForChunk(chunk, lines),
    startLine,
    endLine,
    fullText: getLineRangeText(lines, startLine, endLine),
  };
}

function baseDefinitionRank(sourcePath: string): number {
  let rank = 0;
  if (/(?:^|[-_/])R202(?:[_./-]|$)/i.test(sourcePath)) rank += 1000;
  if (/section_E3501\.1\.txt$/i.test(sourcePath)) rank += 150;
  if (/\/raw\/section_/i.test(sourcePath)) rank += 50;
  if (/\/raw\/output\/section_/i.test(sourcePath)) rank += 40;
  if (/\/raw\/sections\//i.test(sourcePath)) rank += 20;
  if (/AW106\.1/i.test(sourcePath)) rank -= 200;
  if (/table_/i.test(sourcePath)) rank -= 500;
  return rank;
}

function addOrReplaceBaseEntry(
  byTerm: Map<string, DefinitionRegistryEntry>,
  entry: DefinitionRegistryEntry
): void {
  const existing = byTerm.get(entry.normalizedTerm);
  if (!existing || entry.rank > existing.rank) {
    byTerm.set(entry.normalizedTerm, entry);
  }
}

function parseBaseDefinitions(
  codebookId: string,
  chunks: IndexedChunk[]
): Map<string, DefinitionRegistryEntry> {
  const byTerm = new Map<string, DefinitionRegistryEntry>();
  const sourcePaths = Array.from(new Set(chunks.map((chunk) => chunk.sourcePath))).filter(
    (sourcePath) =>
      sourcePath.endsWith(".txt") &&
      !/table_/i.test(sourcePath) &&
      !/AW106\.1/i.test(sourcePath)
  );

  for (const sourcePath of sourcePaths) {
    const lines = readLines(sourcePath);
    if (!lines) continue;
    const start = bodyStartIndex(lines);

    for (let i = start; i < lines.length; i++) {
      const parsed = parseDefinitionStart(lines[i] || "");
      if (!parsed) continue;

      const definitionLines: string[] = [];
      if (parsed.firstDefinitionLine) definitionLines.push(parsed.firstDefinitionLine);
      const startLine = i + 1;
      let endLine = startLine;

      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j] || "";
        const nextTrimmed = nextLine.trim();
        if (parseDefinitionStart(nextLine)) break;
        if (isMetadataLine(nextTrimmed)) break;
        if (/^[A-Z]?\d{2,}(?:\.\d+)*\b/.test(nextTrimmed)) break;
        if (!nextTrimmed && definitionLines.length > 0) break;
        if (definitionLines.length >= 12) break;
        if (nextTrimmed) {
          definitionLines.push(nextTrimmed);
          endLine = j + 1;
        }
      }

      const definition = normalizeWhitespace(definitionLines.join(" "));
      if (definition.length < 8 || definition.length > 2500) continue;

      const term = parsed.term;
      const source = sourceFromRange(
        codebookId,
        sourcePath,
        startLine,
        endLine,
        chunks,
        lines
      );
      const normalizedTerm = definitionKey(term);
      addOrReplaceBaseEntry(byTerm, {
        term,
        normalizedTerm,
        definition,
        baseDefinition: definition,
        amendedDefinition: null,
        isAmended: false,
        source,
        amendmentSources: [],
        mergeNotes: [],
        rank: baseDefinitionRank(sourcePath),
      });
    }
  }

  return byTerm;
}

function stripOuterQuote(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("“") && trimmed.endsWith("”"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractLastQuotedText(text: string): string | null {
  const normalized = text.replace(/[“”]/g, '"');
  const firstQuote = normalized.indexOf('"');
  const lastQuote = normalized.lastIndexOf('"');
  if (firstQuote === -1 || lastQuote <= firstQuote) return null;
  return stripOuterQuote(normalized.slice(firstQuote, lastQuote + 1));
}

function extractDefinitionPayload(text: string): string | null {
  const normalized = text.replace(/[“”]/g, '"');
  const marker = normalized.match(
    /(?:the\s+following\s+definition\s+is\s+added|deleted\s+and\s+replaced\s+with\s+the\s+following)\s*:\s*"/i
  );
  if (!marker || marker.index === undefined) return null;
  const start = marker.index + marker[0].length;
  const end = normalized.lastIndexOf('"');
  if (end <= start) return null;
  return normalized.slice(start, end).trim();
}

function parseFullDefinitionStatement(statement: string):
  | { term: string; definition: string }
  | null {
  const normalized = normalizeWhitespace(statement.replace(/[“”]/g, '"'));
  const parsed = parseDefinitionStart(normalized);
  if (!parsed || !parsed.firstDefinitionLine) return null;
  return {
    term: parsed.term,
    definition: parsed.firstDefinitionLine,
  };
}

function amendmentBody(lines: string[]): { text: string; startLine: number; endLine: number } {
  const start = bodyStartIndex(lines);
  const text = lines.slice(start).join("\n").trim();
  return {
    text,
    startLine: start + 1,
    endLine: lines.length,
  };
}

function amendmentTermFromText(text: string): string | null {
  const quoted =
    text.match(/definition\s+(?:for|of)\s+"([^"]+)"/i)?.[1] ||
    text.match(/definition\s+(?:for|of)\s+“([^”]+)”/i)?.[1];
  if (quoted && validDefinitionTerm(quoted)) return normalizeDefinitionTerm(quoted);

  const unquoted = text.match(/definition\s+for\s+([a-z][a-z ]{2,80})\s+(?:a\s+comma|is\s+modified|the\s+word)/i)?.[1];
  if (unquoted && validDefinitionTerm(unquoted)) return normalizeDefinitionTerm(unquoted);
  return null;
}

function applyDefinitionInstruction(
  baseDefinition: string | null | undefined,
  amendmentText: string,
  term?: string
): { definition: string | null; changed: boolean; notes: string[] } {
  if (!baseDefinition) {
    return {
      definition: null,
      changed: false,
      notes: ["Base definition was not found in the parsed codebook text."],
    };
  }

  let next = repairKnownR202DefinitionBase(term, baseDefinition, amendmentText);
  let changed = false;
  const notes: string[] = [];
  const text = amendmentText.replace(/[“”]/g, '"');

  for (const match of text.matchAll(
    /adding\s+the\s+words?\s+"([^"]+)"\s+after\s+the\s+word\s+"([^"]+)"/gi
  )) {
    const applied = insertAfterPhrase(next, match[2], match[1]);
    next = applied.text;
    changed = applied.changed || changed;
    if (!applied.changed) notes.push(`Could not find insertion anchor "${match[2]}".`);
  }

  for (const match of text.matchAll(
    /adding\s+the\s+words?\s+"([^"]+)"\s+after\s+the\s+words\s+"([^"]+)"/gi
  )) {
    const applied = insertAfterPhrase(next, match[2], match[1]);
    next = applied.text;
    changed = applied.changed || changed;
    if (!applied.changed) notes.push(`Could not find insertion anchor "${match[2]}".`);
  }

  for (const match of text.matchAll(
    /replacing\s+the\s+word\s+"([^"]+)"\s+with\s+"([^"]+)"/gi
  )) {
    const applied = replacePhrase(next, match[1], match[2]);
    next = applied.text;
    changed = applied.changed || changed;
    if (!applied.changed) notes.push(`Could not find replacement phrase "${match[1]}".`);
  }

  for (const match of text.matchAll(/the\s+word\s+"([^"]+)"\s+is\s+deleted/gi)) {
    const applied = replacePhrase(next, match[1], "");
    next = applied.text;
    changed = applied.changed || changed;
    if (!applied.changed) notes.push(`Could not find deletion phrase "${match[1]}".`);
  }

  for (const match of text.matchAll(
    /the\s+following\s+is\s+added\s+to\s+the\s+end:\s+"([\s\S]+?)"/gi
  )) {
    next = `${next.trimEnd()} ${match[1].trim()}`;
    changed = true;
  }

  if (/a\s+comma\s+is\s+inserted\s+after\s+the\s+word\s+"([^"]+)"/i.test(text)) {
    const anchor = text.match(/a\s+comma\s+is\s+inserted\s+after\s+the\s+word\s+"([^"]+)"/i)?.[1];
    if (anchor) {
      const applied = replacePhrase(next, anchor, `${anchor},`);
      next = applied.text;
      changed = applied.changed || changed;
      if (!applied.changed) notes.push(`Could not find comma insertion anchor "${anchor}".`);
    }
  }

  return {
    definition: normalizeWhitespace(next),
    changed,
    notes,
  };
}

function repairKnownR202DefinitionBase(
  term: string | undefined,
  baseDefinition: string,
  amendmentText: string
): string {
  const key = term ? definitionKey(term) : "";
  const normalizedBase = normalizeWhitespace(baseDefinition);
  const normalizedAmendment = amendmentText.replace(/[“”]/g, '"');

  if (
    key === "APPROVED" &&
    /after\s+the\s+word\s+"official\."/i.test(normalizedAmendment) &&
    /^Acceptable\s+to\s+the\s+authority\s+having\s+jurisdiction\.?$/i.test(normalizedBase)
  ) {
    return "Acceptable to the building official.";
  }

  return baseDefinition;
}

function flexiblePattern(phrase: string): RegExp | null {
  const normalized = normalizeWhitespace(phrase);
  if (!normalized) return null;
  const escaped = normalized
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("\\s+"), "i");
}

function insertAfterPhrase(
  text: string,
  anchor: string,
  insertion: string
): { text: string; changed: boolean } {
  const pattern = flexiblePattern(anchor);
  if (!pattern || !pattern.test(text)) return { text, changed: false };
  return {
    text: normalizeWhitespace(
      text.replace(pattern, (match) => {
        const trailingPunctuation = match.match(/[.;:]$/)?.[0] || "";
        if (trailingPunctuation && !/[.!?]$/.test(insertion.trim())) {
          return `${match.slice(0, -1)} ${insertion}${trailingPunctuation}`;
        }
        return `${match} ${insertion}`;
      })
    ),
    changed: true,
  };
}

function replacePhrase(
  text: string,
  phrase: string,
  replacement: string
): { text: string; changed: boolean } {
  const pattern = flexiblePattern(phrase);
  if (!pattern || !pattern.test(text)) return { text, changed: false };
  return {
    text: normalizeWhitespace(text.replace(pattern, replacement)),
    changed: true,
  };
}

function applyDefinitionAmendments(
  byTerm: Map<string, DefinitionRegistryEntry>,
  amendmentCodebookId: string,
  chunks: IndexedChunk[]
): void {
  const sourcePaths = Array.from(new Set(chunks.map((chunk) => chunk.sourcePath))).filter(
    (sourcePath) => /R202/i.test(path.basename(sourcePath)) && sourcePath.endsWith(".txt")
  );

  for (const sourcePath of sourcePaths) {
    const lines = readLines(sourcePath);
    if (!lines) continue;
    const body = amendmentBody(lines);
    if (!body.text) continue;

    const amendmentSource = sourceFromRange(
      amendmentCodebookId,
      sourcePath,
      body.startLine,
      body.endLine,
      chunks,
      lines
    );

    const quotedDefinition = extractDefinitionPayload(body.text) || extractLastQuotedText(body.text);
    const fullDefinition = quotedDefinition
      ? parseFullDefinitionStatement(quotedDefinition)
      : null;
    const explicitTerm = amendmentTermFromText(body.text);
    const term = fullDefinition?.term || explicitTerm;
    if (!term) continue;

    const key = definitionKey(term);
    const existing = byTerm.get(key);
    const amendmentSources = [
      ...(existing?.amendmentSources ?? []),
      amendmentSource,
    ];

    if (fullDefinition) {
      byTerm.set(key, {
        term: fullDefinition.term,
        normalizedTerm: key,
        definition: fullDefinition.definition,
        baseDefinition: existing?.baseDefinition ?? null,
        amendedDefinition: fullDefinition.definition,
        isAmended: true,
        source: existing?.source,
        amendmentSources,
        mergeNotes: existing?.mergeNotes ?? [],
        rank: (existing?.rank ?? 0) + 10000,
      });
      continue;
    }

    const applied = applyDefinitionInstruction(existing?.definition, body.text, term);
    const definition = applied.definition || existing?.definition || body.text;
    byTerm.set(key, {
      term: existing?.term || term,
      normalizedTerm: key,
      definition,
      baseDefinition: existing?.baseDefinition ?? existing?.definition ?? null,
      amendedDefinition: applied.changed ? definition : null,
      isAmended: true,
      source: existing?.source,
      amendmentSources,
      mergeNotes: [
        ...(existing?.mergeNotes ?? []),
        ...applied.notes,
      ],
      rank: (existing?.rank ?? 0) + 10000,
    });
  }
}

export function loadDefinitionRegistry(
  baseCodebookId: string,
  amendmentCodebookId?: string,
  includeAmendments = true
): DefinitionRegistry {
  const cacheKey = `${baseCodebookId}:${includeAmendments ? amendmentCodebookId || "" : ""}`;
  const cached = registryCache.get(cacheKey);
  if (cached) return cached;

  const baseChunks = loadCodebookIndex(baseCodebookId);
  const byTerm = parseBaseDefinitions(baseCodebookId, baseChunks);

  if (includeAmendments && amendmentCodebookId) {
    try {
      const amendmentChunks = loadCodebookIndex(amendmentCodebookId);
      applyDefinitionAmendments(byTerm, amendmentCodebookId, amendmentChunks);
    } catch (error) {
      console.warn("[definitions] failed to apply definition amendments", {
        amendmentCodebookId,
        error,
      });
    }
  }

  const entries = Array.from(byTerm.values()).sort(
    (a, b) =>
      b.term.length - a.term.length ||
      b.rank - a.rank ||
      a.term.localeCompare(b.term)
  );
  const registry = { entries, byTerm };
  registryCache.set(cacheKey, registry);
  return registry;
}

function textContainsTerm(text: string, term: string): boolean {
  const normalizedText = normalizeWhitespace(text).toUpperCase();
  const normalizedTerm = normalizeDefinitionTerm(term);
  const aliases = new Set<string>([normalizedTerm]);
  const withoutParenthetical = normalizeWhitespace(
    normalizedTerm.replace(/\s*\([^)]*\)\s*/g, " ")
  );
  if (withoutParenthetical) aliases.add(withoutParenthetical);
  for (const match of normalizedTerm.matchAll(/\(([^)]+)\)/g)) {
    if (match[1] && match[1].length >= 2 && match[1].length <= 5) {
      aliases.add(match[1]);
    }
  }

  for (const alias of aliases) {
    const spacedPattern = new RegExp(
      `(^|[^A-Z0-9])${alias
        .split(/\s+/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[\\s-]+")}([^A-Z0-9]|$)`,
      "i"
    );
    if (spacedPattern.test(normalizedText)) return true;
    const compactTerm = definitionKey(alias);
    if (compactTerm.length >= 8) {
      if (normalizedText.replace(/[^A-Z0-9]/g, "").includes(compactTerm)) {
        return true;
      }
    }
  }
  return false;
}

export function findDefinitionsInText(
  text: string,
  registry: DefinitionRegistry,
  matchReason: DefinitionMatchReason,
  limit = 8
): DefinitionRef[] {
  const out: DefinitionRef[] = [];
  const seen = new Set<string>();
  for (const entry of registry.entries) {
    if (seen.has(entry.normalizedTerm)) continue;
    if (!textContainsTerm(text, entry.term)) continue;
    const isSingleWord = normalizeDefinitionTerm(entry.term).split(/\s+/).length === 1;
    if (
      isSingleWord &&
      out.some((definition) =>
        normalizeDefinitionTerm(definition.term)
          .split(/\s+/)
          .includes(normalizeDefinitionTerm(entry.term))
      )
    ) {
      continue;
    }
    seen.add(entry.normalizedTerm);
    out.push({
      term: entry.term,
      definition: entry.definition,
      baseDefinition: entry.baseDefinition,
      amendedDefinition: entry.amendedDefinition,
      isAmended: entry.isAmended,
      matchReason,
      source: entry.source,
      amendmentSources: entry.amendmentSources,
      mergeNotes: entry.mergeNotes,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function mergeDefinitionRefs(
  ...groups: DefinitionRef[][]
): DefinitionRef[] {
  const byTerm = new Map<string, DefinitionRef>();
  for (const group of groups) {
    for (const definition of group) {
      const key = definitionKey(definition.term);
      const existing = byTerm.get(key);
      if (!existing) {
        byTerm.set(key, definition);
        continue;
      }
      byTerm.set(key, {
        ...existing,
        matchReason:
          existing.matchReason === "query" || definition.matchReason === "query"
            ? "query"
            : "answer",
        amendmentSources: mergeSources(existing.amendmentSources, definition.amendmentSources),
      });
    }
  }
  return Array.from(byTerm.values());
}

function mergeSources(a: DefinitionSource[], b: DefinitionSource[]): DefinitionSource[] {
  const seen = new Set<string>();
  const out: DefinitionSource[] = [];
  for (const source of [...a, ...b]) {
    const key = `${source.sourcePath}:${source.startLine}-${source.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

export function isLikelyDirectDefinitionQuestion(
  query: string,
  definitions: DefinitionRef[]
): boolean {
  if (definitions.length === 0) return false;
  const normalized = normalizeWhitespace(query).toUpperCase();
  const words = normalized.split(/[^A-Z0-9]+/).filter(Boolean);
  const meaningfulWords = words.filter((word) => !STOP_TERMS.has(word));
  if (meaningfulWords.length <= 3) return true;

  return definitions.some((definition) => {
    const term = normalizeDefinitionTerm(definition.term);
    return (
      new RegExp(`\\bWHAT\\s+IS\\s+(?:AN?\\s+)?${escapeForRegex(term)}\\b`, "i").test(normalized) ||
      new RegExp(`\\bWHAT\\s+DOES\\s+${escapeForRegex(term)}\\s+MEAN\\b`, "i").test(normalized) ||
      new RegExp(`\\bDEFINE\\s+${escapeForRegex(term)}\\b`, "i").test(normalized)
    );
  });
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}
