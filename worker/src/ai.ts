import type { Article } from "./rss.js";
import type { Env } from "./index.js";

/**
 * Multi-provider AI summarizer với fallback chain.
 *
 * Provider order (Phase 9.2 — key rotation):
 *   1. gemini-2.5-flash#k0..kN  — primary, mỗi key 1 quota free riêng (xoay vòng)
 *   2. gemini-2.0-flash#k0..kN  — model cũ hơn, có quota RIÊNG → khi 2.5 cạn vẫn chạy
 *   3. openrouter llama / gemma — nhà cung cấp KHÁC hoàn toàn (free tier độc lập)
 *
 * Quy tắc bỏ provider:
 *   - HTTP 429 (quota exhausted) → bỏ luôn provider#key đó cho cả run
 *   - HTTP 5xx / timeout → retry trong provider 2 lần với backoff, fail → bỏ
 *   - Parse JSON thất bại 2 lần → bỏ provider, sang provider kế
 *
 * Trả về `{ summary, provider }` để caller log model + key index nào đã được dùng
 * (vd `gemini-2.5-flash#k1`).
 *
 * Backward compat schema cũ { title, body, takeaway } vẫn parse được.
 */

export type Summary = {
  title: string;
  bullets: string[];
  whyItMatters: string;
};

export type SummarizeResult = {
  summary: Summary;
  provider: string;
};

const PROMPT = `Bạn là biên tập viên cho kênh Telegram "Tech Buzz Daily" — kênh tin tức công nghệ tiếng Việt cho dân tech, tone Gen Z: trẻ, năng động, hơi "lầy" nhưng chuẩn xác.

Hãy tóm tắt bài viết tech sau đây thành tiếng Việt theo format JSON CHÍNH XÁC:
{
  "title": "Tiêu đề tiếng Việt ngắn gọn, hấp dẫn (tối đa 90 ký tự). BẮT BUỘC bắt đầu bằng 1 emoji phù hợp (vd: 🚀 🤖 🧠 🛠️ 🔥 🎯 🪄 🧪 🛡️ 📱 💸).",
  "bullets": ["2-3 bullet, mỗi bullet 1 câu ngắn gọn (≤120 ký tự), tóm tắt fact chính. KHÔNG mở đầu bằng dấu chấm, gạch ngang hay emoji — sẽ được render thành '• ...' tự động."],
  "whyItMatters": "1 câu duy nhất (≤200 ký tự) trả lời 'Vì sao đáng đọc?' — nêu impact/insight cho dân tech Việt, không lặp lại bullet."
}

QUY TẮC:
- Văn phong trẻ, conversational, KHÔNG cứng nhắc kiểu báo chí.
- KHÔNG dịch tên riêng (OpenAI, Google, Meta, Anthropic, Hugging Face...).
- Có thể dùng từ tiếng Anh phổ biến (AI, model, launch, startup, demo, beta, agent, benchmark, fine-tune...).
- Bullet phải có nội dung CỤ THỂ từ bài (số liệu, tên model, ngày, tên người), KHÔNG nói chung chung.
- KHÔNG bịa thông tin ngoài bài. Nếu bài quá ngắn, làm 2 bullet thay vì 3.
- "whyItMatters" phải là góc nhìn / hệ quả, KHÔNG được lặp y nguyên 1 bullet.
- TRẢ VỀ CHỈ JSON hợp lệ, KHÔNG markdown code fence, KHÔNG text giải thích.

Bài viết:
Tiêu đề gốc: {{TITLE}}
Nguồn: {{SOURCE}}
Nội dung: {{CONTENT}}`;

