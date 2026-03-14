/**
 * AXON Protocol — Out-of-Context Result Store (OCRS)
 *
 * Content-addressed store for tool results. Results live here,
 * NOT in the model's context. The model gets compact summaries
 * and can drill into details on demand.
 */

import { createHash } from "node:crypto";
import { OCRSEntry, ContextBudget, ResultSelector } from "./types.js";

// ============================================================================
// OCRS Implementation
// ============================================================================

export class ResultStore {
  private entries: Map<string, OCRSEntry> = new Map();
  private budget: ContextBudget;
  private contextTokens: Map<string, number> = new Map(); // ref → tokens in context

  constructor(budget?: Partial<ContextBudget>) {
    this.budget = {
      max_summary_tokens: budget?.max_summary_tokens ?? 200,
      max_total_result_tokens: budget?.max_total_result_tokens ?? 4000,
      eviction_policy: budget?.eviction_policy ?? "lru",
    };
  }

  /**
   * Store a tool result and generate a compact reference.
   */
  store(toolId: string, params: Record<string, any>, data: any, summary?: string): OCRSEntry {
    const paramsHash = hash(JSON.stringify(params));
    const dataStr = JSON.stringify(data);
    const contentHash = hash(toolId + paramsHash + dataStr);
    const ref = makeRef(contentHash);

    // Check for duplicate (content-addressed dedup)
    const existing = this.findByHash(contentHash);
    if (existing) {
      existing.accessed_at = Date.now();
      return existing;
    }

    const entry: OCRSEntry = {
      ref,
      hash: contentHash,
      tool_id: toolId,
      params_hash: paramsHash,
      data,
      summary: summary ?? this.autoSummarize(toolId, data),
      created_at: Date.now(),
      accessed_at: Date.now(),
      size_bytes: new TextEncoder().encode(dataStr).byteLength,
      size_tokens_estimate: estimateTokens(dataStr),
    };

    this.entries.set(ref, entry);
    return entry;
  }

  /**
   * Get an entry by reference.
   */
  get(ref: string): OCRSEntry | undefined {
    const entry = this.entries.get(ref);
    if (entry) entry.accessed_at = Date.now();
    return entry;
  }

  /**
   * Query a result with a selector (filter, field selection, pagination).
   * Returns only the requested subset of data.
   */
  query(ref: string, selector: ResultSelector): any {
    const entry = this.get(ref);
    if (!entry) return null;

    let data = entry.data;

    // If data is an array, apply filter/sort/slice
    if (Array.isArray(data)) {
      // Filter
      if (selector.filter) {
        data = data.filter((item: any) => {
          return Object.entries(selector.filter!).every(
            ([key, value]) => item[key] === value
          );
        });
      }

      // Sort
      if (selector.sort) {
        const { field, order } = selector.sort;
        data = [...data].sort((a: any, b: any) => {
          const cmp = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
          return order === "desc" ? -cmp : cmp;
        });
      }

      // Slice
      if (selector.slice) {
        data = data.slice(
          selector.slice.offset,
          selector.slice.offset + selector.slice.limit
        );
      }

      // Field selection
      if (selector.select) {
        data = data.map((item: any) => {
          const selected: any = {};
          for (const field of selector.select!) {
            if (field in item) selected[field] = item[field];
          }
          return selected;
        });
      }
    } else if (typeof data === "object" && data !== null) {
      // For objects, apply field selection
      if (selector.select) {
        const selected: any = {};
        for (const field of selector.select) {
          if (field in data) selected[field] = data[field];
        }
        data = selected;
      }
    }

    return data;
  }

