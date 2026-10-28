# dubayvamen

Dubay turlari sayti (dubayvamen.uz), Cloudflare Workers'da. `main` branchga har bir push GitHub Actions orqali avtomatik deploy qilinadi.

## Manzillar
- `/` — sayt (`public/index.html`)
- `/admin` — admin panel (`public/admin/index.html`): turlar, buyurtmalar, sozlamalar
- `/api/*` — Worker (`src/index.js`), ma'lumotlar Cloudflare KV'da

## Admin panelga kirish
Faqat Telegram orqali. Panel faqat `ADMIN_TG_IDS` ro'yxatidagi akkauntlarda ochiladi.
Yangi buyurtma tushganda shu akkauntlarga bot orqali xabar keladi.

## GitHub secret'lari (Settings → Secrets and variables → Actions)
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — deploy uchun
- `TELEGRAM_BOT_TOKEN` — @BotFather → /mybots → bot → API Token
- `ADMIN_TG_IDS` — admin Telegram ID lari, vergul bilan: `123456789,987654321`

@BotFather'da `/setdomain` orqali bot domenini sayt manziliga sozlang, aks holda Telegram kirish tugmasi chiqmaydi.

## Lokal ishga tushirish
Node.js 22+ kerak. `.dev.vars` faylida `TELEGRAM_BOT_TOKEN` va `ADMIN_TG_IDS` bo'lsin.
```
npm install
npm run dev
```