function buildPrompt(article: Article): string {
  const content = article.contentSnippet.slice(0, 3000);
  return PROMPT.replace("{{TITLE}}", article.title)
    .replace("{{SOURCE}}", article.source)
    .replace("{{CONTENT}}", content || article.title);
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────────────────────
// Error types
// ────────────────────────────────────────────────────────────────────────────

class ProviderError extends Error {
  status?: number;
  /** Nếu true → bỏ luôn provider, không retry (vd 429 quota, 401 auth fail, 408 timeout). */
  fatal: boolean;
  /**
   * Phase 18: nếu true → mark provider DEAD cho phần còn lại của run này
   * (deadProviders.add). Khác `fatal`: `markDead` được set khi 5xx LẶP LẠI
   * trong cùng provider attempt flow (≥2 lần) — không phải HTTP-class fatal,
   * nhưng đủ tín hiệu để skip provider này cho candidate sau.
   */
  markDead: boolean;
  constructor(message: string, status?: number, fatal = false, markDead = false) {
    super(message);
    this.status = status;
    this.fatal = fatal;
    this.markDead = markDead;
  }
}

function classifyHttpError(status: number): { fatal: boolean } {
  // 429 = quota / rate limit → coi như cạn, bỏ luôn provider
  // 401/403 = auth fail → bỏ luôn (admin phải sửa key)
  // 408 = request timeout (server-side) → Phase 18: FATAL — provider quá chậm,
  //       không retry, sang provider kế ngay (slow response = waste budget).
  // 5xx = server tạm lỗi → retry trong provider; nếu lặp ≥2 lần, callXxx()
  //       sẽ tự set markDead=true để skip cho candidate sau (xem call site).
  // 4xx khác = bad request → fatal vì retry vô ích
  if (status === 429) return { fatal: true };
  if (status === 401 || status === 403) return { fatal: true };
  if (status === 408) return { fatal: true };
  if (status >= 500 && status < 600) return { fatal: false };
  if (status >= 400 && status < 500) return { fatal: true };
  return { fatal: false };
}

// ────────────────────────────────────────────────────────────────────────────
// Provider: Gemini (REST API trực tiếp)
// ────────────────────────────────────────────────────────────────────────────

// Phase 18 (Apr 29 2026): hạ 20s → 10s, 3 → 2 retry.
// Lý do: free Gemini bình thường response < 5s; nếu > 10s nghĩa là endpoint
// đang hang. Worst case 1 provider giờ = 2×10 + 2 (backoff) = 22s thay vì
// 3×20 + 6 = 66s. Cùng với 408 → fatal, slow timeout không lặp lại candidate sau.
const GEMINI_TIMEOUT_MS = 10_000;
const GEMINI_MAX_RETRIES = 2;

async function callGemini(
  modelId: string,
  article: Article,
  apiKey: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const reqBody = {
    contents: [{ role: "user", parts: [{ text: buildPrompt(article) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
  };

  let lastErr: ProviderError | undefined;
  // Phase 18: đếm số lần 5xx trong attempt flow này. Nếu ≥ 2 sau khi exhaust
  // retries → mark provider dead cho phần còn lại của run (xem catch ở
  // summarizeArticle). Lý do: 5xx 1 lần có thể là blip; 5xx LẶP LẠI là dấu
  // hiệu provider/upstream đang down — không nên test lại với candidate kế.
  let serverErrorCount = 0;
  for (let attempt = 0; attempt < GEMINI_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const { fatal } = classifyHttpError(res.status);
        const err = new ProviderError(
          `Gemini ${modelId} HTTP ${res.status}: ${errText.slice(0, 300)}`,
          res.status,
          fatal,
        );
        if (res.status >= 500 && res.status < 600) serverErrorCount++;
        if (fatal) throw err;
        lastErr = err;
      } else {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new ProviderError(`Gemini ${modelId} empty response`, undefined, false);
        return text;
      }
    } catch (err) {
      if (err instanceof ProviderError && err.fatal) throw err;
      const isAbort = (err as Error).name === "AbortError";
      if (isAbort) {
        // Phase 18: client-side timeout = 408 = fatal (xem classifyHttpError).
        // Throw ngay để summarizeArticle mark provider dead, không waste retry.
        const { fatal } = classifyHttpError(408);
        throw new ProviderError(
          `Gemini ${modelId} timeout ${GEMINI_TIMEOUT_MS}ms`,
          408,
          fatal,
        );
      }
      lastErr = err instanceof ProviderError
        ? err
        : new ProviderError(`Gemini ${modelId} network: ${(err as Error).message}`, undefined, false);
    } finally {
      clearTimeout(timeoutId);
    }
    if (attempt < GEMINI_MAX_RETRIES - 1) {
      const backoffMs = 2000 * Math.pow(2, attempt);
      console.warn(
        `[ai] Gemini ${modelId} retry ${attempt + 1}/${GEMINI_MAX_RETRIES} ` +
          `in ${backoffMs}ms: ${lastErr?.message?.slice(0, 200)}`,
      );
      await sleep(backoffMs);
    }
  }
  // Phase 18: nếu ≥2 lần 5xx → upgrade lastErr thành markDead để summarizeArticle
  // bỏ provider này cho candidate sau.
  if (lastErr && serverErrorCount >= 2) {
    lastErr.markDead = true;
    console.warn(
      `[ai] Gemini ${modelId} 5xx lặp ${serverErrorCount} lần → mark dead cho run này.`,
    );
  }
  throw lastErr ?? new ProviderError(`Gemini ${modelId} unknown failure`, undefined, false);
}

// ────────────────────────────────────────────────────────────────────────────
// Provider: OpenRouter (OpenAI-compatible chat completions)
// ────────────────────────────────────────────────────────────────────────────

const OPENROUTER_TIMEOUT_MS = 25_000;
const OPENROUTER_MAX_RETRIES = 2;
/**
 * OpenRouter free models. Mỗi model là 1 provider riêng trong chain để
 * resilient với per-model upstream rate-limit (free tier OpenRouter giới hạn
 * theo model).
 *
 * Nếu model bị deprecated (HTTP 404 "No endpoints found"), liệt kê model free
 * mới qua `GET https://openrouter.ai/api/v1/models` rồi filter id chứa ":free".
 */
const OPENROUTER_MODEL_LLAMA = "meta-llama/llama-3.3-70b-instruct:free";
const OPENROUTER_MODEL_GEMMA = "google/gemma-3-27b-it:free";

async function callOpenRouter(
  model: string,
  article: Article,
  apiKey: string,
): Promise<string> {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const reqBody = {
    model,
    messages: [{ role: "user", content: buildPrompt(article) }],
    response_format: { type: "json_object" },
    temperature: 0.7,
    max_tokens: 1024,
  };

  let lastErr: ProviderError | undefined;
  // Phase 18: cùng cơ chế đếm 5xx như Gemini → mark dead nếu ≥2 lần.
  let serverErrorCount = 0;
  for (let attempt = 0; attempt < OPENROUTER_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter dùng để rank app — không bắt buộc nhưng nên có
          "HTTP-Referer": "https://techbuzz-bot.workers.dev",
          "X-Title": "Tech Buzz Daily Bot",
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const { fatal } = classifyHttpError(res.status);
        const err = new ProviderError(
          `OpenRouter[${model}] HTTP ${res.status}: ${errText.slice(0, 300)}`,
          res.status,
          fatal,
        );
        if (res.status >= 500 && res.status < 600) serverErrorCount++;
        if (fatal) throw err;
        lastErr = err;
      } else {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string; code?: number };
        };
        // OpenRouter có thể trả 200 nhưng body có error (rate limit ngầm)
        if (data.error) {
          // OpenRouter có thể trả code dưới dạng string ("429") hoặc number (429).
          // Normalize qua Number() để fatal detection không bị miss.
          const code = Number(data.error.code ?? 0) || 0;
          const isFatal = code === 429 || code === 401 || code === 403;
          const err = new ProviderError(
            `OpenRouter[${model}] body error: ${data.error.message ?? "unknown"}`,
            code,
            isFatal,
          );
          if (code >= 500 && code < 600) serverErrorCount++;
          if (isFatal) throw err;
          lastErr = err;
        } else {
          const text = data?.choices?.[0]?.message?.content;
          if (!text) {
            throw new ProviderError("OpenRouter empty response", undefined, false);
          }
          return text;
        }
      }
    } catch (err) {
      if (err instanceof ProviderError && err.fatal) throw err;
      const isAbort = (err as Error).name === "AbortError";
      if (isAbort) {
        // Phase 18: client-side timeout = 408 = fatal.
        const { fatal } = classifyHttpError(408);
        throw new ProviderError(
          `OpenRouter[${model}] timeout ${OPENROUTER_TIMEOUT_MS}ms`,
          408,
          fatal,
        );
      }
      lastErr = err instanceof ProviderError
        ? err
        : new ProviderError(
            `OpenRouter[${model}] network: ${(err as Error).message}`,
            undefined,
            false,
          );
    } finally {
      clearTimeout(timeoutId);
    }
    if (attempt < OPENROUTER_MAX_RETRIES - 1) {
      const backoffMs = 2000 * Math.pow(2, attempt);
      console.warn(
        `[ai] OpenRouter retry ${attempt + 1}/${OPENROUTER_MAX_RETRIES} in ${backoffMs}ms: ` +
          `${lastErr?.message?.slice(0, 200)}`,
      );
      await sleep(backoffMs);
    }
  }
  if (lastErr && serverErrorCount >= 2) {
    lastErr.markDead = true;
    console.warn(
      `[ai] OpenRouter[${model}] 5xx lặp ${serverErrorCount} lần → mark dead cho run này.`,
    );
  }
  throw lastErr ?? new ProviderError("OpenRouter unknown failure", undefined, false);
}

