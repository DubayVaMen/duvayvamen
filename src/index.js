// duvayvamen — sayt public/ dan beriladi, bu Worker faqat /api/* ni boshqaradi

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    return json({ error: "Not found" }, 404);
  },
};
