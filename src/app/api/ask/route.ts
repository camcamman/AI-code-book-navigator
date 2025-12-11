// src/app/api/ask/route.ts

import { NextResponse } from "next/server";
import OpenAI from "openai";
import {
  searchCodebook,
  loadCodebookIndex,
  IndexedChunk,
} from "../../../lib/searchCodebook";
import {
  extractStructureFromQuery,
  findAmendmentChunksByStructure,
  CodeStructureRef,
} from "../../../lib/amendmentLinking";
import {
  AMENDMENT_MAP,
  getCodebookDef,
} from "../../../lib/codebookRegistry";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ANSWER_MODEL =
  process.env.OPENAI_ANSWER_MODEL || "gpt-4.1-mini"; // set to gpt-5-mini if available
const CHECKER_MODEL =
  process.env.OPENAI_CHECKER_MODEL || "gpt-4.1"; // set to gpt-5 if available

type SourceRef = {
  sourceId: number;
  id: string;
  codebookId: string;
  // Human-readable label for the codebook (optional)
  codebookLabel?: string;
  sourcePath: string;
  sectionLabel?: string;
  publicUrl?: string;
  startLine: number;
  endLine: number;
};

type AskResponse = {
  ok: boolean;
  query: string;
  codebookId: string;
  answer: string | null;
  sources: SourceRef[];
  reason?: string;
  error?: string;
};

type AskRequestBody = {
  query: string;
  codebookId?: string;
  topK?: number;
  includeAmendments?: boolean;
};

/**
 * Deduplicate chunks by id, keeping first occurrence.
 */
function dedupeChunks(chunks: IndexedChunk[]): IndexedChunk[] {
  const seen = new Set<string>();
  const result: IndexedChunk[] = [];
  for (const c of chunks) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    result.push(c);
  }
  return result;
}

/**
 * Build a single big context string for the LLM, with numbered sources.
 */
  function buildContextString(chunks: IndexedChunk[]): {
      contextText: string;
      sources: SourceRef[];
    } {
      const lines: string[] = [];
      const sources: SourceRef[] = [];

      chunks.forEach((chunk, idx) => {
        const sourceId = idx + 1;
        const meta: any = (chunk as any).meta || {};

        let sectionLabel: string | undefined;

        if (meta.sectionLabel) {
          sectionLabel = meta.sectionLabel;
        } else if (meta.section) {
          if (meta.title && meta.chapter) {
            sectionLabel = `Title ${meta.title} Chapter ${meta.chapter} Section ${meta.section}`;
          } else {
            sectionLabel = `Section ${meta.section}`;
          }
        } else if (meta.sectionId) {
          sectionLabel = `Section ${meta.sectionId}`;
        }

        const publicUrl = buildPublicUrlForSource(chunk.codebookId, meta);

        // get human-friendly codebook label from registry, fall back to id
        const codebookDef = getCodebookDef(chunk.codebookId);
        const codebookLabel = codebookDef?.label ?? chunk.codebookId;

        // Context text for the model
        lines.push(
          `[source ${sourceId}, lines ${chunk.startLine}-${chunk.endLine}] ` +
            `(codebook: ${chunk.codebookId}, path: ${chunk.sourcePath})\n` +
            `${chunk.content.trim()}\n`
        );

        // Struct for the frontend
        sources.push({
          sourceId,
          id: chunk.id,
          codebookId: chunk.codebookId,
          codebookLabel,
          sourcePath: chunk.sourcePath,
          sectionLabel,
          publicUrl,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        });
      });

      return {
        contextText: lines.join("\n"),
        sources,
      };
  }



/**
 * Try to parse JSON out of a model response, tolerating extra text / markdown.
 */