// ────────────────────────────────────────────────────────────────────────────
// Provider chain definition
// ────────────────────────────────────────────────────────────────────────────

type Provider = {
  /** Tên provider: vd "gemini-2.5-flash#k0" hoặc "openrouter-llama". */
  name: string;
  call: (article: Article) => Promise<string>;
};

/**
 * Số lượng tối đa Gemini API key phụ. Tăng nếu cần thêm key (set
 * `GOOGLE_API_KEY_4`, `_5`, ...). Mỗi key tương ứng 1 tài khoản Google.
 */
const MAX_GEMINI_EXTRA_KEYS = 8;

/**
 * Gom tất cả Gemini API key có sẵn trong env, ưu tiên `GOOGLE_API_KEY` (gốc),
 * sau đó `GOOGLE_API_KEY_1`, `_2`, ... Mỗi key sẽ tạo ra 1 provider riêng cho
 * mỗi model Gemini → bot xoay vòng key khi 1 key cạn quota.
 */
function collectGeminiKeys(env: Env): Array<{ slug: string; key: string }> {
  const keys: Array<{ slug: string; key: string }> = [];
  if (env.GOOGLE_API_KEY) keys.push({ slug: "k0", key: env.GOOGLE_API_KEY });
  for (let i = 1; i <= MAX_GEMINI_EXTRA_KEYS; i++) {
    const k = (env as unknown as Record<string, string | undefined>)[`GOOGLE_API_KEY_${i}`];
    if (k) keys.push({ slug: `k${i}`, key: k });
  }
  return keys;
}

