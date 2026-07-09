const DEFAULTS = {
  enabled: true,
  selectionEnabled: true,
  pageEnabled: true,
  showBubble: true
};

const els = {
  enabled: document.getElementById("enabled"),
  pageEnabled: document.getElementById("pageEnabled"),
  selectionEnabled: document.getElementById("selectionEnabled"),
  showBubble: document.getElementById("showBubble"),
  translateNow: document.getElementById("translateNow"),
  restore: document.getElementById("restore"),
  status: document.getElementById("status"),
  pagestate: document.getElementById("pagestate")
};

function setStatus(text, kind) {
  els.status.textContent = text || "";
  els.status.className = "status" + (kind ? " " + kind : "");
}

function setPageState(text) {
  els.pagestate.innerHTML = text || "";
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get-settings" }, (resp) => {
      if (chrome.runtime.lastError) return resolve(DEFAULTS);
      resolve({ ...DEFAULTS, ...(resp?.settings || {}) });
    });
  });
}

function saveSettingsToBg(settings) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "save-settings", settings }, (resp) => {
      if (chrome.runtime.lastError) return resolve({ ok: false });
      resolve(resp || { ok: false });
    });
  });
}

async function loadSettings() {
  const settings = await getSettings();
  els.enabled.checked = settings.enabled;
  els.pageEnabled.checked = settings.pageEnabled;
  els.selectionEnabled.checked = settings.selectionEnabled;
  els.showBubble.checked = settings.showBubble !== false;
}

async function saveSettings() {
  const settings = {
    enabled: els.enabled.checked,
    pageEnabled: els.pageEnabled.checked,
    selectionEnabled: els.selectionEnabled.checked,
    showBubble: els.showBubble.checked
  };
  await saveSettingsToBg(settings);
  setStatus("Сохранено", "ok");
  setTimeout(() => setStatus(""), 1200);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToActiveTab(payload) {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, error: "Нет активной вкладки" };
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, payload);
    return resp || { ok: false, error: "Нет ответа от страницы" };
  } catch (error) {
    return { ok: false, error: "Обновите страницу (Ctrl+R) и попробуйте ещё раз" };
  }
}

async function refreshPageState() {
  const resp = await sendToActiveTab({ type: "get-page-state" });
  if (resp.ok) {
    if (resp.pageTranslated) {
      setPageState(`Страница переведена: <b>${resp.translated}</b> фрагм.`);
    } else {
      setPageState("Оригинал");
    }
  } else {
    setPageState("");
  }
}

for (const key of ["enabled", "pageEnabled", "selectionEnabled", "showBubble"]) {
  els[key].addEventListener("change", saveSettings);
}

els.translateNow.addEventListener("click", async () => {
  setStatus("Перевожу страницу…");
  els.enabled.checked = true;
  els.pageEnabled.checked = true;
  await saveSettings();
  const resp = await sendToActiveTab({ type: "translate-page-now" });
  if (resp.ok) {
    setStatus("Готово — страница переводится", "ok");
    setTimeout(refreshPageState, 800);
  } else {
    setStatus(resp.error || "Ошибка", "err");
  }
});

els.restore.addEventListener("click", async () => {
  const resp = await sendToActiveTab({ type: "restore-page" });
  if (resp.ok) {
    setStatus("Показан оригинал", "ok");
    refreshPageState();
  } else {
    setStatus(resp.error || "Ошибка", "err");
  }
});

loadSettings().then(refreshPageState);
