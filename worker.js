/* Cloudflare Worker: đọc chữ trong ảnh bằng Claude (cho app NoteEverything)

   Biến cần đặt (Worker > Settings > Variables and Secrets):
     ANTHROPIC_API_KEY  (Secret)  key lấy ở console.anthropic.com
     ALLOWED_CODES      mã đồng bộ được phép dùng, nhiều mã thì cách nhau bằng dấu phẩy

   Tuỳ chọn:
     MODEL           mặc định claude-haiku-5-5
     ALLOWED_ORIGIN  địa chỉ web của app, ví dụ https://tenban.github.io (mặc định cho mọi nơi)
     DAILY_LIMIT     số lần quét tối đa mỗi mã mỗi ngày (mặc định 60).
                     Chỉ có tác dụng khi gắn KV namespace với tên binding là RATE.
*/

const PROMPT =
  "Chép lại toàn bộ chữ nhìn thấy trong ảnh. Giữ nguyên tiếng Việt có dấu, giữ nguyên xuống dòng và thứ tự đọc. " +
  "Với hóa đơn thì giữ nguyên từng dòng và các con số như trên giấy. " +
  "Chỉ trả về phần chữ chép lại, không giải thích, không thêm lời dẫn, không dùng markdown. " +
  "Nếu trong ảnh không có chữ thì trả về rỗng.";

const MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_B64 = 6_000_000; // khoảng 4,5 MB ảnh, dưới giới hạn 5 MB của Claude

async function sha8(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const out = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return out({ error: "Chỉ nhận yêu cầu POST" }, 405);
    if (!env.ANTHROPIC_API_KEY || !env.ALLOWED_CODES)
      return out({ error: "Worker chưa cài đủ biến ANTHROPIC_API_KEY và ALLOWED_CODES" }, 500);

    let body;
    try {
      body = await req.json();
    } catch {
      return out({ error: "Dữ liệu gửi lên không đọc được" }, 400);
    }

    const code = String(body.code || "");
    const image = String(body.image || "");
    const mime = String(body.mime || "image/jpeg");

    const allowed = String(env.ALLOWED_CODES).split(",").map((s) => s.trim()).filter(Boolean);
    if (!code || !allowed.includes(code))
      return out({ error: "Mã đồng bộ này chưa được phép dùng quét chữ" }, 403);
    if (!MIMES.includes(mime)) return out({ error: "Định dạng ảnh chưa được hỗ trợ" }, 400);
    if (!image) return out({ error: "Thiếu ảnh" }, 400);
    if (image.length > MAX_B64) return out({ error: "Ảnh quá lớn" }, 413);
    if (!/^[A-Za-z0-9+/=]+$/.test(image)) return out({ error: "Ảnh không hợp lệ" }, 400);

    // Giới hạn lượt mỗi ngày (không bắt buộc, cần KV binding tên RATE)
    if (env.RATE) {
      const limit = parseInt(env.DAILY_LIMIT || "60", 10) || 60;
      const key = "scan:" + new Date().toISOString().slice(0, 10) + ":" + (await sha8(code));
      const used = parseInt((await env.RATE.get(key)) || "0", 10) || 0;
      if (used >= limit) return out({ error: "Hôm nay đã hết lượt quét, mai quét tiếp nhé" }, 429);
      await env.RATE.put(key, String(used + 1), { expirationTtl: 172800 });
    }

    const payload = {
      model: env.MODEL || "claude-haiku-5-5",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: image } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    };

    let r;
    try {
      for (let i = 0; i < 2; i++) {
        r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (r.ok || (r.status < 500 && r.status !== 429)) break; // chỉ thử lại khi quá tải/lỗi máy chủ
        await new Promise((s) => setTimeout(s, 800));
      }
    } catch {
      return out({ error: "Không gọi được Claude, thử lại sau" }, 503);
    }

    if (!r.ok) {
      let msg = "";
      try {
        msg = String((await r.json())?.error?.message || "");
      } catch {}
      if (r.status === 401 || r.status === 403) return out({ error: "Key Claude không hợp lệ hoặc đã bị thu hồi" }, 401);
      if (r.status === 400 && /credit|balance|billing/i.test(msg))
        return out({ error: "Tài khoản Claude API hết tiền, hãy nạp thêm ở console.anthropic.com" }, 402);
      if (r.status === 404) return out({ error: "Tên model không đúng, kiểm tra biến MODEL của Worker" }, 404);
      if (r.status === 429) return out({ error: "Claude đang giới hạn lượt gọi, thử lại sau ít phút" }, 429);
      if (r.status === 413) return out({ error: "Ảnh quá lớn" }, 413);
      return out({ error: "Claude báo lỗi (" + r.status + "), thử lại sau" }, 503);
    }

    const j = await r.json();
    const text = (j.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return out({ text });
  },
};