/**
 * Build provider chain động dựa trên env (số key Gemini sẵn có + có/không
 * OpenRouter). Thứ tự ưu tiên:
 *   1. Tất cả key của `gemini-2.5-flash` (chất lượng tốt nhất)
 *   2. Tất cả key của `gemini-2.0-flash` (quota cao hơn, fallback)
 *   3. OpenRouter Llama
 *   4. OpenRouter Gemma
 *
 * Suffix `#kN` chỉ thêm khi có >1 key Gemini (giữ tên cũ "gemini-2.5-flash"
 * khi chỉ có 1 key cho dễ đọc log + backward compat với last_posted cũ).
 */
export function getProviders(env: Env): Provider[] {
  const providers: Provider[] = [];
  const geminiKeys = collectGeminiKeys(env);
  const multiKey = geminiKeys.length > 1;

  for (const { slug, key } of geminiKeys) {
    providers.push({
      name: multiKey ? `gemini-2.5-flash#${slug}` : "gemini-2.5-flash",
      call: (article) => callGemini("gemini-2.5-flash", article, key),
    });
  }
  for (const { slug, key } of geminiKeys) {
    providers.push({
      name: multiKey ? `gemini-2.0-flash#${slug}` : "gemini-2.0-flash",
      call: (article) => callGemini("gemini-2.0-flash", article, key),
    });
  }
  if (env.OPENROUTER_API_KEY) {
    const orKey = env.OPENROUTER_API_KEY;
    providers.push({
      name: "openrouter-llama",
      call: (article) => callOpenRouter(OPENROUTER_MODEL_LLAMA, article, orKey),
    });
    providers.push({
      // Model OpenRouter khác để khi Llama bị upstream rate-limit
      // (free tier OpenRouter giới hạn theo model riêng) vẫn còn cửa.
      name: "openrouter-gemma",
      call: (article) => callOpenRouter(OPENROUTER_MODEL_GEMMA, article, orKey),
    });
  }
  return providers;
}

