// dubayvamen — sayt public/ dan beriladi, bu Worker faqat /api/* ni boshqaradi.
// Cloudflare KV (env.DB):
//   "data"          — sozlamalar va turlar ro‘yxati (admin paneldan tahrirlanadi)
//   "img:<id>"      — admin yuklagan rasmlar
// Buyurtmalar — OrdersStore Durable Object (env.ORDERS): yozilgan zahoti hamma joyda ko‘rinadi.
// KV da o‘zgarish boshqa joylarga 60 soniyagacha kech yetadi, buyurtma holati uchun bu yaramaydi.

import { DurableObject } from "cloudflare:workers";
import SEED from "./seed.js";

export class OrdersStore extends DurableObject {
  // Avval KV da saqlangan buyurtmalarni bir marta ko‘chirib olamiz
  async migrate() {
    if (await this.ctx.storage.get("migrated")) return;
    const list = await this.env.DB.list({ prefix: "order:", limit: 1000 });
    for (const k of list.keys) {
      const o = await this.env.DB.get(k.name, "json");
      if (o && !(await this.ctx.storage.get(k.name))) await this.ctx.storage.put(k.name, o);
    }
    await this.ctx.storage.put("migrated", true);
  }
  async add(key, order) { await this.ctx.storage.put(key, order); }
  async get(key) { return (await this.ctx.storage.get(key)) || null; }
  async put(key, order) { await this.ctx.storage.put(key, order); }
  async remove(key) { await this.ctx.storage.delete(key); }
  async list(limit = 200) {
    await this.migrate();
    const m = await this.ctx.storage.list({ prefix: "order:", limit });
    return [...m].map(([key, o]) => ({ key, ...o }));
  }
  // Bitta akkauntdan soatiga ko‘pi bilan `max` ta buyurtma; true — ruxsat
  async hit(uid, max = 5) {
    const k = "rl:" + uid, now = Date.now();
    const r = (await this.ctx.storage.get(k)) || { n: 0, reset: now + 3600e3 };
    if (now > r.reset) { r.n = 0; r.reset = now + 3600e3; }
    if (r.n >= max) return false;
    r.n++;
    await this.ctx.storage.put(k, r);
    return true;
  }
}
const orders = (env) => env.ORDERS.get(env.ORDERS.idFromName("main"));

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

