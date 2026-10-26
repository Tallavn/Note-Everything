/* Cloudflare Worker cho app NoteEverything, gồm 2 chức năng trong cùng một địa chỉ:
     1) GET  ?u=<link Google Maps rút gọn>  -> đổi thành link đầy đủ (chức năng cũ, không cần biến nào)
     2) POST {code,image,mime}              -> đọc chữ trong ảnh bằng Gemini (cần 2 biến bên dưới)

   Biến cần đặt (Worker > Settings > Variables and Secrets):
     GEMINI_API_KEY  (Secret)  key lấy ở aistudio.google.com
     ALLOWED_CODES   mã đồng bộ được phép dùng, nhiều mã thì cách nhau bằng dấu phẩy

   Tuỳ chọn:
     MODEL           mặc định gemini-3.5-flash-lite (nếu model này báo không tồn tại,
                     Worker tự thử gemini-3.1-flash-lite)
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
const MAX_B64 = 6_000_000; // khoảng 4,5 MB ảnh
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_MODEL = "gemini-3.1-flash-lite";
const API = "https://generativelanguage.googleapis.com/v1beta/models/";

async function sha8(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Gọi một model, thử lại 1 lần khi quá tải (429/5xx)
async function callModel(model, key, payload) {
  let r;
  for (let i = 0; i < 2; i++) {
    r = await fetch(API + encodeURIComponent(model) + ":generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.ok || (r.status < 500 && r.status !== 429)) break;
    await new Promise((s) => setTimeout(s, 800));
  }
  return r;
}

// CHỨC NĂNG CŨ (giữ nguyên): GET ?u=<link Google Maps rút gọn> -> trả {url} là link đầy đủ sau khi chuyển hướng
async function resolveLink(req, out) {
  const u = new URL(req.url).searchParams.get("u") || "";
  if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\/[\w\-\/?=&.%]+$/.test(u)) {
    return out({ error: "bad link" }, 400);
  }
  try {
    const r = await fetch(u, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    return out({ url: r.url });
  } catch (e) {
    return out({ error: "fetch failed" }, 502);
  }
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
    // Mọi yêu cầu không phải POST (GET ?u=...) đi vào chức năng đổi link địa chỉ như cũ; POST là quét chữ
    if (req.method !== "POST") return resolveLink(req, out);
    if (!env.GEMINI_API_KEY || !env.ALLOWED_CODES)
      return out({ error: "Worker chưa cài đủ biến GEMINI_API_KEY và ALLOWED_CODES" }, 500);

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
      contents: [
        {
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mime, data: image } },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 8192 },
    };

    let r;
    try {
      r = await callModel(env.MODEL || DEFAULT_MODEL, env.GEMINI_API_KEY, payload);
      if (r.status === 404 && !env.MODEL) r = await callModel(FALLBACK_MODEL, env.GEMINI_API_KEY, payload);
    } catch {
      return out({ error: "Không gọi được Gemini, thử lại sau" }, 503);
    }

    if (!r.ok) {
      let msg = "";
      try {
        msg = String((await r.json())?.error?.message || "");
      } catch {}
      console.log("Gemini error", r.status, msg);
      if (r.status === 401 || r.status === 403 || (r.status === 400 && /api key|api_key/i.test(msg)))
        return out({ error: "Key Gemini không hợp lệ hoặc chưa được phép dùng" }, 401);
      if (r.status === 404) return out({ error: "Tên model không đúng, kiểm tra biến MODEL của Worker" }, 404);
      if (r.status === 429) return out({ error: "Đã hết hạn mức miễn phí của Gemini (theo phút hoặc theo ngày), thử lại sau" }, 429);
      if (r.status === 413) return out({ error: "Ảnh quá lớn" }, 413);
      if (r.status === 400) {
        if (/location is not supported/i.test(msg))
          return out({ error: "Gemini không hỗ trợ vùng chạy của Worker này: " + msg.slice(0, 150) }, 400);
        return out({ error: "Gemini không nhận ảnh này: " + msg.slice(0, 200) }, 400);
      }
      return out({ error: "Gemini báo lỗi (" + r.status + "), thử lại sau" }, 503);
    }

    const j = await r.json();
    if (j.promptFeedback?.blockReason) return out({ error: "Gemini từ chối đọc ảnh này" }, 422);
    const parts = j.candidates?.[0]?.content?.parts || [];
    const text = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim();
    return out({ text });
  },
};