function buildPublicUrlForSource(
  codebookId: string,
  meta: any
): string | undefined {
  // Utah statutory code (amendments)
  if (codebookId === "utah-amendments") {
    // 1) First preference: use the precomputed URL from the index
    if (typeof meta?.publicUrl === "string" && meta.publicUrl.trim().length > 0) {
      return meta.publicUrl.trim();
    }

    // 2) Fallback: old Solr search behavior, in case some chunks don't have publicUrl
    let searchTerm: string | undefined =
      typeof meta?.sectionLabel === "string"
        ? meta.sectionLabel.trim()
        : undefined;

    if (!searchTerm && meta) {
      if (meta.title && meta.chapter && meta.section) {
        searchTerm = `Title ${meta.title} Chapter ${meta.chapter} Section ${meta.section}`;
      } else if (meta.section) {
        searchTerm = String(meta.section).trim();
      }
    }

    if (searchTerm && searchTerm.length > 0) {
      return `https://le.utah.gov/solrsearch.jsp?ktype=Code&request=${encodeURIComponent(
        searchTerm
      )}`;
    }

    return undefined;
  }

  // IRC Utah 2021 (base code) — keep exactly as you had it
  if (codebookId === "irc-utah-2021") {
    const sectionId = typeof meta?.sectionId === "string" ? meta.sectionId : "";
    if (sectionId.startsWith("R3")) {
      // Chapter 3 – Building Planning (R302.*, R303.*, etc.)
      return "https://codes.iccsafe.org/content/IRC2021P3/chapter-3-building-planning";
    }
    // Fallback: main IRC 2021 content
    return "https://codes.iccsafe.org/content/IRC2021P3";
  }

  return undefined;
}

function parseJsonFromText(text: string): any {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("No JSON object found in checker output");
  }
  const jsonStr = text.slice(first, last + 1);
  return JSON.parse(jsonStr);
}

function validateCitations(
  answer: string,
  sources: SourceRef[]
): { ok: boolean; reason?: string } {
  const text = answer || "";
  const sourceById = new Map<number, SourceRef>();
  for (const s of sources) {
    sourceById.set(s.sourceId, s);
  }

  // Match patterns like:
  // [source 1, lines 1–7]
  // [source 2, lines 10-15]
  const citationRegex =
  /source\s+(\d+)[^0-9]+(\d+)\s*[–-]\s*(\d+)/gi;

  let match: RegExpExecArray | null;
  let foundAny = false;

  while ((match = citationRegex.exec(text)) !== null) {
    foundAny = true;

    const sourceId = Number(match[1]);
    const citedStart = Number(match[2]);
    const citedEnd = Number(match[3]);

    if (!Number.isFinite(sourceId) || !Number.isFinite(citedStart) || !Number.isFinite(citedEnd)) {
      return {
        ok: false,
        reason: "Citation has non-numeric source or line range.",
      };
    }

    const src = sourceById.get(sourceId);
    if (!src) {
      return {
        ok: false,
        reason: `Citation refers to unknown source ${sourceId}.`,
      };
    }

    // Check that cited lines are within the chunk's line range
    if (citedStart < src.startLine || citedEnd > src.endLine || citedStart > citedEnd) {
      return {
        ok: false,
        reason: `Citation [source ${sourceId}, lines ${citedStart}–${citedEnd}] is outside the retrieved range (${src.startLine}–${src.endLine}).`,
      };
    }
  }

  // Require at least one citation in any supported answer
  if (!foundAny) {
    return {
      ok: false,
      reason: "Answer contains no citations.",
    };
  }

  return { ok: true };
}