const tgApi = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch((e) => ({ ok: false, description: String(e) }));
const tgSend = (env, chat_id, text, extra = {}) =>
  tgApi(env, "sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

// ===== Bot: mini ilova =====
// Telegram webhook so‘rovlari shu maxfiy kalit bilan keladi (setWebhook da beriladi)
const webhookSecret = (env) => hmac("webhook:" + env.TELEGRAM_BOT_TOKEN, "dubayvamen");

function appButtons(origin, isAdminUser) {
  const rows = [[{ text: "🌴 Turlarni ko‘rish", web_app: { url: origin + "/" } }]];
  if (isAdminUser) rows.push([{ text: "⚙️ Admin panel", web_app: { url: origin + "/admin/" } }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function handleBotUpdate(env, origin, update) {
  if (update.callback_query) return handleOrderButton(env, update.callback_query);
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== "private") return;
  const isAdminUser = adminIds(env).includes(String(msg.from && msg.from.id));
  const name = (msg.from && msg.from.first_name) || "";
  const text = String(msg.text || "");
  if (text.startsWith("/start")) {
    await tgSend(env, msg.chat.id, [
      `Assalomu alaykum${name ? ", " + name.replace(/[<>&]/g, "") : ""}! 👋`,
      "",
      "<b>Dubayga xush kelibsiz!</b>",
      "Biz orqali 90% joylarning biletlarini kassadan arzon narxda sotib olishingiz mumkin.",
      "",
      "Ekskursiyalar, attraksion biletlari, safari va kruizlarni ko‘rish uchun quyidagi tugmani bosing 👇",
    ].join("\n"), appButtons(origin, isAdminUser));
  } else {
    await tgSend(env, msg.chat.id, "Turlarni ko‘rish va band qilish uchun tugmani bosing 👇", appButtons(origin, isAdminUser));
  }
}

// Admin buyurtma xabaridagi tugmani bosdi
async function handleOrderButton(env, cq) {
  const answer = (text) => tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  if (!adminIds(env).includes(String(cq.from && cq.from.id))) return answer("Ruxsat yo‘q");
  const [act, key] = String(cq.data || "").split("|");
  const status = { c: "confirmed", x: "cancelled", d: "done" }[act];
  if (!status || !key || !key.startsWith("order:")) return answer("Eskirgan tugma");
  const o = await setOrderStatus(env, key, status);
  if (!o) return answer("Buyurtma topilmadi (o‘chirilgan bo‘lishi mumkin)");
  // Xabar matnining boshiga holatni yozamiz va tugmalarni yangilaymiz
  const m = cq.message;
  if (m) {
    const who = [cq.from.first_name, cq.from.username && "@" + cq.from.username].filter(Boolean).join(" ");
    const text = String(m.text || "");
    const old = (text.match(/^Holat: .*\n\n/) || [""])[0];
    const head = `Holat: ${STATUS_LABEL[status]} — ${who}\n\n`;
    // qalin yozuv va havolalar saqlanib qolishi uchun formatlashni siljitamiz
    const entities = (m.entities || []).filter((x) => x.offset >= old.length).map((x) => ({ ...x, offset: x.offset - old.length + head.length }));
    entities.unshift({ type: "bold", offset: 0, length: head.length - 2 });
    await tgApi(env, "editMessageText", {
      chat_id: m.chat.id, message_id: m.message_id, text: head + text.slice(old.length), entities,
      reply_markup: orderButtons(key, status), disable_web_page_preview: true,
    });
  }
  return answer(STATUS_LABEL[status] + (status === "confirmed" || status === "cancelled" ? " — mijozga xabar yuborildi" : ""));
}

// Admin paneldagi “Botni sozlash” tugmasi: webhook, menyu tugmasi va buyruqlar
async function setupBot(env, origin) {
  const steps = {};
  steps.webhook = await tgApi(env, "setWebhook", {
    url: origin + "/api/tg/webhook", secret_token: await webhookSecret(env), allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
  });
  steps.menu = await tgApi(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Ochish", web_app: { url: origin + "/" } } });
  steps.commands = await tgApi(env, "setMyCommands", { commands: [{ command: "start", description: "Turlar va biletlarni ochish" }] });
  steps.description = await tgApi(env, "setMyShortDescription", { short_description: "Dubay turlari, ekskursiyalar va biletlar — kassadan arzon." });
  return steps;
}

// ===== Buyurtma holati: bot tugmalari va admin panel uchun umumiy =====
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const STATUS_LABEL = { new: "🆕 Yangi", confirmed: "✅ Tasdiqlandi", done: "✔️ Bajarildi", cancelled: "❌ Bekor qilindi" };

// callback_data: "<amal>|<KV kalit>" — amal: c = tasdiqlash, x = bekor qilish, d = bajarildi
function orderButtons(key, status) {
  const b = (text, act) => ({ text, callback_data: act + "|" + key });
  const rows = { new: [[b("✅ Tasdiqlash", "c"), b("❌ Bekor qilish", "x")]],
    confirmed: [[b("✔️ Bajarildi", "d"), b("❌ Bekor qilish", "x")]],
    cancelled: [[b("↩️ Qayta tasdiqlash", "c")]],
    done: [] }[status] || [];
  return { inline_keyboard: rows };
}

// Holatni o‘zgartiradi; tasdiqlansa yoki bekor qilinsa, mijozga xabar yuboradi
async function setOrderStatus(env, key, status) {
  const store = orders(env);
  const o = await store.get(key);
  if (!o) return null;
  const prev = o.status;
  o.status = status;
  await store.put(key, o);
  if (prev !== status && o.tgId && env.TELEGRAM_BOT_TOKEN) {
    const items = (o.items || []).map((i) => `• ${esc(i.title)} — ${esc(i.date)}`).join("\n");
    if (status === "confirmed") await tgSend(env, o.tgId, `✅ <b>Buyurtmangiz tasdiqlandi</b> (${esc(o.no)})\n\n${items}\n\nVaucher va tafsilotlar shu chatga yuboriladi. Savollar bo‘lsa, shu yerga yozing.`);
    if (status === "cancelled") await tgSend(env, o.tgId, `❌ <b>Buyurtmangiz bekor qilindi</b> (${esc(o.no)})\n\n${items}\n\nSavollar bo‘lsa, bizga yozing — boshqa sana yoki turni tanlashga yordam beramiz.`);
  }
  return o;
}

// Yangi buyurtma haqida adminlarga (tugmalar bilan), mijozga esa qabul xabari
async function notifyOrder(env, o, key) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const e = esc;
  const items = o.items.map((i) => `• ${e(i.title)} — ${e(i.date)}${i.adults ? `, ${i.adults} katta` : ""}${i.kids ? `, ${i.kids} bola` : ""} · $${Math.round(i.sum)}`);
  const admin = [
    `🆕 <b>Yangi buyurtma ${e(o.no)}</b>`,
    `👤 ${e(o.name)}`,
    `📞 ${o.phone ? e(o.phone) : "telefon ko‘rsatilmagan — Telegram orqali bog‘laning"}`,
    `✈️ ${o.tg ? e(o.tg) + "  ·  " : ""}<a href="tg://user?id=${e(o.tgId)}">Telegramda yozish</a>`,
    "", ...items, "",
    `💰 Jami: <b>$${Math.round(o.totalUsd)}</b>`,
  ];
  await Promise.all(adminIds(env).map((chat_id) => tgSend(env, chat_id, admin.join("\n"), { reply_markup: orderButtons(key, "new") })));
  // Mijoz kirishda bot xabar yuborishiga ruxsat bergan
  await tgSend(env, o.tgId, [
    `📝 <b>Buyurtmangiz qabul qilindi</b> (${e(o.no)})`, "", ...items, "",
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
    const store = orders(env);
    let o;
    try { o = await request.json(); } catch { return json({ error: "Noto‘g‘ri so‘rov" }, 400); }
    if (!str(o.name)) return json({ error: "Ismingizni kiriting" }, 400);
    // bitta akkauntdan soatiga ko‘pi bilan 5 ta buyurtma
    if (!(await store.hit(cust.id))) return json({ error: "Juda ko‘p buyurtma. Birozdan keyin urinib ko‘ring yoki bizga Telegramda yozing." }, 429);
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
    await store.add(key, order);
    ctx.waitUntil(notifyOrder(env, order, key));
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

  // Telegram bot webhook
  if (path === "/api/tg/webhook" && method === "POST") {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false }, 500);
    if (!safeEqual(request.headers.get("x-telegram-bot-api-secret-token") || "", await webhookSecret(env))) return json({ ok: false }, 401);
    const update = await request.json().catch(() => ({}));
    ctx.waitUntil(handleBotUpdate(env, url.origin, update));
    return json({ ok: true });
  }

  if (path.startsWith("/api/admin/")) {
    if (!(await isAdmin(request, env))) return json({ error: "Qayta kiring" }, 401);

    if (path === "/api/admin/bot-setup" && method === "POST") {
      const steps = await setupBot(env, url.origin);
      const failed = Object.entries(steps).filter(([, r]) => !r.ok).map(([k, r]) => `${k}: ${r.description || "xato"}`);
      return json({ ok: !failed.length, error: failed.join("; ") || undefined, steps }, failed.length ? 502 : 200);
    }

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
      return json(await orders(env).list(200), 200, { "cache-control": "no-store" });
    }
    const om = decodeURIComponent(path).match(/^\/api\/admin\/orders\/(order:[^/]+)$/);
    if (om) {
      const key = om[1], store = orders(env);
      if (method === "DELETE") {
        await store.remove(key);
        await env.DB.delete(key); // eski KV nusxasi bo‘lsa, u ham o‘chsin
        return json({ ok: true });
      }
      if (method === "PATCH") {
        const { status, note } = await request.json();
        let o = await store.get(key);
        if (!o) return json({ error: "Buyurtma topilmadi" }, 404);
        if (note !== undefined) { o.note = str(note, 1000); await store.put(key, o); }
        // holat o‘zgarsa, mijozga ham xabar boradi (bot tugmalari bilan bir xil)
        if (["new", "confirmed", "done", "cancelled"].includes(status)) o = await setOrderStatus(env, key, status);
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
