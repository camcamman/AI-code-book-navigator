import { NextResponse } from "next/server";
import OpenAI from "openai";
import { searchCodebook, IndexedChunk } from "../../../lib/searchCodebook";
import { AMENDMENT_MAP, getCodebookDef } from "../../../lib/codebookRegistry";
import {
  collectAmendmentExclusions,
  normalizeIrcSectionId,
} from "../../../lib/amendmentLinking";
export const runtime = "nodejs";


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

  // Split into sentences-ish lines (your model will usually output sentences separated by spaces/newlines).
  const parts = trimmed
  .split(/(?<=[.!?])\s+|\n+/)  // sentences or newlines
  .map(s => s.trim())
  .filter(Boolean);

  // Require every non-empty line to contain quote+citation
  return parts.length > 0 && parts.every(sentenceHasQuoteAndCitation);
}


function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
        return null;
      }
      const sourceId = (it as any).sourceId;
      const excerpt = (it as any).excerpt;

      if (typeof sourceId !== "number" || !Number.isFinite(sourceId)) {
        lastSelectorValidationFailReason = "item.sourceId invalid";
        return null;
      }
      if (!isNonEmptyString(excerpt)) {
        lastSelectorValidationFailReason = "item.excerpt missing or empty";
        return null;
      }

      const chunkIdx = sourceId - 1;
      if (chunkIdx < 0 || chunkIdx >= chunks.length) {
        lastSelectorValidationFailReason = "item.sourceId out of range";
        return null;
      }

      const chunkText = (chunks[chunkIdx].content || "").trim();
      const ex = excerpt.trim();

      // Must be an exact substring of the retrieved chunk (no paraphrase).
      const normalizedChunk = normalizeWhitespace(chunkText);
      const normalizedExcerpt = normalizeWhitespace(ex);
      if (!normalizedChunk.includes(normalizedExcerpt)) {
        lastSelectorValidationFailReason = "excerpt not substring of chunk content";
        return null;
      }

      // Prevent huge dumps
      if (ex.length > 1400) {
        lastSelectorValidationFailReason = "excerpt too long";
        return null;
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
    const sectionLabel: string | undefined =
      typeof meta.sectionLabel === "string" ? meta.sectionLabel :
      typeof meta.header === "string" ? meta.header :
      typeof meta.sectionId === "string" ? meta.sectionId :
      undefined;

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

    const sectionLabel: string | undefined =
      typeof meta.sectionLabel === "string" ? meta.sectionLabel :
      typeof meta.header === "string" ? meta.header :
      typeof meta.sectionId === "string" ? meta.sectionId :
      undefined;

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
    });

    const label = sectionLabel || chunk.sourcePath || `Source ${sourceId}`;

    out.push(
      `[source ${sourceId}, lines ${chunk.startLine}-${chunk.endLine}] ${label}\n` +
      chunk.content.trim()
    );
  });

  return { answer: out.join("\n\n---\n\n"), sources };
  }

function buildAmendmentRefs(chunks: IndexedChunk[]): AmendmentRef[] {
  const out: AmendmentRef[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const key =
      typeof chunk.id === "string" && chunk.id.trim().length > 0
        ? chunk.id
        : `${chunk.sourcePath}:${chunk.startLine}-${chunk.endLine}`;

    if (seen.has(key)) continue;
    seen.add(key);

    const meta = (chunk as any).meta ?? {};
    const sectionLabel: string | undefined =
      typeof meta.sectionLabel === "string" ? meta.sectionLabel :
      typeof meta.header === "string" ? meta.header :
      typeof meta.sectionId === "string" ? meta.sectionId :
      typeof meta.section === "string" ? meta.section :
      undefined;

    const publicUrl: string | undefined =
      typeof meta.publicUrl === "string" ? meta.publicUrl : undefined;

    const sourceId = out.length + 1;
    const citation = `[source ${sourceId}, lines ${chunk.startLine}-${chunk.endLine}]`;

    out.push({
      sourceId,
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
        amendmentChunks = await searchCodebook({
          query: effectiveQuery,
          codebookId: amendmentCodebookId,
          topK,
        });
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

  let filteredBaseChunks = baseChunks;
  if (failClosedNoBase) {
    filteredBaseChunks = [];
  } else if (excludedSectionIds.size > 0) {
    filteredBaseChunks = baseChunks.filter((chunk) => {
      const meta = (chunk as any).meta ?? {};
      const sectionIdRaw =
        typeof meta.sectionId === "string" ? meta.sectionId : null;
      if (!sectionIdRaw) return false;
      const sectionId = normalizeIrcSectionId(sectionIdRaw);
      return sectionId !== null && !excludedSectionIds.has(sectionId);
    });
  }

  const amendmentRefs = buildAmendmentRefs(amendmentChunks);
  const allChunks: IndexedChunk[] = [...amendmentChunks, ...filteredBaseChunks];

  console.log("[/api/ask] allChunks", {
    total: allChunks.length,
    amendmentCount: amendmentCodebookId
      ? allChunks.filter((c) => c.codebookId === amendmentCodebookId).length
      : 0,
    baseCount: allChunks.filter((c) => c.codebookId === baseCodebookId).length,
  });

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
      sources: [],
      amendments: amendmentRefs,
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

  // Build sources aligned to sourceId indexing (1-based)
  const { sources: srcs } = buildQuotesRaw(allChunks);

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
      model: "gpt-5.2",
      messages: [
        { role: "system", content: selectorSystem },
        { role: "user", content: selectorUser },
      ],
      temperature: 0,
    });

    const raw = sel.choices[0]?.message?.content ?? "";
    console.log("SELECTOR RAW OUTPUT:", raw);

    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
      selectorJsonParsed = true;
    } catch {
      console.log("SELECTOR JSON PARSE FAILED");
      parsed = null;
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
        sources: srcs,
        amendments: amendmentRefs,
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
      model: "gpt-5.2",
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
        sources: srcs,
        amendments: amendmentRefs,
        reason: "I cannot answer that from the provided code sections.",
      },
      { status: 200 }
    );
  }

  // Optional: store topic hint for follow-up retrieval (no “answer text” memory needed)
  const now = Date.now();
  if (sessionId !== null) {
    const topicHint = srcs[0]?.sectionLabel || srcs[0]?.sourcePath || undefined;

    const updatedHistory: MemoryEntry[] = [
      ...history,
      { role: "user", query, timestamp: now },
      { role: "assistant", answer: null as any, citations: srcs, topicHint, timestamp: now },
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

  const res: AskResponse = {
    ok: true,
    query,
    codebookId: baseCodebookId,
    answer: finalAnswer,
    sources: srcs,
    amendments: amendmentRefs,
  };


  return NextResponse.json(res, { status: 200 });
}
