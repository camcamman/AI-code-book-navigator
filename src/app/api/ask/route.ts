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

    const systemPrompt = `
You are an assistant that answers technical and legal questions strictly based on the building codes, standards, or regulations provided in the context.

Global rules:

1. You must rely ONLY on the supplied context excerpts (the retrieved chunks).  
   Do not use external memory, outside knowledge, or assumptions.

2. NEVER cite or reference code text that is not included in the provided context.

3. If the provided context does not include enough information to answer safely and accurately:
   Respond with:  
   "I cannot answer that from the provided code sections."

4. When providing an answer, cite using the format:
   [source N, lines A-B]

5. You do not assume which codebook the user is asking about.  
   The "codebookId" and the context chunks determine the source.

6. You are neutral and do not interpret laws beyond exactly what the text states.  
   No extrapolation, no “common practice,” no guessing.

7. Every answer must be grounded 100% in the retrieved chunks, regardless of which codebook or jurisdiction they came from.

This allows you to support any number of codebooks (ICC, IBC, NEC, IRC, UPC, etc.) without modification.
`;

    const userPrompt = `
User question:
${query}

Context from codebook:
${context}

Instructions:
1. Answer the question using ONLY the context above.
2. When you make a claim, reference the relevant source(s) like [source 1, lines 4965-4981].
3. If the context does not support a safe, accurate answer, explicitly say you cannot answer from the provided sections.
`;

    // 2) Call the chat model to synthesize an answer
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini", // swap to a different model if you prefer
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt.trim() },
      ],
    });

    const answer = completion.choices[0]?.message?.content ?? "";

    return NextResponse.json(
      {
        ok: true,
        query,
        codebookId,
        answer,
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