  /**
   * Get the compact summary for injection into model context.
   * Enforces the context budget.
   */
  getSummaryForContext(ref: string): string | null {
    const entry = this.get(ref);
    if (!entry) return null;

    const summaryTokens = estimateTokens(entry.summary);

    // Check if adding this summary exceeds the budget
    const currentTotal = Array.from(this.contextTokens.values()).reduce((a, b) => a + b, 0);
    if (currentTotal + summaryTokens > this.budget.max_total_result_tokens) {
      // Evict based on policy
      this.evict(summaryTokens);
    }

    // Truncate summary if it exceeds per-summary limit
    let summary = entry.summary;
    if (summaryTokens > this.budget.max_summary_tokens) {
      summary = truncateToTokens(summary, this.budget.max_summary_tokens);
    }

    this.contextTokens.set(ref, estimateTokens(summary));
    return `[${entry.tool_id}] ${summary} [ref:${ref}]`;
  }

  /**
   * Evict entries from context (not from store) to free token budget.
   */
  private evict(neededTokens: number): void {
    const entries = Array.from(this.contextTokens.entries());

    switch (this.budget.eviction_policy) {
      case "lru": {
        // Sort by last access time, evict oldest
        entries.sort((a, b) => {
          const entryA = this.entries.get(a[0]);
          const entryB = this.entries.get(b[0]);
          return (entryA?.accessed_at ?? 0) - (entryB?.accessed_at ?? 0);
        });
        break;
      }
      case "priority": {
        // Sort by size, evict largest first
        entries.sort((a, b) => b[1] - a[1]);
        break;
      }
    }

    let freed = 0;
    for (const [ref, tokens] of entries) {
      if (freed >= neededTokens) break;
      this.contextTokens.delete(ref);
      freed += tokens;
    }
  }

  /**
   * Auto-generate a summary from tool output.
   */
  private autoSummarize(toolId: string, data: any): string {
    if (typeof data === "string") {
      const lines = data.split("\n").length;
      const chars = data.length;
      return `${lines} lines, ${chars} chars. Preview: ${data.slice(0, 100)}...`;
    }

    if (Array.isArray(data)) {
      const count = data.length;
      const sample = data.slice(0, 3);
      const keys = count > 0 && typeof data[0] === "object"
        ? Object.keys(data[0]).join(", ")
        : "";
      return `${count} items${keys ? ` (fields: ${keys})` : ""}. First ${Math.min(3, count)}: ${JSON.stringify(sample).slice(0, 150)}`;
    }

    if (typeof data === "object" && data !== null) {
      const keys = Object.keys(data);
      return `Object with ${keys.length} fields: ${keys.join(", ")}`;
    }

    return String(data);
  }

  /**
   * Get store statistics.
   */
  stats(): {
    total_entries: number;
    total_bytes: number;
    total_tokens_estimate: number;
    context_tokens_used: number;
    context_budget_remaining: number;
  } {
    const totalBytes = Array.from(this.entries.values()).reduce((s, e) => s + e.size_bytes, 0);
    const totalTokens = Array.from(this.entries.values()).reduce((s, e) => s + e.size_tokens_estimate, 0);
    const contextUsed = Array.from(this.contextTokens.values()).reduce((a, b) => a + b, 0);

    return {
      total_entries: this.entries.size,
      total_bytes: totalBytes,
      total_tokens_estimate: totalTokens,
      context_tokens_used: contextUsed,
      context_budget_remaining: this.budget.max_total_result_tokens - contextUsed,
    };
  }

  private findByHash(contentHash: string): OCRSEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.hash === contentHash) return entry;
    }
    return undefined;
  }
}

// ============================================================================
// Utilities
// ============================================================================

function hash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Generate OCRS reference: ax_r_<base58(sha256[0:12])>
 */
function makeRef(contentHash: string): string {
  const bytes = Buffer.from(contentHash, "hex").subarray(0, 12);
  return `ax_r_${base58Encode(bytes)}`;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}

const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Buffer): string {
  let num = BigInt("0x" + bytes.toString("hex"));
  let result = "";
  while (num > 0n) {
    const mod = Number(num % 58n);
    result = BASE58_CHARS[mod] + result;
    num = num / 58n;
  }
  // Handle leading zeros
  for (const b of bytes) {
    if (b !== 0) break;
    result = "1" + result;
  }
  return result || "1";
}