// ------------------------------------------
// Main handler
// ------------------------------------------
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AskRequestBody;

    const query = (body.query || "").trim();
    const baseCodebookId = body.codebookId || "irc-utah-2021";
    const topK = body.topK ?? 6;

    // Validate base codebook id against registry (must exist and not be an amendment)
    const baseDef = getCodebookDef(baseCodebookId);
    if (!baseDef || baseDef.isAmendment) {
      const res: AskResponse = {
        ok: false,
        query,
        codebookId: baseCodebookId,
        answer: null,
        sources: [],
        reason: `Invalid base codebookId: ${baseCodebookId}`,
      };
      return NextResponse.json(res, { status: 400 });
    }

    if (!query) {
      const res: AskResponse = {
        ok: false,
        query,
        codebookId: baseCodebookId,
        answer: null,
        sources: [],
        reason: "Missing or empty 'query' field.",
      };
      return NextResponse.json(res, { status: 400 });
    }

    // --------------------------------------
    // 1. Semantic retrieval: base codebook
    // --------------------------------------
    const baseChunks = await searchCodebook({
      query,
      codebookId: baseCodebookId,
      topK,
    });

    // --------------------------------------
    // 2. Semantic + structural retrieval: amendments
    // --------------------------------------
    const amendmentCodebookId = AMENDMENT_MAP[baseCodebookId];
    let amendmentSemantic: IndexedChunk[] = [];
    let amendmentStructural: IndexedChunk[] = [];
    const includeAmendments = body.includeAmendments ?? true;


    if (amendmentCodebookId && includeAmendments) {
      // Semantic search over amendments
      try {
        amendmentSemantic = await searchCodebook({
          query,
          codebookId: amendmentCodebookId,
          topK,
        });
      } catch (e) {
        console.warn(
          `Warning: semantic search for amendments failed for ${amendmentCodebookId}:`,
          e
        );
      }

      // Deterministic structural linking
      let structRef: CodeStructureRef | null = null;
      try {
        structRef = extractStructureFromQuery(query);
      } catch (e) {
        console.warn("Warning: extractStructureFromQuery failed:", e);
      }

      if (structRef) {
        try {
          const allAmendmentChunks = loadCodebookIndex(amendmentCodebookId);
          amendmentStructural = findAmendmentChunksByStructure(structRef, {
            amendmentChunks: allAmendmentChunks,
            amendmentCodebookId,
          });
        } catch (e) {
          console.warn(
            "Warning: findAmendmentChunksByStructure/loadCodebookIndex failed:",
            e
          );
        }
      }
    }

    // --------------------------------------
    // 3. Merge chunks with priority:
    //    structural amendments -> semantic amendments -> base code
    // --------------------------------------
    const mergedAmendments = dedupeChunks([
      ...amendmentStructural,
      ...amendmentSemantic,
    ]);

    const allChunks = dedupeChunks([...mergedAmendments, ...baseChunks]);

    if (allChunks.length === 0) {
      const res: AskResponse = {
        ok: false,
        query,
        codebookId: baseCodebookId,
        answer: null,
        sources: [],
        reason:
          "I cannot answer that from the provided code sections (no relevant sections were retrieved).",
      };
      return NextResponse.json(res, { status: 200 });
    }

    // Optionally cap total number of chunks to avoid over-long prompts
    const maxContextChunks = 12;
    const contextChunks = allChunks.slice(0, maxContextChunks);

    const { contextText, sources } = buildContextString(contextChunks);

    // --------------------------------------
    // 4. First-pass answer (answer model)
    // --------------------------------------
    const answerSystemPrompt = `
      You are an assistant that answers questions strictly from the provided building code sections.

      You MUST adhere to these citation rules:

      - Only cite sources that appear in the CONTEXT section.
      - Each source is labeled as: [source N, lines A–B].
      - When you cite, you MUST keep line ranges within the exact A–B shown for that source.
      - Do NOT invent or extend line ranges beyond what is shown.
      - If the context shows [source 8, lines 2–8], you may cite:
          [source 8, lines 2–8]
          [source 8, lines 2–4]
          [source 8, lines 5–8]
        but NOT [source 8, lines 1–8] or [source 8, lines 8–16].
      - N, A, and B in your citations MUST match the numbers shown in the CONTEXT section. Do not introduce new source numbers or line ranges that are not present there.
      - If you are unsure which lines to use, default to the full range given for that source.
      - If you cannot answer the question from the provided context, say:
          "I cannot answer that from the provided code sections."
        and do not guess or invent citations.

      Hard rules:
      1) Use ONLY the given sources; do NOT rely on general knowledge.
      2) If the sources are insufficient, respond EXACTLY with:
        "I cannot answer that from the provided code sections."
        Do not add any other text in that case.
      3) When you give an answer (i.e., not the failure sentence), you MUST include at least one citation in the form:
        [source N, lines A–B]
        - N must match one of the provided source numbers.
        - A and B must be within that source's line range.
      4) Every factual statement that depends on the code should be supported by at least one citation. You can place a citation at the end of the sentence or paragraph that it supports.
      5) Do NOT invent new section numbers, titles, or legal requirements that are not clearly stated in the sources.
      6) If amendments conflict with base code, prefer the amendment text (these are usually in the "utah-amendments" codebook).
  `.trim();


    const answerUserPrompt = `
User question:
${query}

You are given the following code sections:

${contextText}

Answer the user's question using ONLY these sections. If you cannot answer from them, say:
"I cannot answer that from the provided code sections."
`.trim();

    const answerCompletion = await openai.chat.completions.create({
      model: ANSWER_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: answerSystemPrompt,
        },
        {
          role: "user",
          content: answerUserPrompt,
        },
      ],
    });

    const draftAnswer =
      answerCompletion.choices[0]?.message?.content?.trim() || "";

    if (
      !draftAnswer ||
      draftAnswer === "I cannot answer that from the provided code sections."
    ) {
      const res: AskResponse = {
        ok: false,
        query,
        codebookId: baseCodebookId,
        answer: null,
        sources,
        reason: "I cannot answer that from the provided code sections.",
      };
      return NextResponse.json(res, { status: 200 });
    }

    // --------------------------------------
    // 5. Checker model: verify support
    // --------------------------------------
    const checkerSystemPrompt = `
    You are a strict verifier for building code answers.

    You will receive:
    - The user's question.
    - A set of numbered code sections.
    - A draft answer with citations.

    Your job:
    1. Decide whether EVERY factual statement in the answer is directly supported by the cited sources.
    2. If any part goes beyond the provided text, treat the whole answer as UNSUPPORTED.
    3. Prefer amendment code sections (e.g., from "utah-amendments") over base code if they conflict.

    Respond with a single JSON object only, no extra text, in one of these forms:

    If fully supported:
    {
      "verdict": "supported",
      "reason": "short explanation"
    }

    If not fully supported:
    {
      "verdict": "unsupported",
      "reason": "short explanation",
      "fixed_answer": "a corrected answer that ONLY uses supported content, or the sentence 'I cannot answer that from the provided code sections.'"
    }
    `.trim();

    const checkerUserPrompt = `
Question:
${query}

Sources:
${contextText}

Draft answer:
${draftAnswer}
`.trim();

    const checkerCompletion = await openai.chat.completions.create({
      model: CHECKER_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: checkerSystemPrompt,
        },
        {
          role: "user",
          content: checkerUserPrompt,
        },
      ],
    });

    const checkerRaw =
      checkerCompletion.choices[0]?.message?.content?.trim() || "";

    let verdict = "unsupported";
    let checkerReason = "Checker returned invalid output; failing closed.";
    let fixedAnswer: string | undefined;

    try {
      const parsed = parseJsonFromText(checkerRaw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.verdict === "string") {
          verdict = parsed.verdict;
        }
        if (typeof parsed.reason === "string") {
          checkerReason = parsed.reason;
        }
        if (typeof parsed.fixed_answer === "string") {
          fixedAnswer = parsed.fixed_answer;
        }
      }
    } catch (e) {
      console.warn("Failed to parse checker JSON:", e, "Raw:", checkerRaw);
    }

    if (verdict !== "supported") {
      const finalAnswer =
        fixedAnswer && fixedAnswer.trim().length > 0
          ? fixedAnswer.trim()
          : "I cannot answer that from the provided code sections.";

      const res: AskResponse = {
        ok: false,
        query,
        codebookId: baseCodebookId,
        answer: finalAnswer,
        sources,
        reason: checkerReason || "The answer was not fully supported.",
      };
      return NextResponse.json(res, { status: 200 });
    }

    // At this point the checker says "supported".
    // Now enforce citation correctness.
    const citationCheck = validateCitations(draftAnswer, sources);

    if (!citationCheck.ok) {
      const res: AskResponse = {
        ok: false,
        query,
        codebookId: baseCodebookId,
        answer: "I cannot answer that from the provided code sections.",
        sources,
        reason:
          citationCheck.reason ||
          "The answer's citations did not match the retrieved sources.",
      };
      return NextResponse.json(res, { status: 200 });
    }

    // Supported + citations valid -> return the draft answer as final
    const res: AskResponse = {
      ok: true,
      query,
      codebookId: baseCodebookId,
      answer: draftAnswer,
      sources,
    };
    return NextResponse.json(res, { status: 200 });

  } catch (err: any) {
    console.error("Error in /api/ask:", err);
    const res: AskResponse = {
      ok: false,
      query: "",
      codebookId: "",
      answer: null,
      sources: [],
      error: err?.message || "Server error",
    };
    return NextResponse.json(res, { status: 500 });
  }
}
