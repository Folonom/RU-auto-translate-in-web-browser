/* RU Auto Translate — service worker (background)
 * Хранит настройки, кэш переводов и обращается к бесплатным эндпоинтам
 * Google Translate. Обрабатывает сообщения от content-скриптов и popup,
 * а также горячие клавиши и бейдж на иконке расширения.
 */

const DEFAULTS = {
  enabled: true,
  selectionEnabled: true,
  pageEnabled: true,
  showBubble: true
};

const MAX_CACHE = 5000;
const cache = new Map();
const inflight = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/* ---------- Перевод: эндпоинты ---------- */

// Основной (батч-дружелюбный). Возвращает [["перевод","src"], ...].
async function fetchDictChromeEx(texts) {
  const params = new URLSearchParams();
  params.set("client", "dict-chrome-ex");
  params.set("sl", "auto");
  params.set("tl", "ru");
  const body = new URLSearchParams();
  for (const t of texts) body.append("q", t);

  const res = await fetch(
    "https://clients5.google.com/translate_a/t?" + params.toString(),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString()
    }
  );
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("bad response shape");

  if (texts.length === 1) {
    const item = data[0];
    if (Array.isArray(item)) return [item[0] ?? ""];
    return [item ?? ""];
  }
  return data.map((item) => (Array.isArray(item) ? item[0] ?? "" : item ?? ""));
}

// Резервный (по одному), классический веб-эндпоинт. Переводит длинные тексты.
async function fetchGtxSingle(text, host) {
  const base = host === "google" ? "https://translate.google.com/translate_a/single" : "https://translate.googleapis.com/translate_a/single";
  const params = new URLSearchParams();
  params.set("client", "gtx");
  params.set("sl", "auto");
  params.set("tl", "ru");
  params.set("dt", "t");
  params.set("q", text);
  const res = await fetch(base + "?" + params.toString());
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const segs = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  return segs.map((seg) => (Array.isArray(seg) ? seg[0] || "" : "")).join("");
}

/* ---------- Чанкование ---------- */

function chunkTexts(items, maxChars = 2000, maxItems = 25) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const len = item.text.length + 20;
    if (current.length && (size + len > maxChars || current.length >= maxItems)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function translateChunk(chunk) {
  // Одиночный длинный текст удобнее перевести через gtx.
  if (chunk.length === 1 && chunk[0].text.length > 1800) {
    try {
      return [await fetchGtxSingle(chunk[0].text, "googleapis")];
    } catch (err) {
      try {
        return [await fetchGtxSingle(chunk[0].text, "google")];
      } catch (err2) {
        return [chunk[0].text];
      }
    }
  }
  try {
    return await fetchDictChromeEx(chunk.map((c) => c.text));
  } catch (err) {
    // Падаем на поэлементный gtx.
    const out = [];
    for (const c of chunk) {
      try {
        out.push(await fetchGtxSingle(c.text, "googleapis"));
      } catch (err2) {
        try {
          out.push(await fetchGtxSingle(c.text, "google"));
        } catch (err3) {
          out.push(c.text);
        }
      }
    }
    return out;
  }
}

async function translateMany(texts) {
  const results = new Array(texts.length).fill("");
  const need = [];

  texts.forEach((text, i) => {
    const hit = cacheGet(text);
    if (hit !== undefined) results[i] = hit;
    else need.push({ text, i });
  });

  if (!need.length) return results;

  // Дедупликация одинаковых текстов.
  const uniq = new Map();
  for (const item of need) {
    if (!uniq.has(item.text)) uniq.set(item.text, []);
    uniq.get(item.text).push(item.i);
  }

  const uniqueItems = [...uniq.keys()].map((text) => ({ text }));

  for (const chunk of chunkTexts(uniqueItems)) {
    const translated = await translateChunk(chunk);
    chunk.forEach((c, idx) => {
      const value = translated[idx] ?? c.text;
      cacheSet(c.text, value);
      for (const originalIndex of uniq.get(c.text)) results[originalIndex] = value;
    });
  }

  return results;
}

function translateManyDeduped(texts) {
  const key = texts.join("\u0001");
  if (inflight.has(key)) return inflight.get(key);
  const promise = translateMany(texts).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/* ---------- Бейдж ---------- */

function setBadge(tabId, translated) {
  if (tabId == null) return;
  try {
    if (translated) {
      chrome.action.setBadgeText({ tabId, text: "RU" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#7a5cff" });
    } else {
      chrome.action.setBadgeText({ tabId, text: "" });
    }
  } catch (_) {}
}

async function refreshActiveBadge() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: "get-page-state" }).catch(() => null);
      setBadge(tab.id, !!(resp && resp.ok && resp.pageTranslated));
    }
  } catch (_) {}
}

/* ---------- Сообщения ---------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "translate") {
    translateManyDeduped(message.texts || [])
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "get-settings") {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (message?.type === "save-settings") {
    (async () => {
      const next = { ...message.settings };
      await chrome.storage.local.set(next);
      const settings = await getSettings();
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: "settings-updated", settings }).catch(() => {});
      }
      sendResponse({ ok: true, settings });
    })();
    return true;
  }

  if (message?.type === "page-state") {
    setBadge(sender.tab?.id, !!message.translated);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "broadcast-page-action") {
    // Запрос от popup/hotkey к активной вкладке.
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return sendResponse({ ok: false, error: "Нет активной вкладки" });
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: message.action });
        sendResponse(resp || { ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: "Обновите страницу (Ctrl+R) и попробуйте ещё раз" });
      }
    })();
    return true;
  }
});

/* ---------- Горячие клавиши ---------- */

chrome.commands?.onCommand?.addListener((command) => {
  (async () => {
    if (command === "translate-page") {
      const settings = await getSettings();
      await chrome.storage.local.set({ enabled: true, pageEnabled: true });
      const tabs = await chrome.tabs.query({});
      const next = { ...settings, enabled: true, pageEnabled: true };
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: "settings-updated", settings: next }).catch(() => {});
      }
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id) {
        chrome.tabs.sendMessage(active.id, { type: "translate-page-now" }).catch(() => {});
      }
    } else if (command === "toggle-extension") {
      const settings = await getSettings();
      const next = { ...settings, enabled: !settings.enabled };
      await chrome.storage.local.set({ enabled: next.enabled });
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: "settings-updated", settings: next }).catch(() => {});
      }
    }
  })();
});

// Обновляем бейдж при переключении вкладок и при установке.
chrome.tabs.onActivated?.addListener?.(() => refreshActiveBadge());
chrome.runtime.onInstalled?.addListener?.(() => {});
