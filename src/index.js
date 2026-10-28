// dubayvamen — sayt public/ dan beriladi, bu Worker faqat /api/* ni boshqaradi.
// Ma’lumotlar Cloudflare KV (env.DB) da saqlanadi:
//   "data"          — sozlamalar va turlar ro‘yxati (admin paneldan tahrirlanadi)
//   "order:<vaqt>"  — mijozlar buyurtmalari
//   "img:<id>"      — admin yuklagan rasmlar

import SEED from "./seed.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const keyOf = (raw) => crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const hmacRaw = async (keyBytes, msg) => crypto.subtle.sign("HMAC", await keyOf(keyBytes), enc.encode(msg));

async function hmac(secret, msg) {
  return b64url(await hmacRaw(enc.encode(secret), msg));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ===== Telegram orqali kirish =====
// Adminlar: ADMIN_TG_IDS = "123456789,987654321" (Telegram foydalanuvchi ID lari)
const adminIds = (env) => String(env.ADMIN_TG_IDS || "").split(/[\s,]+/).filter(Boolean);

// Telegram Login tugmasidan kelgan ma’lumot: https://core.telegram.org/widgets/login#checking-authorization
async function checkLoginWidget(env, u) {
  const { hash, ...fields } = u;
  if (!hash) return null;
  const check = Object.keys(fields).filter((k) => fields[k] != null).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = await crypto.subtle.digest("SHA-256", enc.encode(env.TELEGRAM_BOT_TOKEN));
  if (!safeEqual(hex(await hmacRaw(secret, check)), String(hash))) return null;
  if (Date.now() / 1000 - Number(fields.auth_date) > 86400) return null;
  return { id: String(fields.id), name: [fields.first_name, fields.last_name].filter(Boolean).join(" "), username: fields.username || "" };
}

// Bot ichidagi mini ilovadan (Telegram.WebApp.initData): https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function checkMiniApp(env, initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmacRaw(enc.encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  if (!safeEqual(hex(await hmacRaw(secret, check)), hash)) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  const user = JSON.parse(p.get("user") || "{}");
  return { id: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(" "), username: user.username || "" };
}

// Sessiya tokeni: "<muddat>.<telegram id>.<imzo>", 30 kun amal qiladi.
// ID ro‘yxatdan olib tashlansa, token ham darhol ishlamay qoladi.
const TOKEN_DAYS = 30;
const sessionKey = (env) => "session:" + env.TELEGRAM_BOT_TOKEN;
async function makeToken(env, uid) {
  const exp = Date.now() + TOKEN_DAYS * 864e5;
  return `${exp}.${uid}.` + (await hmac(sessionKey(env), `admin:${exp}:${uid}`));
}
async function isAdmin(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const tok = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  const [exp, uid, sig] = tok.split(".");
  if (!exp || !uid || !sig || Number(exp) < Date.now() || !adminIds(env).includes(uid)) return false;
  return safeEqual(sig, await hmac(sessionKey(env), `admin:${exp}:${uid}`));
}

// Mijoz tokeni: "<muddat>.<telegram id>.<username base64>.<imzo>", 30 kun.
// Buyurtma faqat shu token bilan qabul qilinadi — har bir buyurtma haqiqiy Telegram akkauntga bog‘lanadi.
const u64 = (s) => b64url(enc.encode(s));
const d64 = (s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); } catch { return ""; } };
async function makeCustomerToken(env, who) {
  const exp = Date.now() + TOKEN_DAYS * 864e5, un = u64(who.username || "");
  return `${exp}.${who.id}.${un}.` + (await hmac(sessionKey(env), `cust:${exp}:${who.id}:${un}`));
}
async function customerOf(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const tok = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  const [exp, uid, un, sig] = tok.split(".");
  if (!exp || !uid || un === undefined || !sig || Number(exp) < Date.now()) return null;
  if (!safeEqual(sig, await hmac(sessionKey(env), `cust:${exp}:${uid}:${un}`))) return null;
  return { id: uid, username: d64(un) };
}

const tgSend = (env, chat_id, text) =>
  fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(() => {});

