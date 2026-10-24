// Cloudflare Worker: mở link rút gọn Google Maps ra link đầy đủ (có toạ độ)
// Gọi: https://<ten>.workers.dev/?u=<link rút gọn đã encode>
export default {
  async fetch(req) {
    const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    if (req.method === "OPTIONS") return new Response(null, { headers: H });
    const u = new URL(req.url).searchParams.get("u") || "";
    // chỉ nhận link rút gọn của Google Maps, không mở địa chỉ bất kỳ
    if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\/[\w\-\/?=&.%]+$/.test(u)) {
      return new Response(JSON.stringify({ error: "bad link" }), { status: 400, headers: H });
    }
    try {
      const r = await fetch(u, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
      return new Response(JSON.stringify({ url: r.url }), { headers: H });
    } catch (e) {
      return new Response(JSON.stringify({ error: "fetch failed" }), { status: 502, headers: H });
    }
  }
};
