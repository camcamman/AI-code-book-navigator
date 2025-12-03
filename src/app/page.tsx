"use client";

import { useState } from "react";

type SourceRef = {
  sourceId: number;
  id: string;
  sourcePath: string;
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

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [codebookId, setCodebookId] = useState("icc-utah-2021");
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = query.trim();
    if (!trimmed) {
      setError("Please enter a question about the code.");
      return;
    }

    setLoading(true);
    setError(null);
    setAnswer(null);
    setSources([]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          codebookId,
          topK: 6,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Request failed with status ${res.status}: ${text || "unknown error"}`
        );
      }

      const data: AskResponse = await res.json();

      if (!data.ok) {
        setAnswer(null);
        setSources([]);
        setError(
          data.reason ||
            "The assistant could not answer from the provided code sections."
        );
        return;
      }

      setAnswer(data.answer || null);
      setSources(data.sources || []);
    } catch (err: any) {
      console.error("Error calling /api/ask:", err);
      setError(err?.message || "Unexpected error calling /api/ask");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: "800px",
        margin: "0 auto",
        padding: "2rem 1.5rem",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2rem", fontWeight: 600, marginBottom: "0.5rem" }}>
        AI Codebook Navigator
      </h1>
      <p style={{ marginBottom: "1.5rem", color: "#555" }}>
        Ask questions about your codebooks. The assistant will answer only from
        the embedded code text and will fail closed if the context is
        insufficient.
      </p>

      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          marginBottom: "1.5rem",
        }}
      >
        <label style={{ fontWeight: 500 }}>
          Question
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={4}
            style={{
              width: "100%",
              marginTop: "0.25rem",
              padding: "0.5rem 0.75rem",
              fontFamily: "inherit",
              fontSize: "0.95rem",
              borderRadius: "4px",
              border: "1px solid #ccc",
              resize: "vertical",
            }}
            placeholder="Example: Where does the code define fire-resistance requirements for walls between dwelling units?"
          />
        </label>

        <label style={{ fontWeight: 500 }}>
          Codebook
          <select
            value={codebookId}
            onChange={(e) => setCodebookId(e.target.value)}
            style={{
              width: "100%",
              marginTop: "0.25rem",
              padding: "0.4rem 0.75rem",
              borderRadius: "4px",
              border: "1px solid #ccc",
              fontSize: "0.95rem",
            }}
          >
            <option value="icc-utah-2021">ICC Utah Code 2021</option>
            {/* Add more options here later as you add more codebooks */}
          </select>
        </label>

        <button
          type="submit"
          disabled={loading}
          style={{
            marginTop: "0.5rem",
            padding: "0.5rem 0.75rem",
            borderRadius: "4px",
            border: "none",
            backgroundColor: loading ? "#999" : "#2563eb",
            color: "#fff",
            fontWeight: 500,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Thinking..." : "Ask the Codebook"}
        </button>
      </form>

      {error && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.75rem",
            borderRadius: "4px",
            backgroundColor: "#fee2e2",
            color: "#991b1b",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      {answer && (
        <section style={{ marginBottom: "1.5rem" }}>
          <h2
            style={{
              fontSize: "1.25rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
            }}
          >
            Answer
          </h2>
          <div
            style={{
              whiteSpace: "pre-wrap",
              lineHeight: 1.5,
              fontSize: "0.95rem",
              borderRadius: "4px",
              border: "1px solid #ddd",
              padding: "0.75rem",
              backgroundColor: "#fafafa",
            }}
          >
            {answer}
          </div>
        </section>
      )}

      {sources.length > 0 && (
        <section>
          <h3
            style={{
              fontSize: "1.1rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
            }}
          >
            Sources used
          </h3>
          <ul style={{ paddingLeft: "1.25rem", fontSize: "0.9rem" }}>
            {sources.map((s) => (
              <li key={s.sourceId} style={{ marginBottom: "0.4rem" }}>
                <strong>[source {s.sourceId}]</strong>{" "}
                <code>{s.sourcePath}</code>, lines {s.startLine}-{s.endLine}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
