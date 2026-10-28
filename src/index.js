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

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Token: "<amal qilish muddati>.<imzo>", 30 kun amal qiladi
const TOKEN_DAYS = 30;
async function makeToken(env) {
  const exp = Date.now() + TOKEN_DAYS * 864e5;
  return exp + "." + (await hmac(env.ADMIN_PASSWORD, "admin:" + exp));
}
async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const tok = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  const [exp, sig] = tok.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, "admin:" + exp));
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
    phone: str(s.phone, 40), telegram: str(s.telegram, 200), instagram: str(s.instagram, 200),
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

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });

  // Sayt uchun: faqat faol turlar
  if (path === "/api/data" && method === "GET") {
    const d = await getData(env);
    return json({ settings: d.settings, tours: d.tours.filter((t) => t.active !== false) }, 200, { "cache-control": "public, max-age=30" });
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

  // Mijoz buyurtmasi
  if (path === "/api/orders" && method === "POST") {
    let o;
    try { o = await request.json(); } catch { return json({ error: "Noto‘g‘ri so‘rov" }, 400); }
    if (!str(o.name) || !str(o.phone)) return json({ error: "Ism va telefon kerak" }, 400);
    const at = new Date().toISOString();
    const order = {
      no: str(o.no, 20) || "DV-" + Date.now().toString().slice(-6), at, status: "new",
      name: str(o.name, 100), phone: str(o.phone, 40), tg: str(o.tg, 60), cur: str(o.cur, 5),
      totalUsd: num(o.totalUsd),
      items: (Array.isArray(o.items) ? o.items : []).slice(0, 30).map((i) => ({
        id: num(i.id), title: str(i.title, 160), date: str(i.date, 10), adults: num(i.adults, 0, 50), kids: num(i.kids, 0, 50), sum: num(i.sum),
      })),
    };
    const key = "order:" + (9e15 - Date.now()).toString().padStart(16, "0") + ":" + order.no; // yangilari birinchi
    await env.DB.put(key, JSON.stringify(order));
    return json({ ok: true, no: order.no });
  }

  // ===== Admin =====
  if (path === "/api/admin/login" && method === "POST") {
    if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD sozlanmagan" }, 500);
    let body = {};
    try { body = await request.json(); } catch {}
    const ok = safeEqual(await hmac("cmp", str(body.password, 200)), await hmac("cmp", env.ADMIN_PASSWORD));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 800));
      return json({ error: "Parol noto‘g‘ri" }, 401);
    }
    return json({ token: await makeToken(env) });
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
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return json({ error: "Server xatosi" }, 500);
    }
  },
};
