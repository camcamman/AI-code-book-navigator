"use client";

import { BASE_CODEBOOKS } from "@/lib/codebookRegistry";
import { useState, useEffect } from "react";


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

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [codebookId, setCodebookId] = useState("irc-utah-2021");
  const [includeAmendments, setIncludeAmendments] = useState(true);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);



useEffect(() => {
  // Only run on client
  if (typeof window === "undefined") return;

  const key = "codebookSessionId";
  const existing = window.localStorage.getItem(key);

  if (existing && existing.trim().length > 0) {
    setSessionId(existing);
  } else {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(key, id);
    setSessionId(id);
  }
}, []);


    async function handleSubmit(e: React.FormEvent) {
      e.preventDefault();

      const trimmed = query.trim();
      if (!trimmed) {
        setError("Please enter a question about the code.");
        return;
      }

      if (!sessionId) {
        setError("Session not initialized yet. Please try again.");
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
            codebookId,          // <-- use this, not selectedCodebookId
            topK: 6,
            includeAmendments,
            sessionId,           // <-- new field for memory
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
        setError(
          err?.message ||
            "An unexpected error occurred while calling the code navigator."
        );
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
            {BASE_CODEBOOKS.map((cb) => (
              <option key={cb.id} value={cb.id}>
                {cb.label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontWeight: 500 }}>
          Include Amendments
          <input
            type="checkbox"
            checked={includeAmendments}
            onChange={(e) => setIncludeAmendments(e.target.checked)}
            style={{
              marginLeft: "0.5rem",
              transform: "scale(1.2)",
              cursor: "pointer",
            }}
          />
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
          <ul style={{ paddingLeft: "1.2rem" }}>
  {sources.map((s) => (
            <li key={s.sourceId} style={{ marginBottom: "0.6rem" }}>
              <div>
                <strong>[source {s.sourceId}] {s.codebookLabel}</strong>
              </div>
              {s.sectionLabel && (
                <div style={{ fontSize: "0.9rem" }}>{s.sectionLabel}</div>
              )}
              <div style={{ fontSize: "0.85rem", color: "#555" }}>
                {s.sourcePath}, lines {s.startLine}-{s.endLine}
              </div>
              {s.publicUrl && (
                <div style={{ fontSize: "0.85rem", marginTop: "0.15rem" }}>
                  <a
                    href={s.publicUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View official text
                  </a>
                </div>
              )}
            </li>
          ))}
        </ul>

        </section>
      )}
    </main>
  );
}
