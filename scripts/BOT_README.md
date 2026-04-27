# 🐝 Tech Buzz Daily — Telegram Bot

Bot tự động lấy tin tech từ nhiều nguồn RSS, dùng Gemini AI để tóm tắt + dịch sang tiếng Việt, rồi đăng lên kênh Telegram **mỗi 2 tiếng**.

---

## 📁 Cấu trúc

```
scripts/
├── src/
│   ├── postNews.ts          ← Entry point (chạy 1 bài rồi exit)
│   └── lib/
│       ├── sources.ts       ← Danh sách RSS feeds + bộ lọc tech
│       ├── rss.ts           ← Fetch & parse RSS
│       ├── ai.ts            ← Gemini summarization + retry
│       ├── telegram.ts      ← Đăng bài lên Telegram
│       └── storage.ts       ← Lưu URL đã đăng (chống trùng)
└── data/
    └── posted.json          ← Lịch sử bài đã đăng (tự sinh)

.github/workflows/
└── post-news.yml            ← Cron job mỗi 2 tiếng
```

---

## 🔑 Environment Variables

| Tên | Bắt buộc | Mô tả |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token bot từ @BotFather |
| `TELEGRAM_CHANNEL_ID` | ✅ | `@username_kenh` (public) hoặc `-100xxxxx` (private) |
| `GOOGLE_API_KEY` | ✅ | Gemini API key từ Google AI Studio |
| `TELEGRAM_SIGNATURE` | ❌ | Chữ ký cuối bài (mặc định: `🐝 Tech Buzz Daily`) |

---

## 🧪 Test bot ngay tại Replit

```bash
pnpm --filter @workspace/scripts run post-news
```

Sẽ:
1. Lấy tin từ 10 nguồn RSS
2. Lọc tin chưa đăng + tin tech-relevant
3. Tóm tắt 1 bài bằng Gemini
4. Đăng lên `@techbuzz_daily`

---

## 🚀 Deploy lên GitHub Actions (chạy tự động 24/7)

### Bước 1: Push code lên GitHub

Tạo repo mới trên GitHub (private hoặc public đều được — public free unlimited Actions).

```bash
git init
git add .
git commit -m "Initial commit: Tech Buzz Daily bot"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

### Bước 2: Add Secrets trên GitHub

Vào **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, thêm:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token bot của bạn |
| `TELEGRAM_CHANNEL_ID` | `@techbuzz_daily` |
| `GOOGLE_API_KEY` | Gemini API key |
| `TELEGRAM_SIGNATURE` | `🐝 Tech Buzz Daily` (tùy chọn) |

### Bước 3: Bật workflow

- Vào tab **Actions** trên GitHub
- Nếu lần đầu, bấm **"I understand my workflows, enable them"**
- Workflow `Post Tech News to Telegram` sẽ chạy tự động **mỗi 2 tiếng** (vào phút 5 mỗi tiếng chẵn)
- Có thể chạy thủ công bất cứ lúc nào: Actions tab → workflow → **Run workflow**

### Bước 4: Kiểm tra hoạt động

- Mở tab **Actions** → xem log mỗi lần chạy
- Mở Telegram → kênh của bạn → thấy bài mới đăng

---

## ⚙️ Tùy chỉnh

### Thay đổi tần suất đăng

Sửa `cron` trong `.github/workflows/post-news.yml`:

```yaml
- cron: "5 */2 * * *"   # Mỗi 2 tiếng (mặc định)
- cron: "0 * * * *"     # Mỗi 1 tiếng
- cron: "0 */3 * * *"   # Mỗi 3 tiếng
- cron: "0 9,12,15,18 * * *"  # 4 lần/ngày: 9h, 12h, 15h, 18h UTC
```

### Thêm/bớt nguồn RSS

Sửa `scripts/src/lib/sources.ts`:

```typescript
export const RSS_SOURCES: RssSource[] = [
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "Tên mới", url: "https://example.com/feed.xml" },
  // ...
];
```

### Lọc tin theo từ khóa

Cùng file `sources.ts` — chỉnh `NON_TECH_TITLE_KEYWORDS` (lọc tin không liên quan) và `NON_TECH_PATH_PATTERNS` (lọc URL).

### Thay đổi văn phong / ngôn ngữ tóm tắt

Sửa `PROMPT` trong `scripts/src/lib/ai.ts`. Ví dụ muốn nghiêm túc hơn:

```typescript
const PROMPT = `Bạn là biên tập viên báo công nghệ chuyên nghiệp. Tóm tắt bài viết theo format JSON với văn phong nghiêm túc, chuẩn xác...`;
```

---

## 🔒 Bảo mật

- ✅ Bot chỉ có quyền **Post Messages** → không xóa được tin cũ, không phá kênh
- ✅ Token lưu trong GitHub Secrets → không xuất hiện trong code/logs
- ✅ Posted history commit về repo → bảo toàn cả khi GitHub Actions reset

---

## 💰 Chi phí

| Khoản | Chi phí | Ghi chú |
|---|---|---|
| GitHub Actions | $0 | Public repo unlimited; private 2000 phút/tháng (đủ ~30k phút/ngày bot này dùng) |
| Gemini API | $0 | Free tier: 1500 req/ngày, dùng ~12 req/ngày |
| Telegram Bot API | $0 | Miễn phí vĩnh viễn |
| **Tổng** | **$0/tháng** | |

---

## 🆘 Troubleshooting

### Bot không đăng bài

Check trên GitHub Actions tab xem log:

- **`Bad Request: chat not found`** → Sai `TELEGRAM_CHANNEL_ID` hoặc bot chưa là Admin của kênh
- **`Forbidden: bot is not a member`** → Add bot vào kênh, cấp quyền Post Messages
- **`401 Unauthorized`** → Sai `TELEGRAM_BOT_TOKEN`
- **`API key not valid`** → Sai `GOOGLE_API_KEY`
- **`UNAVAILABLE / 503`** → Gemini quá tải tạm thời, bot tự retry 4 lần với backoff

### Bot đăng bài trùng

- Xóa file `scripts/data/posted.json` rồi commit lại — bot sẽ rebuild lịch sử
- Hoặc check workflow có lỗi commit `posted.json` không

### Muốn đổi sang AI provider khác

Sửa `scripts/src/lib/ai.ts`:
- Đổi import từ `@google/genai` sang `openai`, `groq-sdk`, `@anthropic-ai/sdk`...
- Đổi `apiKey` env var name
- Đổi format gọi API

---

## 📊 Monitoring

- Mở **GitHub Actions** tab → **Post Tech News to Telegram** workflow → xem mỗi lần chạy thành công/thất bại
- GitHub gửi **email tự động** khi workflow fail
