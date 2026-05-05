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

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [codebookId, setCodebookId] = useState("irc-utah-2021");
  const [includeAmendments, setIncludeAmendments] = useState(true);
  const [answer, setAnswer] = useState<string | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiSummaryDisclaimer, setAiSummaryDisclaimer] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [amendments, setAmendments] = useState<AmendmentRef[]>([]);
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

  function queryLooksLikeExplicitTable(queryText: string): boolean {
    return /\btable\s+[a-z]?\d+(?:\.\d+)*(?:\([0-9a-z]+\))?/i.test(queryText);
  }

  function extractCitedSourceIds(answerText: string): Set<number> {
    const out = new Set<number>();
    const pattern = /\[source\s+(\d+),\s+lines\s+\d+[-–]\d+\]/gi;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(answerText)) !== null) {
      const id = Number(match[1]);
      if (Number.isFinite(id)) out.add(id);
    }
    return out;
  }

  function filterSourcesByAnswer(
    sourcesList: SourceRef[],
    answerText: string | null,
    queryText?: string
  ): SourceRef[] {
    const explicitTableQuery = queryLooksLikeExplicitTable(queryText || "");
    const tableSource =
      sourcesList.find((s) => s.isTable && (s.tablePdfUrl || s.tableImageUrl)) ||
      null;

    if (!answerText) {
      return tableSource ? [tableSource] : [];
    }
    const cited = extractCitedSourceIds(answerText);
    if (cited.size === 0) {
      if (explicitTableQuery && tableSource) return [tableSource];
      return sourcesList;
    }
    const seenPath = new Set<string>();
    const out: SourceRef[] = [];

    if (explicitTableQuery && tableSource) {
      seenPath.add(tableSource.sourcePath);
      out.push(tableSource);
    }

    for (const s of sourcesList) {
      if (!cited.has(s.sourceId)) continue;
      if (seenPath.has(s.sourcePath)) continue;
      seenPath.add(s.sourcePath);
      out.push(s);
    }
    return out;
  }


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
    setAiSummary(null);
    setAiSummaryDisclaimer(null);
    setSources([]);
    setAmendments([]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          codebookId, // <-- use this, not selectedCodebookId
          topK: 6,
          includeAmendments,
          sessionId, // <-- new field for memory
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
        const tableOnly = (data.sources || []).some(
          (s) => s.isTable && (s.tablePdfUrl || s.tableImageUrl)
        );
        setAnswer(null);
        setAiSummary(null);
        setAiSummaryDisclaimer(null);
        setSources(data.sources || []);
        setAmendments(data.amendments || []);
        setError(
          tableOnly
            ? null
            : data.reason ||
                "The assistant could not answer from the provided code sections."
        );
        return;
      }

      setAnswer(data.answer || null);
      setAiSummary(data.aiSummary || null);
      setAiSummaryDisclaimer(data.aiSummaryDisclaimer || null);
      setSources(
        filterSourcesByAnswer(data.sources || [], data.answer || null, trimmed)
      );
      setAmendments(data.amendments || []);
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

  const primaryTableSource =
    sources.find((s) => s.isTable && (s.tablePdfUrl || s.tableImageUrl)) || null;
  const hasPrimaryTableAnswer = Boolean(primaryTableSource);
  const secondarySources = primaryTableSource
    ? sources.filter((s) => s !== primaryTableSource)
    : sources;

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

      {hasPrimaryTableAnswer && primaryTableSource && (
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
              borderRadius: "8px",
              border: "1px solid #dbe4f0",
              backgroundColor: "#f8fbff",
              padding: "0.75rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.75rem",
                marginBottom: primaryTableSource.tablePdfUrl || primaryTableSource.tableImageUrl ? "0.75rem" : 0,
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontSize: "0.95rem", fontWeight: 600 }}>
                {primaryTableSource.tableLabel || primaryTableSource.sectionLabel || "Matched table"}
                {primaryTableSource.tablePage ? `, PDF page ${primaryTableSource.tablePage}` : ""}
              </div>
              {primaryTableSource.tablePdfUrl && (
                <a
                  href={primaryTableSource.tablePdfUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: "0.85rem",
                    color: "#2563eb",
                    textDecoration: "none",
                    fontWeight: 500,
                  }}
                >
                  Open table PDF
                </a>
              )}
            </div>
            {primaryTableSource.tablePdfUrl ? (
              <iframe
                src={primaryTableSource.tablePdfUrl}
                title={primaryTableSource.tableLabel || primaryTableSource.sectionLabel || "Table PDF"}
                style={{
                  display: "block",
                  width: "100%",
                  height: "720px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  backgroundColor: "#fff",
                }}
              />
            ) : primaryTableSource.tableImageUrl ? (
              <a href={primaryTableSource.tableImageUrl} target="_blank" rel="noreferrer">
                <img
                  src={primaryTableSource.tableImageUrl}
                  alt={primaryTableSource.tableLabel || primaryTableSource.sectionLabel || "Table preview"}
                  loading="lazy"
                  style={{
                    display: "block",
                    width: "100%",
                    maxHeight: "720px",
                    objectFit: "contain",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    backgroundColor: "#fff",
                  }}
                />
              </a>
            ) : (
              <div style={{ fontSize: "0.85rem", color: "#555" }}>
                No preview asset is available for this table yet.
              </div>
            )}
          </div>
        </section>
      )}

      {answer && (
        <>
          {aiSummary && (
            <section style={{ marginBottom: "1.5rem" }}>
              <h2
                style={{
                  fontSize: "1.25rem",
                  fontWeight: 600,
                  marginBottom: "0.5rem",
                }}
              >
                AI Summary
              </h2>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.5,
                  fontSize: "0.95rem",
                  borderRadius: "4px",
                  border: "1px solid #f5c27a",
                  padding: "0.75rem",
                  backgroundColor: "#fff8eb",
                }}
              >
                <div
                  style={{
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    color: "#92400e",
                    marginBottom: "0.5rem",
                  }}
                >
                  {aiSummaryDisclaimer ||
                    "AI-generated plain-language summary. It is not the official code text and may be incomplete or inaccurate."}
                </div>
                {aiSummary}
              </div>
            </section>
          )}

          <section style={{ marginBottom: "1.5rem" }}>
            <h2
              style={{
                fontSize: "1.25rem",
                fontWeight: 600,
                marginBottom: "0.5rem",
              }}
            >
              {hasPrimaryTableAnswer ? "Text Answer" : "Answer"}
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

          <section style={{ marginBottom: "1.5rem" }}>
            <h3
              style={{
                fontSize: "1.1rem",
                fontWeight: 600,
                marginBottom: "0.5rem",
              }}
            >
              Related Amendments
            </h3>
            {amendments.length === 0 ? (
              <div style={{ fontSize: "0.9rem", color: "#555" }}>
                None found
              </div>
            ) : (
              <ul style={{ paddingLeft: "1.2rem" }}>
                {amendments.map((a) => {
                  const label = a.sectionLabel || a.sourcePath;
                  const link =
                    a.publicUrl ||
                    (a.sourcePath?.startsWith("http") ? a.sourcePath : undefined);
                  return (
                  <li key={`${a.id}-${a.sourceId}`} style={{ marginBottom: "1rem" }}>
                    <div>
                      <strong>
                        {a.citation}{" "}
                        {link ? (
                          <a href={link} target="_blank" rel="noreferrer">
                            {label}
                          </a>
                        ) : (
                          label
                        )}
                      </strong>
                    </div>
                    <div style={{ fontSize: "0.85rem", marginTop: "0.15rem" }}>
                      {a.publicUrl ? (
                        <a href={a.publicUrl} target="_blank" rel="noreferrer">
                          Click here to view the official source
                        </a>
                      ) : (
                        <span style={{ color: "#666" }}>
                          Click here to view the official source
                        </span>
                      )}
                    </div>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        lineHeight: 1.4,
                        fontSize: "0.9rem",
                        borderRadius: "4px",
                        border: "1px solid #ddd",
                        padding: "0.75rem",
                        backgroundColor: "#f8fafc",
                        marginTop: "0.5rem",
                      }}
                    >
                      {a.fullText}
                    </pre>
                  </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      {secondarySources.length > 0 && (
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
            {secondarySources.map((s) => {
              const labelLink =
                s.publicUrl ||
                (s.sourcePath?.startsWith("http") ? s.sourcePath : undefined);
              const displayLabel = s.tableLabel || s.sectionLabel;
              return (
              <li key={s.sourceId} style={{ marginBottom: "0.6rem" }}>
                <div>
                  <strong>
                    [source {s.sourceId}] {s.codebookLabel}
                  </strong>
                </div>
                {displayLabel && (
                  <div style={{ fontSize: "0.9rem" }}>
                    {labelLink ? (
                      <a href={labelLink} target="_blank" rel="noreferrer">
                        {displayLabel}
                      </a>
                    ) : (
                      displayLabel
                    )}
                  </div>
                )}
                <div style={{ fontSize: "0.85rem", color: "#555" }}>
                  {labelLink && s.sourcePath?.startsWith("http") ? (
                    <a href={s.sourcePath} target="_blank" rel="noreferrer">
                      {s.sourcePath}
                    </a>
                  ) : (
                    s.sourcePath
                  )}
                  , lines {s.startLine}-{s.endLine}
                </div>
                <div style={{ fontSize: "0.85rem", marginTop: "0.15rem" }}>
                  {s.publicUrl ? (
                    <a href={s.publicUrl} target="_blank" rel="noreferrer">
                      Click here to view the official source
                    </a>
                  ) : (
                    <span style={{ color: "#666" }}>
                      Click here to view the official source
                    </span>
                  )}
                </div>
                {s.isTable && (
                  <div
                    style={{
                      marginTop: "0.75rem",
                      padding: "0.75rem",
                      border: "1px solid #dbe4f0",
                      borderRadius: "8px",
                      backgroundColor: "#f8fbff",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "0.75rem",
                        marginBottom: s.tablePdfUrl || s.tableImageUrl ? "0.75rem" : 0,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>
                        {s.tableLabel || "Table preview"}
                        {s.tablePage ? `, PDF page ${s.tablePage}` : ""}
                      </div>
                      {s.tablePdfUrl && (
                        <a
                          href={s.tablePdfUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: "0.85rem",
                            color: "#2563eb",
                            textDecoration: "none",
                            fontWeight: 500,
                          }}
                        >
                          Open table PDF
                        </a>
                      )}
                    </div>
                    {s.tablePdfUrl ? (
                      <iframe
                        src={s.tablePdfUrl}
                        title={s.tableLabel || s.sectionLabel || "Table PDF"}
                        style={{
                          display: "block",
                          width: "100%",
                          height: "560px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          backgroundColor: "#fff",
                        }}
                      />
                    ) : s.tableImageUrl ? (
                      <a href={s.tableImageUrl} target="_blank" rel="noreferrer">
                        <img
                          src={s.tableImageUrl}
                          alt={s.tableLabel || s.sectionLabel || "Table preview"}
                          loading="lazy"
                          style={{
                            display: "block",
                            width: "100%",
                            maxHeight: "520px",
                            objectFit: "contain",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            backgroundColor: "#fff",
                          }}
                        />
                      </a>
                    ) : (
                      <div style={{ fontSize: "0.85rem", color: "#555" }}>
                        No preview asset is available for this table yet.
                      </div>
                    )}
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
