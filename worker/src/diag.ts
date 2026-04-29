/**
 * Phase 16 — diagnostic helpers cho /diag_ai endpoint.
 *
 * Tách riêng khỏi index.ts để (a) unit test được mà không cần kéo cả Cloudflare
 * runtime + transitive imports, và (b) giữ index.ts gọn cho HTTP routing.
 */

import type { Article } from "./rss.js";

/** Kết quả probe 1 AI provider. */
export type DiagProviderResult = {
  provider: string;
  ok: boolean;
  ms: number;
  error?: string;
  previewBytes?: number;
};

/**
 * Probe từng provider trong chain. Catch lỗi PER-PROVIDER (không break loop
 * nếu 1 cái throw) → đảm bảo /diag_ai luôn trả đủ N entry cho N provider,
 * ngay cả khi cái đầu fail.
 */
export async function probeProviders(
  providers: Array<{ name: string; call: (a: Article) => Promise<string> }>,
  article: Article,
): Promise<DiagProviderResult[]> {
  const results: DiagProviderResult[] = [];
  for (const p of providers) {
    const t0 = Date.now();
    try {
      const raw = await p.call(article);
      results.push({
        provider: p.name,
        ok: true,
        ms: Date.now() - t0,
        previewBytes: raw.length,
      });
    } catch (err) {
      results.push({
        provider: p.name,
        ok: false,
        ms: Date.now() - t0,
        error: (err as Error).message?.slice(0, 400),
      });
    }
  }
  return results;
}
