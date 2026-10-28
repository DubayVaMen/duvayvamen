# dubayvamen

Dubay turlari sayti (dubayvamen.uz), Cloudflare Workers'da. `main` branchga har bir push GitHub Actions orqali avtomatik deploy qilinadi.

## Endpointlar
- `/` — sayt (`public/index.html`)
- `GET /api/health` — tekshiruv

## Bir martalik sozlash
1. GitHub'da `duvayvamen` nomli bo'sh repo oching va shu kodni push qiling.
2. Cloudflare → My Profile → API Tokens → **Create Token** → "Edit Cloudflare Workers" shablonini tanlang.
3. Cloudflare dashboard'dan **Account ID** ni nusxalang.
4. GitHub repo → Settings → Secrets and variables → Actions:
   - `CLOUDFLARE_API_TOKEN` — 2-qadamdagi token
   - `CLOUDFLARE_ACCOUNT_ID` — 3-qadamdagi ID
5. Tayyor: endi `main` ga push qilinsa, Worker `https://dubayvamen.<subdomain>.workers.dev` manzilida yangilanadi.

## Lokal ishga tushirish
Node.js 22+ kerak.
```
npm install
npm run dev
```