// Yangi buyurtma haqida adminlarga, mijozga esa tasdiq xabari
async function notifyOrder(env, o) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const e = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const items = o.items.map((i) => `• ${e(i.title)} — ${e(i.date)}${i.adults ? `, ${i.adults} katta` : ""}${i.kids ? `, ${i.kids} bola` : ""} · $${Math.round(i.sum)}`);
  const admin = [
    `🆕 <b>Yangi buyurtma ${e(o.no)}</b>`,
    `👤 ${e(o.name)}`,
    `📞 ${o.phone ? e(o.phone) : "telefon ko‘rsatilmagan — Telegram orqali bog‘laning"}`,
    `✈️ ${o.tg ? e(o.tg) + "  ·  " : ""}<a href="tg://user?id=${e(o.tgId)}">Telegramda yozish</a>`,
    "", ...items, "",
    `💰 Jami: <b>$${Math.round(o.totalUsd)}</b>`,
  ];
  await Promise.all(adminIds(env).map((chat_id) => tgSend(env, chat_id, admin.join("\n"))));
  // Mijoz kirishda bot xabar yuborishiga ruxsat bergan
  await tgSend(env, o.tgId, [
    `✅ <b>Buyurtmangiz qabul qilindi</b> (${e(o.no)})`, "", ...items, "",
    `Jami: <b>$${Math.round(o.totalUsd)}</b>`,
    "Tez orada siz bilan bog‘lanib, buyurtmani tasdiqlaymiz.",
  ].join("\n"));
}

async function getData(env) {
  return (await env.DB.get("data", "json")) || SEED;
}

const str = (v, max = 2000) => String(v ?? "").trim().slice(0, max);
const num = (v, min = 0, max = 1e7) => Math.min(max, Math.max(min, Number(v) || 0));

