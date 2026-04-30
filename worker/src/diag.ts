/**
 * Phase 16/17 — diagnostic helpers cho /diag_ai và /debug_kv.
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
 * Probe từng provider trong chain. Catch lỗi PER-PROVIDER (không break Promise.all
 * nếu 1 cái throw) → đảm bảo /diag_ai luôn trả đủ N entry cho N provider,
 * ngay cả khi cái đầu fail.
 *
 * Phase 20.1: chạy SONG SONG (Promise.all) thay vì sequential — với 18+ provider
 * (9 Gemini key × 2 model) sequential timeout sẽ vượt 30s waitUntil cap của
 * Cloudflare Workers, /quota command không trả về kết quả. Mỗi provider độc lập
 * (key/model riêng) nên parallel KHÔNG share quota — chỉ tăng tốc từ ~2-3 phút
 * worst case xuống ~20-30s tổng (= max single timeout). Vẫn giữ thứ tự kết quả
 * khớp thứ tự input qua Promise.all preserve order.
 */
export async function probeProviders(
  providers: Array<{ name: string; call: (a: Article) => Promise<string> }>,
  article: Article,
): Promise<DiagProviderResult[]> {
  return await Promise.all(
    providers.map(async (p) => {
      const t0 = Date.now();
      try {
        const raw = await p.call(article);
        return {
          provider: p.name,
          ok: true,
          ms: Date.now() - t0,
          previewBytes: raw.length,
        };
      } catch (err) {
        return {
          provider: p.name,
          ok: false,
          ms: Date.now() - t0,
          error: (err as Error).message?.slice(0, 400),
        };
      }
    }),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 17: KV write observability helpers
// ────────────────────────────────────────────────────────────────────────────

/** Kết quả 1 KV write op (markTitlePosted / setLastPosted / ...). */
export type KvOpResult = {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
};

/**
 * Chạy nhiều KV write op SONG SONG, capture per-op timing + error.
 * KHÔNG bao giờ throw — caller nhận về list result để log/return.
 *
 * Tách riêng để index.ts gọn + unit test được logic per-op catching.
 */
export async function runKvOps(
  ops: Array<{ name: string; op: () => Promise<unknown> }>,
): Promise<KvOpResult[]> {
  return await Promise.all(
    ops.map(async ({ name, op }) => {
      const t0 = Date.now();
      try {
        await op();
        return { name, ok: true, ms: Date.now() - t0 };
      } catch (err) {
        return {
          name,
          ok: false,
          ms: Date.now() - t0,
          error: (err as Error).message?.slice(0, 200) ?? "unknown",
        };
      }
    }),
  );
}

/**
 * Tổng hợp list KV op result thành 2 dòng log dễ đọc: 1 dòng status tổng
 * (tên op + ok/FAIL + ms), 1 dòng chi tiết error nếu có fail.
 *
 * Pure function → unit test 100% deterministic không cần mock KV.
 */
export function summarizeKvResults(results: KvOpResult[]): {
  okCount: number;
  failCount: number;
  statusLine: string;
  failDetail?: string;
} {
  const oks = results.filter((r) => r.ok);
  const fails = results.filter((r) => !r.ok);
  const statusLine =
    `${oks.length}/${results.length} OK — ` +
    results.map((r) => `${r.name}=${r.ok ? "ok" : "FAIL"}(${r.ms}ms)`).join(", ");
  const failDetail =
    fails.length > 0
      ? "FAILS: " + fails.map((f) => `${f.name}: ${f.error ?? "unknown"}`).join(" | ")
      : undefined;
  return { okCount: oks.length, failCount: fails.length, statusLine, failDetail };
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 17: KV round-trip probe
// ────────────────────────────────────────────────────────────────────────────

/** Kết quả 1 op trong /debug_kv (put/get/delete). */
export type KvRoundTripOp = {
  op: "put" | "get" | "delete";
  ok: boolean;
  ms: number;
  /** Cho `get`: read-back có khớp giá trị đã write không. */
  matched?: boolean;
  error?: string;
};

/**
 * Subset KVNamespace mà probe cần — cho phép unit test với fake mà không cần
 * import @cloudflare/workers-types runtime.
 */
export type KvLike = {
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
  get: (key: string) => Promise<string | null>;
  delete: (key: string) => Promise<void>;
};

/**
 * Probe round-trip 1 KV namespace: put → get → delete.
 *
 * Lưu ý: KV là eventually consistent. Read ngay sau write có thể trả null
 * (cache edge chưa thấy write). Trong trường hợp đó `matched=false` nhưng
 * `put.ok=true` — đó vẫn là tín hiệu KV nhận được write (binding sống).
 *
 * Trả về list 3 op để admin nhìn rõ stage nào fail.
 */
export async function probeKvRoundTrip(
  kv: KvLike,
  testKey: string,
  testValue: string,
): Promise<KvRoundTripOp[]> {
  const results: KvRoundTripOp[] = [];

  const t0 = Date.now();
  try {
    await kv.put(testKey, testValue, { expirationTtl: 60 });
    results.push({ op: "put", ok: true, ms: Date.now() - t0 });
  } catch (err) {
    results.push({
      op: "put",
      ok: false,
      ms: Date.now() - t0,
      error: (err as Error).message?.slice(0, 200),
    });
    // Put fail → không cần thử get/delete (đằng nào cũng không có gì).
    return results;
  }

  const t1 = Date.now();
  try {
    const readBack = await kv.get(testKey);
    results.push({
      op: "get",
      ok: true,
      ms: Date.now() - t1,
      matched: readBack === testValue,
    });
  } catch (err) {
    results.push({
      op: "get",
      ok: false,
      ms: Date.now() - t1,
      error: (err as Error).message?.slice(0, 200),
    });
  }

  const t2 = Date.now();
  try {
    await kv.delete(testKey);
    results.push({ op: "delete", ok: true, ms: Date.now() - t2 });
  } catch (err) {
    results.push({
      op: "delete",
      ok: false,
      ms: Date.now() - t2,
      error: (err as Error).message?.slice(0, 200),
    });
  }

  return results;
}
