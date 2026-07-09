/* RU Auto Translate — content script
 * Переводит текстовые узлы на странице на русский прямо в DOM, включая
 * посты и комментарии внутри открытых Shadow DOM (Reddit shreddit-*, и т.д.),
 * следит за появлением нового контента (лента X, Reddit, бесконечный скролл)
 * и показывает всплывающий перевод для выделенного текста.
 */
(() => {
  if (window.__ruAutoTranslateLoaded) return;
  window.__ruAutoTranslateLoaded = true;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT",
    "OPTION", "CODE", "PRE", "KBD", "SAMP", "VAR", "SVG", "CANVAS",
    "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED", "MATH", "TIME",
    "TITLE", "BUTTON"
  ]);

  const state = {
    settings: { enabled: true, selectionEnabled: true, pageEnabled: true, showBubble: true },
    queue: new Set(),
    flushTimer: null,
    rescanTimer: null,
    purgeTimer: null,
    originals: new Map(),
    selfWrites: new WeakSet(),
    paused: false,
    hidden: document.hidden,
    observer: null,
    bubble: null,
    bubbleHideTimer: null,
    selectionTimer: null,
    lastSelectionText: "",
    pageTranslated: false,
    notifiedTranslated: false,
    stats: { translated: 0 }
  };

  // Открытые Shadow DOM, за которыми следим.
  const shadowObservers = new WeakMap();
  const trackedShadowRoots = new Set();

  const CYRILLIC_RE = /[\u0400-\u04FF]/g;
  const LETTER_RE = /\p{L}/gu;

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  // true, если доля кириллицы выше порога (текст уже преимущественно русский).
  function looksRussian(text, threshold = 0.6) {
    const letters = text.match(LETTER_RE);
    if (!letters || !letters.length) return true;
    const cyr = text.match(CYRILLIC_RE);
    return (cyr ? cyr.length : 0) / letters.length > threshold;
  }

  function isTranslatableText(text) {
    if (!text || text.length < 2) return false;
    if (!/\p{L}/u.test(text)) return false;
    if (/^[\d\s.,:;!?%$€₽#@()[\]{}<>+\-*/=_'"«»`~^|\\]+$/u.test(text)) return false;
    if (looksRussian(text, 0.6)) return false;
    if (/^https?:\/\//i.test(text)) return false;
    if (/^[@#][\w.]+$/.test(text)) return false;
    return true;
  }

  function isInsideSkipped(el) {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return true;
      if (node.id === "ru-tr-bubble") return true;
      if (node.isContentEditable) return true;
      if (node.getAttribute && node.getAttribute("translate") === "no") return true;
      if (node.classList && node.classList.contains("notranslate")) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isVisibleEnough(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (rect && rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  /* ---------- Сбор текстовых узлов (включая Shadow DOM) ---------- */

  function textNodeAccept(node) {
    if (state.originals.has(node)) return NodeFilter.FILTER_REJECT;
    const parent = node.parentElement;
    if (!parent) return NodeFilter.FILTER_REJECT;
    if (isInsideSkipped(parent)) return NodeFilter.FILTER_REJECT;
    const text = cleanText(node.nodeValue);
    if (!isTranslatableText(text)) return NodeFilter.FILTER_REJECT;
    if (!isVisibleEnough(parent)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }

  // Рекурсивно собирает текстовые узлы из root и всех открытых shadow-корней внутри.
  function collectTextNodesDeep(root, out) {
    if (!root) return;
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: textNodeAccept
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);

    // Ищем хосты открытых shadow-корней и спускаемся в них.
    const elWalker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        return el.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let el;
    while ((el = elWalker.nextNode())) {
      if (isInsideSkipped(el)) continue;
      collectTextNodesDeep(el.shadowRoot, out);
    }
  }

  // Находит и подключает наблюдателей к новым открытым shadow-корням внутри root.
  function discoverShadowRoots(root) {
    if (!root) return;
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        return el.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let el;
    while ((el = walker.nextNode())) {
      if (isInsideSkipped(el)) continue;
      const sr = el.shadowRoot;
      if (!sr) continue;
      if (!shadowObservers.has(sr)) {
        attachObserver(sr);
        // Переводим уже существующее содержимое нового shadow-корня.
        const nodes = [];
        collectTextNodesDeep(sr, nodes);
        enqueue(nodes);
      }
      // Рекурсивно проверяем вложенные shadow-корни.
      discoverShadowRoots(sr);
    }
  }

  /* ---------- Связь с фоном ---------- */

  function sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: "no response" });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  function notifyPageState(translated) {
    try {
      chrome.runtime.sendMessage({ type: "page-state", translated, count: state.stats.translated }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  /* ---------- Очередь перевода ---------- */

  function enqueue(nodes) {
    let added = false;
    for (const node of nodes) {
      if (!node) continue;
      if (!state.queue.has(node)) {
        state.queue.add(node);
        added = true;
      }
    }
    if (added) scheduleFlush();
  }

  function scheduleFlush() {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(flushQueue, 220);
  }

  async function flushQueue() {
    state.flushTimer = null;
    if (!state.settings.enabled || !state.settings.pageEnabled || state.paused) {
      state.queue.clear();
      return;
    }
    if (state.hidden) {
      // Во вкладке в фоне не переводим — догоним при возврате фокуса.
      if (state.queue.size) scheduleFlush();
      return;
    }

    const nodes = [...state.queue].filter((node) => node.isConnected).slice(0, 250);
    for (const node of nodes) state.queue.delete(node);
    if (!nodes.length) {
      if (state.queue.size) scheduleFlush();
      return;
    }

    const texts = nodes.map((node) => cleanText(node.nodeValue));
    const resp = await sendMessage({ type: "translate", texts });
    if (resp.ok && Array.isArray(resp.translated)) {
      nodes.forEach((node, i) => {
        const translated = resp.translated[i];
        if (!translated || !node.isConnected) return;
        const current = cleanText(node.nodeValue);
        if (current !== texts[i]) return; // текст успели изменить — обработаем в следующий раз
        state.originals.set(node, node.nodeValue);
        state.selfWrites.add(node);
        node.nodeValue = translated;
        state.stats.translated += 1;
      });
      if (!state.pageTranslated) {
        state.pageTranslated = true;
        if (!state.notifiedTranslated) {
          state.notifiedTranslated = true;
          notifyPageState(true);
        }
      }
    }
    if (state.queue.size) scheduleFlush();
  }

  /* ---------- Сканирование ---------- */

  function scanRootDeep(root) {
    if (!state.settings.enabled || !state.settings.pageEnabled || state.paused || state.hidden) return;
    const nodes = [];
    collectTextNodesDeep(root, nodes);
    enqueue(nodes);
  }

  /* ---------- Наблюдатели ---------- */

  function handleMutations(mutations) {
    if (!state.settings.enabled || !state.settings.pageEnabled || state.paused || state.hidden) return;
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node.id === "ru-tr-bubble") continue;
          if (node.nodeType === Node.ELEMENT_NODE) {
            scanRootDeep(node);
            discoverShadowRoots(node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            handleAddedTextNode(node);
          }
        }
      } else if (mutation.type === "characterData") {
        handleCharacterData(mutation.target);
      }
    }
  }

  function handleAddedTextNode(node) {
    if (state.originals.has(node)) return;
    const parent = node.parentElement;
    if (!parent || isInsideSkipped(parent)) return;
    const text = cleanText(node.nodeValue);
    if (isTranslatableText(text) && isVisibleEnough(parent)) enqueue([node]);
  }

  // Изменение значения текстового узла.
  function handleCharacterData(node) {
    if (state.selfWrites.has(node)) {
      // Наша собственная запись перевода — просто сбрасываем флаг.
      state.selfWrites.delete(node);
      return;
    }
    // Если узел уже был переведён, а внешняя логика (React и т.п.) вернула
    // оригинал или поменяла текст — переведём заново.
    if (state.originals.has(node)) state.originals.delete(node);
    const parent = node.parentElement;
    if (!parent || isInsideSkipped(parent)) return;
    const text = cleanText(node.nodeValue);
    if (isTranslatableText(text)) enqueue([node]);
  }

  function attachObserver(root) {
    if (shadowObservers.has(root)) return;
    const obs = new MutationObserver(handleMutations);
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    shadowObservers.set(root, obs);
    if (root !== document) trackedShadowRoots.add(root);
  }

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(handleMutations);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    // НЕ создаём второй observer на documentElement — state.observer уже покрывает его.
    // attachObserver используем только для открытых Shadow DOM.
    discoverShadowRoots(document.documentElement);
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    for (const sr of trackedShadowRoots) {
      const obs = shadowObservers.get(sr);
      if (obs) obs.disconnect();
    }
    trackedShadowRoots.clear();
  }

  function startRescan() {
    if (state.rescanTimer) return;
    state.rescanTimer = setInterval(() => {
      if (document.hidden) return;
      if (!state.settings.enabled || !state.settings.pageEnabled || state.paused) return;
      scanRootDeep(document.body);
      discoverShadowRoots(document.documentElement);
    }, 3500);
  }

  function stopRescan() {
    if (state.rescanTimer) {
      clearInterval(state.rescanTimer);
      state.rescanTimer = null;
    }
  }

  function startPurge() {
    if (state.purgeTimer) return;
    // Периодически освобождаем память от отключённых узлов (долгие сессии на X/Reddit).
    state.purgeTimer = setInterval(() => {
      for (const node of state.originals.keys()) {
        if (!node.isConnected) state.originals.delete(node);
      }
      if (state.queue.size > 500) state.queue.clear();
    }, 30000);
  }

  /* ---------- Восстановление оригинала ---------- */

  function restoreOriginals() {
    for (const [node, original] of state.originals) {
      if (node.isConnected) {
        state.selfWrites.add(node);
        node.nodeValue = original;
      }
    }
    state.originals.clear();
    state.queue.clear();
    state.pageTranslated = false;
    state.notifiedTranslated = false;
    state.stats.translated = 0;
    notifyPageState(false);
  }

  /* ---------- Всплывающий перевод выделения ---------- */

  function ensureBubble() {
    if (state.bubble && state.bubble.isConnected) return state.bubble;
    const bubble = document.createElement("div");
    bubble.id = "ru-tr-bubble";
    bubble.setAttribute("translate", "no");
    bubble.className = "notranslate";
    bubble.innerHTML = `
      <div class="ru-tr-head">
        <span class="ru-tr-logo">RU</span>
        <span class="ru-tr-title">Перевод</span>
        <button class="ru-tr-copy" type="button" title="Скопировать">⧉</button>
        <button class="ru-tr-close" type="button" title="Закрыть">✕</button>
      </div>
      <div class="ru-tr-text"></div>
    `;
    bubble.addEventListener("mousedown", (e) => e.stopPropagation());
    bubble.addEventListener("mouseup", (e) => e.stopPropagation());
    bubble.querySelector(".ru-tr-close").addEventListener("click", hideBubble);
    bubble.querySelector(".ru-tr-copy").addEventListener("click", () => {
      const text = bubble.querySelector(".ru-tr-text").textContent || "";
      navigator.clipboard?.writeText(text).catch(() => {});
      const btn = bubble.querySelector(".ru-tr-copy");
      btn.textContent = "✓";
      setTimeout(() => { btn.textContent = "⧉"; }, 900);
    });
    (document.body || document.documentElement).appendChild(bubble);
    state.bubble = bubble;
    return bubble;
  }

  function positionBubble(bubble) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    bubble.style.visibility = "hidden";
    bubble.classList.add("ru-tr-visible");
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const margin = 8;

    let top = rect.bottom + margin;
    if (top + bh > window.innerHeight - margin) top = rect.top - bh - margin;
    if (top < margin) top = margin;

    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - bw - margin));

    bubble.style.top = `${Math.round(top + window.scrollY)}px`;
    bubble.style.left = `${Math.round(left + window.scrollX)}px`;
    bubble.style.visibility = "visible";
  }

  function showBubble(text, isLoading) {
    const bubble = ensureBubble();
    const body = bubble.querySelector(".ru-tr-text");
    body.textContent = text;
    bubble.classList.toggle("ru-tr-loading", Boolean(isLoading));
    positionBubble(bubble);
    clearTimeout(state.bubbleHideTimer);
  }

  function hideBubble() {
    if (state.bubble) state.bubble.classList.remove("ru-tr-visible");
    state.lastSelectionText = "";
  }

  async function handleSelection() {
    if (!state.settings.enabled || !state.settings.selectionEnabled || !state.settings.showBubble) return;
    const selection = window.getSelection();
    const text = cleanText(selection ? selection.toString() : "");
    if (!text || text.length < 2 || text.length > 4000) {
      hideBubble();
      return;
    }
    if (looksRussian(text, 0.9)) {
      hideBubble();
      return;
    }
    if (text === state.lastSelectionText) return;
    state.lastSelectionText = text;

    showBubble("Перевожу…", true);
    const resp = await sendMessage({ type: "translate", texts: [text] });
    if (state.lastSelectionText !== text) return;
    if (resp.ok && resp.translated?.[0]) {
      showBubble(resp.translated[0], false);
    } else {
      showBubble("Не удалось перевести. Проверьте интернет.", false);
    }
  }

  function onSelectionChange() {
    clearTimeout(state.selectionTimer);
    const selection = window.getSelection();
    const text = cleanText(selection ? selection.toString() : "");
    if (!text) {
      hideBubble();
      return;
    }
    state.selectionTimer = setTimeout(handleSelection, 250);
  }

  /* ---------- Настройки ---------- */

  function applySettings(next) {
    const prev = state.settings;
    state.settings = { ...state.settings, ...next };
    state.paused = false;
    const pageOn = state.settings.enabled && state.settings.pageEnabled;

    if (!pageOn) {
      stopObserver();
      stopRescan();
      if (prev.enabled && prev.pageEnabled) restoreOriginals();
    } else {
      startObserver();
      startRescan();
      if (!state.hidden) {
        scanRootDeep(document.body);
        discoverShadowRoots(document.documentElement);
      }
    }
    if (!state.settings.enabled || !state.settings.selectionEnabled || !state.settings.showBubble) hideBubble();
    notifyPageState(state.pageTranslated);
  }

  /* ---------- Сообщения от фона/popup ---------- */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "settings-updated") {
      applySettings(message.settings || {});
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "translate-page-now") {
      state.paused = false;
      state.hidden = document.hidden;
      applySettings({ enabled: true, pageEnabled: true });
      if (!state.hidden) {
        scanRootDeep(document.body);
        discoverShadowRoots(document.documentElement);
      }
      sendResponse({ ok: true, stats: state.stats });
      return;
    }
    if (message?.type === "restore-page") {
      state.paused = true;
      restoreOriginals();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "get-page-state") {
      sendResponse({ ok: true, translated: state.stats.translated, pageTranslated: state.pageTranslated });
      return;
    }
  });

  /* ---------- Видимость вкладки ---------- */

  document.addEventListener("visibilitychange", () => {
    state.hidden = document.hidden;
    if (document.hidden) {
      // Не снимаем наблюдателей — просто приостанавливаем обработку.
    } else if (state.settings.enabled && state.settings.pageEnabled && !state.paused) {
      scanRootDeep(document.body);
      discoverShadowRoots(document.documentElement);
    }
  });

  /* ---------- Инициализация ---------- */

  async function init() {
    const resp = await sendMessage({ type: "get-settings" });
    if (resp.ok) state.settings = { ...state.settings, ...resp.settings };

    document.addEventListener("selectionchange", onSelectionChange, { passive: true });
    document.addEventListener("scroll", () => {
      if (state.bubble && state.bubble.classList.contains("ru-tr-visible")) positionBubble(state.bubble);
    }, { passive: true, capture: true });
    // Закрытие пузыря по клику вне его.
    document.addEventListener("mousedown", (e) => {
      if (state.bubble && state.bubble.classList.contains("ru-tr-visible") && !state.bubble.contains(e.target)) {
        // Не закрываем, если клик начинается внутри выделения — оставим поведение браузера.
      }
    }, { passive: true });

    startPurge();

    if (state.settings.enabled && state.settings.pageEnabled) {
      startObserver();
      startRescan();
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          if (!state.hidden) {
            scanRootDeep(document.body);
            discoverShadowRoots(document.documentElement);
          }
        }, { once: true });
      } else if (!state.hidden) {
        scanRootDeep(document.body);
        discoverShadowRoots(document.documentElement);
      }
    }

    notifyPageState(state.pageTranslated);
  }

  init();
})();