// Admin yuborgan ma’lumotni tekshirib, keraksiz maydonlarni olib tashlaymiz
function cleanData(d) {
  const s = d.settings || {};
  const settings = {
    phone: str(s.phone, 40), telegram: str(s.telegram, 200), channel: str(s.channel, 200), instagram: str(s.instagram, 200),
    email: str(s.email, 120), aed: num(s.aed, 0.1, 100) || 3.6725,
  };
  const ids = new Set();
  const tours = (Array.isArray(d.tours) ? d.tours : []).slice(0, 500).map((t) => {
    let id = Math.floor(num(t.id, 1, 1e9)) || 1;
    while (ids.has(id)) id++;
    ids.add(id);
    return {
      id, cat: str(t.cat, 20), city: str(t.city, 40), t: str(t.t, 160),
      p: num(t.p), old: num(t.old), r: num(t.r, 0, 5), n: Math.floor(num(t.n)), pop: Math.floor(num(t.pop, 0, 1000)),
      dur: str(t.dur, 60), d: str(t.d, 3000),
      inc: (Array.isArray(t.inc) ? t.inc : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 30),
      img: str(t.img, 300), group: !!t.group, nokids: !!t.nokids, active: t.active !== false,
    };
  });
  return { settings, tours };
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });

  // Sayt uchun: faqat faol turlar
  if (path === "/api/data" && method === "GET") {
    const d = await getData(env);
    return json({ settings: { ...d.settings, bot: env.BOT_USERNAME || "" }, tours: d.tours.filter((t) => t.active !== false) }, 200, { "cache-control": "public, max-age=30" });
  }

  // Rasm berish
  const img = path.match(/^\/api\/img\/([a-z0-9-]{8,64})$/);
  if (img && method === "GET") {
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;
    const { value, metadata } = await env.DB.getWithMetadata("img:" + img[1], "arrayBuffer");
    if (!value) return json({ error: "Rasm topilmadi" }, 404);
    const res = new Response(value, {
      headers: { "content-type": metadata?.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" },
    });
    await cache.put(request, res.clone());
    return res;
  }

  // Mijoz Telegram orqali kiradi (sayt yoki bot ichidagi mini ilova)
  if (path === "/api/auth/telegram" && method === "POST") {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram sozlanmagan" }, 500);
    let body = {};
    try { body = await request.json(); } catch {}
    const who = body.initData ? await checkMiniApp(env, str(body.initData, 4096)) : await checkLoginWidget(env, body.user || {});
    if (!who) return json({ error: "Telegram ma’lumoti tasdiqlanmadi. Qayta urinib ko‘ring." }, 401);
    return json({ token: await makeCustomerToken(env, who), user: who });
  }

  // Mijoz buyurtmasi — faqat Telegram orqali kirganlardan
  if (path === "/api/orders" && method === "POST") {
    const cust = await customerOf(request, env);
    if (!cust) return json({ error: "Buyurtma berish uchun Telegram orqali kiring", login: true }, 401);
    // bitta akkauntdan soatiga ko‘pi bilan 5 ta buyurtma
    const rlKey = "rl:" + cust.id;
    const used = Number(await env.DB.get(rlKey)) || 0;
    if (used >= 5) return json({ error: "Juda ko‘p buyurtma. Birozdan keyin urinib ko‘ring yoki bizga Telegramda yozing." }, 429);
    let o;
    try { o = await request.json(); } catch { return json({ error: "Noto‘g‘ri so‘rov" }, 400); }
    if (!str(o.name)) return json({ error: "Ismingizni kiriting" }, 400);
    const at = new Date().toISOString();
    const order = {
      no: str(o.no, 20) || "DV-" + Date.now().toString().slice(-6), at, status: "new",
      tgId: cust.id, tg: cust.username ? "@" + cust.username : "",
      name: str(o.name, 100), phone: str(o.phone, 40), cur: str(o.cur, 5),
      totalUsd: num(o.totalUsd),
      items: (Array.isArray(o.items) ? o.items : []).slice(0, 30).map((i) => ({
        id: num(i.id), title: str(i.title, 160), date: str(i.date, 10), adults: num(i.adults, 0, 50), kids: num(i.kids, 0, 50), sum: num(i.sum),
      })),
    };
    const key = "order:" + (9e15 - Date.now()).toString().padStart(16, "0") + ":" + order.no; // yangilari birinchi
    await env.DB.put(key, JSON.stringify(order));
    await env.DB.put(rlKey, String(used + 1), { expirationTtl: 3600 });
    ctx.waitUntil(notifyOrder(env, order));
    return json({ ok: true, no: order.no });
  }

  // ===== Admin =====
  if ((path === "/api/admin/config" || path === "/api/config") && method === "GET") {
    return json({ bot: env.BOT_USERNAME || "" });
  }
  if (path === "/api/admin/login" && method === "POST") {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN sozlanmagan" }, 500);
    let body = {};
    try { body = await request.json(); } catch {}
    const who = body.initData ? await checkMiniApp(env, str(body.initData, 4096)) : await checkLoginWidget(env, body.user || {});
    if (!who) return json({ error: "Telegram ma’lumoti tasdiqlanmadi. Qayta urinib ko‘ring." }, 401);
    if (!adminIds(env).includes(who.id)) {
      return json({ error: `Bu Telegram akkauntga admin panel ochilmagan (ID: ${who.id}).`, id: who.id }, 403);
    }
    return json({ token: await makeToken(env, who.id), name: who.name });
  }

  if (path.startsWith("/api/admin/")) {
    if (!(await isAdmin(request, env))) return json({ error: "Qayta kiring" }, 401);

    if (path === "/api/admin/data" && method === "GET") return json(await getData(env));
    if (path === "/api/admin/data" && method === "PUT") {
      const d = cleanData(await request.json());
      await env.DB.put("data", JSON.stringify(d));
      return json(d);
    }

    if (path === "/api/admin/upload" && method === "POST") {
      const type = request.headers.get("content-type") || "";
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "Faqat JPG, PNG yoki WEBP" }, 400);
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 5 * 1024 * 1024) return json({ error: "Rasm 5 MB dan katta" }, 400);
      const id = crypto.randomUUID();
      await env.DB.put("img:" + id, buf, { metadata: { type } });
      return json({ url: "/api/img/" + id });
    }

    if (path === "/api/admin/orders" && method === "GET") {
      const list = await env.DB.list({ prefix: "order:", limit: 200 });
      const orders = await Promise.all(list.keys.map(async (k) => ({ key: k.name, ...(await env.DB.get(k.name, "json")) })));
      return json(orders);
    }
    const om = decodeURIComponent(path).match(/^\/api\/admin\/orders\/(order:[^/]+)$/);
    if (om) {
      const key = om[1];
      if (method === "DELETE") { await env.DB.delete(key); return json({ ok: true }); }
      if (method === "PATCH") {
        const o = await env.DB.get(key, "json");
        if (!o) return json({ error: "Buyurtma topilmadi" }, 404);
        const { status, note } = await request.json();
        if (["new", "confirmed", "done", "cancelled"].includes(status)) o.status = status;
        if (note !== undefined) o.note = str(note, 1000);
        await env.DB.put(key, JSON.stringify(o));
        return json(o);
      }
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      return json({ error: "Server xatosi" }, 500);
    }
  },
};
