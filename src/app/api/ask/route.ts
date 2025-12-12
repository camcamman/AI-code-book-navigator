import { NextResponse } from "next/server";
import OpenAI from "openai";
import { searchCodebook, IndexedChunk } from "../../../lib/searchCodebook";
import { AMENDMENT_MAP, getCodebookDef } from "../../../lib/codebookRegistry";
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

type AskResponse = {
  ok: boolean;
  query: string;
  codebookId: string;
  answer: string | null;
  sources: SourceRef[];
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

function looksUnderspecified(q: string): boolean {
  const s = q.toLowerCase();

  // Has a code-like identifier? (R302.2, 57-8-4.5, etc.)
  const hasCodeLike =
    /\b([a-z]\d{3,}(\.\d+)*)\b/i.test(s) || /\b\d{1,3}-\d{1,3}-\d+(\.\d+)?\b/.test(s);

  // Follow-up / deictic language
  const hasFollowup =
    /\b(that|this|those|it|same|above|earlier|previous|that section|that chapter)\b/.test(s);

  return !hasCodeLike && hasFollowup;
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
  chunks: IndexedChunk[]
): { contextText: string; sources: SourceRef[] } {
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


export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AskRequestBody;

    const rawQuery = body.query || "";
    const query = rawQuery.trim();
    const baseCodebookId = body.codebookId || "irc-utah-2021";
    const topK = body.topK ?? 6;
    const includeAmendments = body.includeAmendments ?? true;

    const rawSessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const sessionId = rawSessionId.length > 0 ? rawSessionId : null;

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

    const history: MemoryEntry[] =
  sessionId !== null ? getSessionHistory(sessionId) : [];

// ----------------------------
// Context-aware retrieval query
// ----------------------------
let effectiveQuery = query;

// Prefer anchoring whenever the query does NOT contain a code-like identifier.
const hasCodeLike =
  /\b([a-z]\d{3,}(\.\d+)*)\b/i.test(query) ||
  /\b\d{1,3}-\d{1,3}-\d+(\.\d+)?\b/.test(query);

if (!hasCodeLike && history.length > 0) {
  const hint = getLastTopicHint(history) ?? getLastUserQuery(history);
  if (hint) {
  // Put the anchor FIRST so embeddings strongly weight it.
  effectiveQuery = `${hint}\n\nFollow-up question:\n${query}`;
}

}

// ----------------------------
// Retrieve base + amendments
// ----------------------------
console.log("effectiveQuery:", effectiveQuery);
console.log("history length:", history.length);
console.log("effectiveQuery:", effectiveQuery);
console.log("topicHint (last):", getLastTopicHint(history));


const baseChunks = await searchCodebook({
  query: effectiveQuery,
  codebookId: baseCodebookId,
  topK,
});

let amendmentChunks: IndexedChunk[] = [];
const amendmentCodebookId = AMENDMENT_MAP[baseCodebookId];

if (amendmentCodebookId && includeAmendments) {
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

const allChunks: IndexedChunk[] = [...amendmentChunks, ...baseChunks];

if (allChunks.length === 0) {
  const res: AskResponse = {
    ok: false,
    query,
    codebookId: baseCodebookId,
    answer: null,
    sources: [],
    reason: "I cannot answer that from the provided code sections.",
  };
  return NextResponse.json(res, { status: 200 });
}

const { contextText, sources } = buildContext(allChunks);

// ----------------------------
// Build chat history messages
// ----------------------------
type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const historyMessages: ChatMsg[] = [];
for (const entry of history) {
  if (entry.role === "user" && entry.query) {
    historyMessages.push({ role: "user", content: entry.query });
  } else if (entry.role === "assistant" && entry.answer) {
    historyMessages.push({ role: "assistant", content: entry.answer });
  }
}

// ----------------------------
// Ask model (strict RAG)
// ----------------------------
const systemPrompt =
  "You are an assistant that answers questions about building codes and statutes.\n" +
  "You must answer strictly and only based on the provided code excerpts.\n" +
  'If the excerpts are not sufficient to answer safely, say: "I cannot answer that from the provided code sections."\n' +
  "When you do answer, cite sources using: [source N, lines A–B]\n";

const userPrompt =
  `User question:\n${query}\n\n` +
  "Relevant code excerpts:\n" +
  contextText +
  "\nAnswer using ONLY these excerpts and cite them.";

const messages: ChatMsg[] = [
  { role: "system", content: systemPrompt },
  ...historyMessages,
  { role: "user", content: userPrompt },
];

const completion = await openai.chat.completions.create({
  model: "gpt-5.2",
  messages,
  temperature: 0,
});

const answerText = completion.choices[0]?.message?.content ?? "";

// ----------------------------
// Save memory + topic hint
// ----------------------------
const now = Date.now();

if (sessionId !== null) {
  const topicHint =
    sources[0]?.sectionLabel ||
    sources[0]?.sourcePath ||
    undefined;

  const updatedHistory: MemoryEntry[] = [
    ...history,
    { role: "user", query, timestamp: now },
    { role: "assistant", answer: answerText, citations: sources, topicHint, timestamp: now },
  ];

  saveSessionHistory(sessionId, updatedHistory);
}

// ----------------------------
// Return response
// ----------------------------
const res: AskResponse = {
  ok: true,
  query,
  codebookId: baseCodebookId,
  answer: answerText,
  sources,
};
return NextResponse.json(res, { status: 200 });

  } catch (err: any) {
    console.error("Error in /api/ask:", err);
    const res: AskResponse = {
      ok: false,
      query: "",
      codebookId: "irc-utah-2021",
      answer: null,
      sources: [],
      error: err?.message || "Server error",
    };
    return NextResponse.json(res, { status: 500 });
  }
}
