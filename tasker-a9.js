(() => {
  const panel = document.getElementById("tasker-panel");
  const form = document.getElementById("tasker-pair");
  const status = document.getElementById("tasker-status");
  const buttons = [...panel.querySelectorAll("[data-tasker-slot]")];
  const storageKey = "noteeverything_tasker_pair";
  const ttl = 5 * 60 * 1000;
  const firebase = "https://note-everything-65971-default-rtdb.asia-southeast1.firebasedatabase.app";
  const encode = new TextEncoder();
  const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  let pair = localStorage.getItem(storageKey);

  function updateButtons(sending = false) {
    for (const button of buttons) button.disabled = sending || !pair || !globalThis.crypto?.subtle;
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    pair = document.getElementById("tasker-key").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pair)) return;
    localStorage.setItem(storageKey, pair);
    form.reset();
    status.textContent = "Đã lưu mã ghép trên trình duyệt này.";
    updateButtons();
  });

  panel.addEventListener("click", async event => {
    const button = event.target.closest("button[data-tasker-slot]");
    if (!button || button.disabled) return;
    const slot = button.dataset.taskerSlot;
    const secret = encode.encode(pair);
    updateButtons(true);
    status.textContent = "Đang gửi lệnh " + slot + "…";
    try {
      const channel = hex(await crypto.subtle.digest("SHA-256", secret));
      const key = await crypto.subtle.importKey("raw", secret, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
      const url = firebase + "/ghichu/tasker-" + channel + ".json";
      const previous = await fetch(url, {headers: {"X-Firebase-ETag": "true"}, cache: "no-store"});
      if (!previous.ok) throw new Error("Không đọc được kênh Tasker.");
      const etag = previous.headers.get("ETag");
      const pending = await previous.json();
      const sentAt = Date.now();
      if (pending && pending.sentAt > sentAt - ttl && pending.sentAt <= sentAt + 10000) {
        throw new Error("Điện thoại đang có một lệnh chờ.");
      }
      if (!etag) throw new Error("Không xác nhận được trạng thái hàng chờ.");
      const id = crypto.randomUUID();
      const message = [id, slot, sentAt].join("\n");
      const signature = hex(await crypto.subtle.sign("HMAC", key, encode.encode(message)));
      const response = await fetch(url, {
        method: "PUT",
        headers: {"Content-Type": "application/json", "If-Match": etag},
        body: JSON.stringify({id, slot, sentAt, signature})
      });
      if (response.status === 412) throw new Error("Kênh vừa thay đổi. Bấm lại để gửi.");
      if (!response.ok) throw new Error("Không ghi được lệnh Tasker.");
      status.textContent = "Đã gửi lệnh " + slot + ". Đang chờ điện thoại nhận.";
    } catch (error) {
      status.textContent = error.message || "Gửi lệnh thất bại.";
    } finally {
      updateButtons();
    }
  });

  updateButtons();
})();
