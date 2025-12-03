import { NextResponse } from "next/server";
import OpenAI from "openai";
import { searchCodebook, type IndexedChunk } from "@/lib/searchCodebook";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function buildContextFromChunks(chunks: IndexedChunk[]): string {
  return chunks
    .map((chunk, idx) => {
      const trimmedContent =
        chunk.content.length > 2000
          ? chunk.content.slice(0, 2000) + "\n...[trimmed]..."
          : chunk.content;

      return [
        `SOURCE [${idx + 1}]`,
        `codebookId: ${chunk.codebookId}`,
        `sourcePath: ${chunk.sourcePath}`,
        `lines: ${chunk.startLine}-${chunk.endLine}`,
        "",
        trimmedContent,
      ].join("\n");
    })
    .join("\n\n-----------------------------\n\n");
}

type CheckerResult = {
  verdict: "supported" | "unsupported" | "partial";
  final_answer: string | null;
  explanation: string;
};

async function callAnswerModel(options: {
  query: string;
  context: string;
}): Promise<string> {
  const { query, context } = options;

  const systemPrompt = `
You are an assistant that answers technical and legal questions strictly based on the building codes, standards, or regulations provided in the context.

Global rules:
1. You must rely ONLY on the supplied context excerpts (the retrieved chunks). Do not use external memory, outside knowledge, or assumptions.
2. NEVER cite or reference code text that is not included in the provided context.
3. If the provided context does not include enough information to answer safely and accurately, respond with: "I cannot answer that from the provided code sections."
4. When providing an answer, cite using the format [source N, lines A-B].
5. You do not assume which codebook the user is asking about. The codebookId and the context chunks determine the source.
6. You are neutral and do not interpret laws beyond exactly what the text states. No extrapolation, no “common practice,” no guessing.
7. Every answer must be grounded 100% in the retrieved chunks, regardless of which codebook or jurisdiction they came from.
`.trim();

  const userPrompt = `
User question:
${query}

Context from codebooks:
${context}

Instructions:
1. Answer the question using ONLY the context above.
2. When you make a claim, reference the relevant source(s) like [source 1, lines 4965-4981].
3. If the context does not support a safe, accurate answer, explicitly say: "I cannot answer that from the provided code sections."
`.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-5-mini",
    temperature: 1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return completion.choices[0]?.message?.content ?? "";
}

async function callCheckerModel(options: {
  query: string;
  context: string;
  draftAnswer: string;
}): Promise<CheckerResult> {
  const { query, context, draftAnswer } = options;

  const systemPrompt = `
You are a strict verification model for building codes and legal text.

Your job:
- Verify whether the DRAFT ANSWER is fully supported by the provided CONTEXT.
- Do NOT add new claims beyond what appears in the context.
- You MUST be conservative. When in doubt, treat content as unsupported.

You must respond in EXACT JSON with keys:
{
  "verdict": "supported" | "unsupported" | "partial",
  "final_answer": string or null,
  "explanation": string
}

Definitions:
- "supported": All key claims in the answer are directly supported by the context, and citations are consistent with the relevant sources.
- "unsupported": The answer makes claims that are not supported by the context, or contradicts the text, or uses obvious external knowledge.
- "partial": Some parts are supported, but other parts are not, or the answer is overly broad or needs tightening. In this case, you should produce a corrected, strictly-supported version of the answer in "final_answer".
`.trim();

  const userPrompt = `
USER QUESTION:
${query}

CONTEXT (sources from codebooks):
${context}

DRAFT ANSWER (to verify):
${draftAnswer}

Tasks:
1. Check every major claim and citation in the DRAFT ANSWER against the CONTEXT text.
2. Decide on a verdict:
   - "supported" if the answer is fully supported and safely grounded.
   - "unsupported" if it contains hallucinations, external knowledge, or claims not backed by the context.
   - "partial" if it is mostly correct but includes unsupported or overreaching parts.
3. If "supported":
   - Set "final_answer" to the original DRAFT ANSWER.
4. If "partial":
   - Write a corrected, shorter, strictly-supported answer in "final_answer" using ONLY the context.
5. If "unsupported":
   - Set "final_answer" to null and explain briefly why.
6. Respond with EXACT JSON, no extra text.
`.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-5",
    temperature: 1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";

  let parsed: CheckerResult;
  try {
    parsed = JSON.parse(raw) as CheckerResult;
  } catch (e) {
    // If the checker doesn't return valid JSON, fail closed
    return {
      verdict: "unsupported",
      final_answer: null,
      explanation:
        "Checker model returned invalid JSON. Failing closed for safety.",
    };
  }

  // Basic sanity check
  if (
    parsed.verdict !== "supported" &&
    parsed.verdict !== "unsupported" &&
    parsed.verdict !== "partial"
  ) {
    return {
      verdict: "unsupported",
      final_answer: null,
      explanation:
        "Checker model returned an invalid verdict. Failing closed for safety.",
    };
  }

  return parsed;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const query: string = body.query;
    const codebookId: string = body.codebookId || "icc-utah-2021";
    const topK: number = body.topK || 6;

    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid 'query' field" },
        { status: 400 }
      );
    }

    // 1) Retrieve relevant chunks from the embedded index
    const chunks = await searchCodebook({
      query,
      codebookId,
      topK,
    });

    if (!chunks || chunks.length === 0) {
      // Fail closed: no authoritative source found
      return NextResponse.json(
        {
          ok: false,
          query,
          codebookId,
          answer: null,
          reason: "No relevant sections found in the codebook index.",
        },
        { status: 200 }
      );
    }

    const context = buildContextFromChunks(chunks);

    // 2) Call fast answer model
    const draftAnswer = await callAnswerModel({ query, context });

    // 3) Call strict checker model
    const checker = await callCheckerModel({ query, context, draftAnswer });

    if (checker.verdict === "unsupported") {
      // Fail closed
      return NextResponse.json(
        {
          ok: false,
          query,
          codebookId,
          answer: null,
          reason:
            "The checker model could not verify the answer against the provided code sections.",
          checkerExplanation: checker.explanation,
        },
        { status: 200 }
      );
    }

    const finalAnswer =
      checker.verdict === "partial"
        ? checker.final_answer
        : draftAnswer || checker.final_answer;

    if (!finalAnswer) {
      return NextResponse.json(
        {
          ok: false,
          query,
          codebookId,
          answer: null,
          reason:
            "No safe, supported answer could be produced from the provided code sections.",
          checkerExplanation: checker.explanation,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        query,
        codebookId,
        answer: finalAnswer,
        checkerVerdict: checker.verdict,
        checkerExplanation: checker.explanation,
        sources: chunks.map((chunk, idx) => ({
          sourceId: idx + 1,
          id: chunk.id,
          sourcePath: chunk.sourcePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        })),
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/ask:", err);
    return NextResponse.json(
      { error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
