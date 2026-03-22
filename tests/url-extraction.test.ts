/**
 * Unit tests for extractUrlsFromText() in src/executor.ts
 *
 * Covers: markdown link extraction, bare URL extraction, deduplication,
 * mediaUrls exclusion, non-file URL filtering, and mixed content.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractUrlsFromText } from "../src/executor.js";

// ---------------------------------------------------------------------------
// Markdown link extraction
// ---------------------------------------------------------------------------

describe("extractUrlsFromText – markdown links", () => {
  it("extracts URL from a markdown link with file extension", () => {
    const text = "Here is the [report](https://example.com/report.pdf).";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, ["https://example.com/report.pdf"]);
  });

  it("extracts multiple markdown links", () => {
    const text =
      "See [chart](https://example.com/chart.png) and [data](https://example.com/data.csv).";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, [
      "https://example.com/chart.png",
      "https://example.com/data.csv",
    ]);
  });

  it("handles markdown link with query string", () => {
    const text = "Download [file](https://cdn.example.com/doc.pdf?token=abc123).";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, ["https://cdn.example.com/doc.pdf?token=abc123"]);
  });
});

// ---------------------------------------------------------------------------
// Bare URL extraction
// ---------------------------------------------------------------------------

describe("extractUrlsFromText – bare URLs", () => {
  it("extracts a bare URL with file extension", () => {
    const text = "Check https://example.com/data.csv for details";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, ["https://example.com/data.csv"]);
  });

  it("extracts http:// bare URL", () => {
    const text = "Available at http://files.example.com/archive.zip";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, ["http://files.example.com/archive.zip"]);
  });

  it("extracts bare URL with path segments", () => {
    const text = "See https://storage.example.com/uploads/2026/03/image.jpg here.";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, ["https://storage.example.com/uploads/2026/03/image.jpg"]);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("extractUrlsFromText – deduplication", () => {
  it("returns each URL only once when it appears multiple times", () => {
    const text =
      "Download https://example.com/report.pdf and also https://example.com/report.pdf again.";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, ["https://example.com/report.pdf"]);
  });

  it("deduplicates across markdown and bare occurrences", () => {
    const text =
      "See [report](https://example.com/report.pdf) or visit https://example.com/report.pdf directly.";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, ["https://example.com/report.pdf"]);
  });
});

// ---------------------------------------------------------------------------
// No double-extraction (mediaUrls exclusion)
// ---------------------------------------------------------------------------

describe("extractUrlsFromText – mediaUrls exclusion", () => {
  it("excludes URLs already present in existingUrls", () => {
    const text = "Here is the [report](https://example.com/report.pdf).";
    const existing = ["https://example.com/report.pdf"];
    const urls = extractUrlsFromText(text, existing);
    assert.deepEqual(urls, []);
  });

  it("keeps URLs not in existingUrls while excluding those that are", () => {
    const text =
      "Files: [a](https://example.com/a.pdf) and [b](https://example.com/b.csv).";
    const existing = ["https://example.com/a.pdf"];
    const urls = extractUrlsFromText(text, existing);
    assert.deepEqual(urls, ["https://example.com/b.csv"]);
  });
});

// ---------------------------------------------------------------------------
// Non-file URLs ignored
// ---------------------------------------------------------------------------

describe("extractUrlsFromText – non-file URLs ignored", () => {
  it("does NOT extract plain webpage URLs without file extension", () => {
    const text = "Visit https://example.com/page for more info.";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, []);
  });

  it("does NOT extract markdown links to web pages", () => {
    const text = "See [docs](https://example.com/docs/getting-started) for details.";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, []);
  });

  it("does NOT extract URLs ending with unrecognized extensions", () => {
    const text = "Check https://example.com/page.html and https://example.com/app.exe";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, []);
  });
});

// ---------------------------------------------------------------------------
// Mixed content
// ---------------------------------------------------------------------------

describe("extractUrlsFromText – mixed content", () => {
  it("extracts file URLs from text with multiple markdown links and bare URLs", () => {
    const text = [
      "I generated the following outputs:",
      "- [Analysis Report](https://cdn.example.com/analysis.pdf)",
      "- Raw data: https://cdn.example.com/raw-data.csv",
      "- Dashboard: https://app.example.com/dashboard",
      "- Also check https://cdn.example.com/chart.png for the chart",
      "- [Project Page](https://example.com/project)",
    ].join("\n");

    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, [
      "https://cdn.example.com/analysis.pdf",
      "https://cdn.example.com/raw-data.csv",
      "https://cdn.example.com/chart.png",
    ]);
  });

  it("handles mixed content with existingUrls filtering", () => {
    const text =
      "See [report](https://example.com/report.pdf) and https://example.com/data.xlsx";
    const existing = ["https://example.com/report.pdf"];
    const urls = extractUrlsFromText(text, existing);
    assert.deepEqual(urls, ["https://example.com/data.xlsx"]);
  });

  it("returns empty array when text has no URLs", () => {
    const text = "This is plain text with no URLs at all.";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, []);
  });

  it("returns empty array for empty string", () => {
    const urls = extractUrlsFromText("");
    assert.deepEqual(urls, []);
  });
});