// ────────────────────────────────────────────────────────────────────────────
// Parse logic (không thay đổi vs phiên bản trước)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse JSON từ LLM. Hỗ trợ:
 *   - Schema mới: { title, bullets[], whyItMatters }
 *   - Schema cũ:  { title, body, takeaway } → convert sang bullets từ body
 *
 * Sanitize bullets: bỏ marker đầu ('-', '•', '*', '·', '–', '—'), trim.
 */
function tryParseSummary(rawText: string): Summary | null {
  const cleaned = stripCodeFences(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return null;

  // Schema mới
  if (Array.isArray(obj.bullets) && typeof obj.whyItMatters === "string") {
    const bullets = sanitizeBullets(obj.bullets);
    const why = obj.whyItMatters.trim();
    if (bullets.length === 0 || !why) return null;
    return { title, bullets, whyItMatters: why };
  }

  // Schema cũ — fallback graceful
  if (typeof obj.body === "string" && typeof obj.takeaway === "string") {
    const sentences = obj.body
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const bullets = sanitizeBullets(sentences.slice(0, 3));
    const why = obj.takeaway.trim();
    if (bullets.length === 0 || !why) return null;
    return { title, bullets, whyItMatters: why };
  }

  return null;
}

const BULLET_MARKER_REGEX = /^[\s\-•*·–—]+/;
const MAX_BULLETS = 3;
const MAX_BULLET_CHARS = 220;

function sanitizeBullets(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item.replace(BULLET_MARKER_REGEX, "").trim();
    if (!cleaned) continue;
    out.push(cleaned.length > MAX_BULLET_CHARS ? cleaned.slice(0, MAX_BULLET_CHARS - 1) + "…" : cleaned);
    if (out.length >= MAX_BULLETS) break;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────────────

// Phase 18 (Apr 29 2026): hạ 2 → 1.
// Lý do: nếu provider trả non-JSON 1 lần thì retry 1 lần nữa thường cũng fail
// (LLM cùng prompt, cùng temperature → output tương tự). Tiết kiệm 1 round-trip.
const PARSE_RETRIES_PER_PROVIDER = 1;

/**
 * Tóm tắt bài viết. Build provider chain từ env (xem `getProviders`) rồi thử
 * lần lượt từng provider.
 *
 * Mỗi provider được:
 *   - thử tối đa PARSE_RETRIES_PER_PROVIDER lần để parse JSON hợp lệ
 *   - nếu HTTP fatal (429/401/403) → bỏ luôn provider, sang cái kế
 *   - nếu network/timeout/5xx → đã retry sẵn trong callXxx()
 *
 * **Circuit breaker (Phase 9.1)**: caller có thể truyền `deadProviders` Set để
 * lưu provider đã fatal trong run hiện tại. Mỗi article kế tiếp sẽ skip ngay
 * provider đã chết → tiết kiệm HTTP call khi quota cạn. Set được mutate in-place.
 *
 * Throw nếu TẤT CẢ provider fail. Caller (index.ts) sẽ catch để thử bài kế tiếp.
 */
export async function summarizeArticle(
  article: Article,
  env: Env,
  deadProviders?: Set<string>,
): Promise<SummarizeResult> {
  const errors: string[] = [];
  const providers = getProviders(env);
  if (providers.length === 0) {
    throw new Error("No AI provider configured (cần ít nhất GOOGLE_API_KEY hoặc OPENROUTER_API_KEY)");
  }

  for (const provider of providers) {
    if (deadProviders?.has(provider.name)) {
      console.log(`[ai] Skip ${provider.name} — đã fatal trong run này (circuit breaker)`);
      errors.push(`${provider.name}: skipped (dead)`);
      continue;
    }

    let parseFailedTimes = 0;
    let providerSkipped = false;
    let lastRaw = "";

    for (let attempt = 0; attempt < PARSE_RETRIES_PER_PROVIDER; attempt++) {
      try {
        const raw = await provider.call(article);
        lastRaw = raw;
        const summary = tryParseSummary(raw);
        if (summary) {
          if (errors.length > 0 || attempt > 0) {
            console.log(`[ai] ✔ Success với ${provider.name} (sau khi thử ${errors.length} provider trước)`);
          }
          return { summary, provider: provider.name };
        }
        parseFailedTimes++;
        console.warn(
          `[ai] ${provider.name} parse fail ${attempt + 1}/${PARSE_RETRIES_PER_PROVIDER}. ` +
            `Raw: ${raw.slice(0, 200)}`,
        );
        await sleep(500);
      } catch (err) {
        const msg = (err as Error).message?.slice(0, 200) ?? "unknown";
        if (err instanceof ProviderError && err.fatal) {
          console.warn(`[ai] ${provider.name} FATAL (status=${err.status}) → fallback. ${msg}`);
          errors.push(`${provider.name}: ${msg}`);
          // Mark provider as dead cho các article tiếp theo trong cùng run
          deadProviders?.add(provider.name);
          providerSkipped = true;
          break;
        }
        // Phase 18: nếu callXxx() đã exhaust retries với 5xx lặp lại ≥2 lần
        // → markDead = true → cũng add vào deadProviders cho candidate sau.
        if (err instanceof ProviderError && err.markDead) {
          console.warn(
            `[ai] ${provider.name} DEAD-FOR-RUN (status=${err.status}, 5xx lặp) → fallback. ${msg}`,
          );
          errors.push(`${provider.name}: ${msg}`);
          deadProviders?.add(provider.name);
          providerSkipped = true;
          break;
        }
        // Non-fatal đã retry hết trong call*; coi như provider chết tạm.
        // KHÔNG add vào deadProviders vì có thể chỉ network glitch tạm thời.
        console.warn(`[ai] ${provider.name} non-fatal nhưng retry hết → fallback. ${msg}`);
        errors.push(`${provider.name}: ${msg}`);
        providerSkipped = true;
        break;
      }
    }

    if (!providerSkipped) {
      // Đã hết PARSE_RETRIES mà vẫn parse fail
      errors.push(
        `${provider.name}: parse fail ${parseFailedTimes}x. Last raw: ${lastRaw.slice(0, 200)}`,
      );
    }
  }

  throw new Error(`All AI providers failed. Errors: ${errors.join(" | ")}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers for testing
// ────────────────────────────────────────────────────────────────────────────

export const __test = {
  tryParseSummary,
  sanitizeBullets,
  classifyHttpError,
  collectGeminiKeys,
  getProviders,
  ProviderError,
};
