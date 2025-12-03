import { NextResponse } from "next/server";
import { searchCodebook } from "../../../lib/searchCodebook";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const query: string = body.query;
    const codebookId: string = body.codebookId || "icc-utah-2021";
    const topK: number = body.topK || 5;

    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid 'query' field" },
        { status: 400 }
      );
    }

    const chunks = await searchCodebook({
      query,
      codebookId,
      topK,
    });

    return NextResponse.json(
      {
        ok: true,
        query,
        codebookId,
        topK,
        results: chunks.map((chunk) => ({
          id: chunk.id,
          sourcePath: chunk.sourcePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          contentPreview: chunk.content.slice(0, 500), // avoid sending giant text blocks
        })),
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/search-code:", err);
    return NextResponse.json(
      { error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
