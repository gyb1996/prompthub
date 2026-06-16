const DB_NAME = "prompt-vault-local";
const DB_VERSION = 1;
const STORE_NAMES = ["scenes", "prompts", "versions"];
const ALL_SCENES = "all";
const THEME_KEY = "prompthub-theme";
const BACKUP_KEY = "prompthub-last-backup-at";

const state = {
  db: null,
  scenes: [],
  prompts: [],
  versions: [],
  selectedSceneId: ALL_SCENES,
  selectedPromptId: null,
  selectedVersionId: null,
  search: "",
  sort: "updated",
  showAllVersions: false,
  fileHandle: null,
  fileName: "",
  fileLastSavedAt: "",
  isDirty: false,
  deferredInstallPrompt: null,
};

const els = Object.fromEntries(
  [
    "sceneList",
    "promptList",
    "promptCount",
    "detailEmpty",
    "detailContent",
    "detailTitle",
    "tagList",
    "favoritePromptButton",
    "promptMenuButton",
    "promptMenu",
    "versionSelect",
    "updatedAt",
    "contentPanel",
    "promptContent",
    "versionNote",
    "versionHistory",
    "showAllVersionsButton",
    "searchInput",
    "sortSelect",
    "importFile",
    "openJsonButton",
    "saveFileButton",
    "installButton",
    "editorDialog",
    "editorForm",
    "dialogEyebrow",
    "dialogTitle",
    "formFields",
    "manageDialog",
    "storageStats",
    "storageLocation",
    "revealStorageButton",
    "fileStatus",
    "saveFileFromManageButton",
    "toast",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeTags(value = "") {
  return value
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function relativeTime(value) {
  if (!value) return "";
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("visible"), 2200);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("scenes")) db.createObjectStore("scenes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("prompts")) {
        const store = db.createObjectStore("prompts", { keyPath: "id" });
        store.createIndex("sceneId", "sceneId");
      }
      if (!db.objectStoreNames.contains("versions")) {
        const store = db.createObjectStore("versions", { keyPath: "id" });
        store.createIndex("promptId", "promptId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const fileAccessSupported = "showOpenFilePicker" in window && "showSaveFilePicker" in window;

function store(name, mode = "readonly") {
  return state.db.transaction(name, mode).objectStore(name);
}

const getAll = (name) => requestToPromise(store(name).getAll());
const putItem = (name, item) => requestToPromise(store(name, "readwrite").put(item));
const deleteItem = (name, id) => requestToPromise(store(name, "readwrite").delete(id));
const clearStore = (name) => requestToPromise(store(name, "readwrite").clear());

function currentData() {
  return {
    scenes: state.scenes,
    prompts: state.prompts,
    versions: state.versions,
  };
}

function buildPayload() {
  return {
    app: "PromptHub",
    schemaVersion: 1,
    exportedAt: now(),
    data: currentData(),
  };
}

function normalizePayload(payload) {
  const data = payload.data || payload;
  if (!STORE_NAMES.every((name) => Array.isArray(data[name]))) {
    throw new Error("JSON 数据结构不正确");
  }
  return {
    scenes: data.scenes,
    prompts: data.prompts,
    versions: data.versions,
  };
}

async function replaceAllData(data) {
  await Promise.all(STORE_NAMES.map(clearStore));
  await Promise.all(STORE_NAMES.flatMap((name) => data[name].map((item) => putItem(name, item))));
  state.selectedSceneId = ALL_SCENES;
  state.selectedPromptId = null;
  state.selectedVersionId = null;
  await refreshData();
}

function markDirty() {
  state.isDirty = true;
  updateFileStatus();
}

function clearDirty(savedAt = now()) {
  state.isDirty = false;
  state.fileLastSavedAt = savedAt;
  updateFileStatus();
}

function updateFileStatus() {
  const dirtyLabel = state.isDirty ? " · 有未保存改动" : " · 已保存";
  const status = state.fileHandle
    ? `${state.fileName}${dirtyLabel}${state.fileLastSavedAt ? ` · ${relativeTime(state.fileLastSavedAt)}` : ""}`
    : fileAccessSupported
      ? "未连接 JSON 文件，点击“保存”可选择保存位置"
      : "当前浏览器不支持直接写入本地文件，请使用导入/导出备份";
  if (els.fileStatus) els.fileStatus.textContent = status;
  if (els.saveFileButton) {
    els.saveFileButton.title = status;
    els.saveFileButton.classList.toggle("dirty", state.isDirty);
  }
}

async function refreshData() {
  const [scenes, prompts, versions] = await Promise.all(STORE_NAMES.map(getAll));
  state.scenes = scenes.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-CN"));
  state.prompts = prompts;
  state.versions = versions;
  reconcileSelection();
  render();
  updateFileStatus();
}

function selectedPrompt() {
  return state.prompts.find((prompt) => prompt.id === state.selectedPromptId);
}

function selectedVersion() {
  return versionsForPrompt(state.selectedPromptId).find((version) => version.id === state.selectedVersionId);
}

function versionsForPrompt(promptId) {
  return state.versions
    .filter((version) => version.promptId === promptId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function matchesSearch(prompt) {
  const query = state.search.trim().toLowerCase();
  if (!query) return true;
  const scene = state.scenes.find((item) => item.id === prompt.sceneId);
  const versionText = versionsForPrompt(prompt.id)
    .flatMap((version) => [version.label, version.notes, version.content, version.model, version.variables])
    .join(" ");
  return [scene?.name, prompt.title, prompt.summary, ...(prompt.tags || []), versionText]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function visiblePrompts() {
  const filtered = state.prompts.filter(
    (prompt) => (state.selectedSceneId === ALL_SCENES || prompt.sceneId === state.selectedSceneId) && matchesSearch(prompt),
  );
  return filtered.sort((a, b) => {
    if (state.sort === "title") return (a.title || "").localeCompare(b.title || "", "zh-CN");
    if (state.sort === "favorite") return Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite)) || new Date(b.updatedAt) - new Date(a.updatedAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}

function reconcileSelection() {
  if (state.selectedSceneId !== ALL_SCENES && !state.scenes.some((scene) => scene.id === state.selectedSceneId)) {
    state.selectedSceneId = ALL_SCENES;
  }
  const prompts = visiblePrompts();
  if (!prompts.some((prompt) => prompt.id === state.selectedPromptId)) state.selectedPromptId = prompts[0]?.id || null;
  const versions = versionsForPrompt(state.selectedPromptId);
  if (!versions.some((version) => version.id === state.selectedVersionId)) state.selectedVersionId = versions[0]?.id || null;
}

function render() {
  renderScenes();
  renderPrompts();
  renderDetail();
}

function renderScenes() {
  const allItem = {
    id: ALL_SCENES,
    name: "全部场景",
    count: state.prompts.filter(matchesSearch).length,
    icon: "▣",
  };
  const sceneItems = state.scenes.map((scene, index) => ({
    ...scene,
    count: state.prompts.filter((prompt) => prompt.sceneId === scene.id && matchesSearch(prompt)).length,
    icon: ["⌘", "▤", "▧", "◇", "⬡", "⌂"][index % 6],
  }));
  els.sceneList.innerHTML = [allItem, ...sceneItems]
    .map(
      (scene) => `
        <button class="scene-item ${scene.id === state.selectedSceneId ? "active" : ""}" data-scene-id="${scene.id}" type="button">
          <span class="scene-icon" aria-hidden="true">${scene.icon}</span>
          <span class="scene-name">${escapeHtml(scene.name)}</span>
          <span class="scene-count">${scene.count}</span>
        </button>
      `,
    )
    .join("");
}

function renderPrompts() {
  const prompts = visiblePrompts();
  els.promptList.innerHTML = prompts.length
    ? prompts
        .map((prompt) => {
          const scene = state.scenes.find((item) => item.id === prompt.sceneId);
          const tags = [scene?.name, ...(prompt.tags || [])].filter(Boolean).slice(0, 3);
          return `
            <button class="prompt-card ${prompt.id === state.selectedPromptId ? "active" : ""}" data-prompt-id="${prompt.id}" type="button">
              <span class="prompt-card-title">
                <h3>${escapeHtml(prompt.title)}</h3>
                <span class="card-actions">
                  <span class="card-star">${prompt.isFavorite ? "★" : "☆"}</span>
                  <span>•••</span>
                </span>
              </span>
              <span class="prompt-summary">${escapeHtml(prompt.summary || "暂无描述")}</span>
              <span class="card-footer">
                <span class="card-tags">
                  ${tags.map((tag, index) => `<span class="tag ${index === 0 ? "primary" : ""}">${escapeHtml(tag)}</span>`).join("")}
                </span>
                <span class="card-time">${relativeTime(prompt.updatedAt)}</span>
              </span>
            </button>
          `;
        })
        .join("")
    : `<div class="empty-state"><div class="empty-icon">P</div><h2>没有匹配结果</h2><p>调整搜索词或新建提示词。</p></div>`;
  els.promptCount.textContent = `共 ${prompts.length} 条提示词`;
}

function renderDetail() {
  const prompt = selectedPrompt();
  if (!prompt) {
    els.detailEmpty.classList.remove("hidden");
    els.detailContent.classList.add("hidden");
    return;
  }

  const scene = state.scenes.find((item) => item.id === prompt.sceneId);
  const versions = versionsForPrompt(prompt.id);
  const version = selectedVersion() || versions[0];
  state.selectedVersionId = version?.id || null;

  els.detailEmpty.classList.add("hidden");
  els.detailContent.classList.remove("hidden");
  els.detailTitle.textContent = prompt.title;
  els.favoritePromptButton.textContent = prompt.isFavorite ? "★" : "☆";
  els.tagList.innerHTML = [scene?.name, ...(prompt.tags || [])]
    .filter(Boolean)
    .map((tag, index) => `<span class="tag ${index === 0 ? "primary" : ""}">${escapeHtml(tag)}</span>`)
    .join("");
  els.versionSelect.innerHTML = versions
    .map((item, index) => `<option value="${item.id}" ${item.id === state.selectedVersionId ? "selected" : ""}>${escapeHtml(item.label)}${index === 0 ? "（最新）" : ""}</option>`)
    .join("");

  if (!version) {
    els.updatedAt.textContent = "";
    els.promptContent.textContent = "当前提示词还没有版本。";
    els.versionNote.textContent = "新建版本后可记录本次迭代的备注。";
    els.versionHistory.innerHTML = "";
    return;
  }

  els.updatedAt.textContent = `更新于 ${relativeTime(version.updatedAt || version.createdAt)}`;
  els.promptContent.textContent = version.content || "";
  els.versionNote.textContent = version.notes || "暂无备注";
  const shownVersions = state.showAllVersions ? versions : versions.slice(0, 4);
  els.versionHistory.innerHTML = shownVersions
    .map(
      (item) => `
        <button class="history-row" data-version-id="${item.id}" type="button">
          <span class="history-label">${escapeHtml(item.label)}</span>
          <span class="history-notes">${item.id === state.selectedVersionId ? '<span class="current-pill">当前版本</span>' : ""}${escapeHtml(item.notes || "未记录版本说明")}</span>
          <span class="history-time">${relativeTime(item.createdAt)}</span>
        </button>
      `,
    )
    .join("");
  els.showAllVersionsButton.textContent = state.showAllVersions ? "收起版本历史" : `查看全部版本（${versions.length}）`;
}

function field(name, label, value = "", type = "text", options = {}) {
  const id = `field-${name}`;
  const required = options.required ? "required" : "";
  if (type === "textarea") {
    return `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" name="${name}" class="${options.tall ? "tall" : ""}" ${required}>${escapeHtml(value)}</textarea></div>`;
  }
  if (type === "select") {
    return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}" ${required}>${options.items
      .map((item) => `<option value="${escapeHtml(item.value)}" ${item.value === value ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
      .join("")}</select></div>`;
  }
  return `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${required}></div>`;
}

function openEditor({ eyebrow, title, html, onSubmit }) {
  els.dialogEyebrow.textContent = eyebrow;
  els.dialogTitle.textContent = title;
  els.formFields.innerHTML = html;
  els.editorForm.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(els.editorForm).entries());
    await onSubmit(data);
    els.editorDialog.close();
    await refreshData();
  };
  els.editorDialog.showModal();
  requestAnimationFrame(() => els.formFields.querySelector("input, textarea, select")?.focus());
}

function sceneForm(scene = {}) {
  return [
    field("name", "场景名称", scene.name, "text", { required: true }),
    field("description", "场景说明", scene.description, "textarea"),
    field("color", "标识色", scene.color || "#0866ff", "color"),
  ].join("");
}

function promptForm(prompt = {}) {
  return [
    field("sceneId", "所属场景", prompt.sceneId || (state.selectedSceneId === ALL_SCENES ? state.scenes[0]?.id : state.selectedSceneId), "select", {
      required: true,
      items: state.scenes.map((scene) => ({ value: scene.id, label: scene.name })),
    }),
    field("title", "提示词名称", prompt.title, "text", { required: true }),
    field("summary", "简要说明", prompt.summary, "textarea"),
    field("tags", "标签（使用逗号分隔）", (prompt.tags || []).join(", "), "text"),
  ].join("");
}

function versionForm(version = {}) {
  const count = versionsForPrompt(state.selectedPromptId).length;
  return [
    field("label", "版本号", version.label || `v${count + 1}.0`, "text", { required: true }),
    field("content", "提示词内容", version.content, "textarea", { required: true, tall: true }),
    field("notes", "版本备注", version.notes, "textarea"),
    field("model", "适用模型", version.model, "text"),
    field("temperature", "模型参数", version.temperature, "text"),
    field("variables", "变量说明", version.variables, "textarea"),
  ].join("");
}

async function saveScene(data, scene = {}) {
  const item = {
    id: scene.id || uid(),
    name: data.name.trim(),
    description: data.description.trim(),
    color: data.color || "#0866ff",
    createdAt: scene.createdAt || now(),
    updatedAt: now(),
  };
  await putItem("scenes", item);
  state.selectedSceneId = item.id;
  markDirty();
  showToast("场景已保存");
}

async function savePrompt(data, prompt = {}) {
  const item = {
    id: prompt.id || uid(),
    sceneId: data.sceneId,
    title: data.title.trim(),
    summary: data.summary.trim(),
    tags: normalizeTags(data.tags),
    isFavorite: Boolean(prompt.isFavorite),
    createdAt: prompt.createdAt || now(),
    updatedAt: now(),
  };
  await putItem("prompts", item);
  state.selectedSceneId = item.sceneId;
  state.selectedPromptId = item.id;
  markDirty();
  showToast("提示词已保存");
}

async function saveVersion(data, version = {}) {
  const promptId = version.promptId || state.selectedPromptId;
  const item = {
    id: version.id || uid(),
    promptId,
    label: data.label.trim(),
    content: data.content,
    notes: data.notes.trim(),
    model: data.model.trim(),
    temperature: data.temperature.trim(),
    variables: data.variables.trim(),
    isFavorite: Boolean(version.isFavorite),
    createdAt: version.createdAt || now(),
    updatedAt: now(),
  };
  await putItem("versions", item);
  const prompt = state.prompts.find((entry) => entry.id === promptId);
  if (prompt) await putItem("prompts", { ...prompt, updatedAt: now() });
  state.selectedVersionId = item.id;
  markDirty();
  showToast("版本已保存");
}

async function togglePromptFavorite() {
  const prompt = selectedPrompt();
  if (!prompt) return;
  await putItem("prompts", { ...prompt, isFavorite: !prompt.isFavorite, updatedAt: now() });
  markDirty();
  await refreshData();
}

async function deletePrompt() {
  const prompt = selectedPrompt();
  if (!prompt || !confirm("删除该提示词及全部版本？")) return;
  await Promise.all(versionsForPrompt(prompt.id).map((version) => deleteItem("versions", version.id)));
  await deleteItem("prompts", prompt.id);
  state.selectedPromptId = null;
  markDirty();
  showToast("提示词已删除");
  await refreshData();
}

async function deleteVersion() {
  const version = selectedVersion();
  if (!version || !confirm(`删除版本“${version.label}”？`)) return;
  await deleteItem("versions", version.id);
  state.selectedVersionId = null;
  els.promptMenu.classList.add("hidden");
  markDirty();
  showToast("版本已删除");
  await refreshData();
}

async function deleteScene() {
  if (state.selectedSceneId === ALL_SCENES) {
    showToast("请先选择一个具体场景");
    return;
  }
  const scene = state.scenes.find((item) => item.id === state.selectedSceneId);
  if (!scene || !confirm(`删除“${scene.name}”及其中全部提示词？`)) return;
  const promptIds = state.prompts.filter((prompt) => prompt.sceneId === scene.id).map((prompt) => prompt.id);
  const versionIds = state.versions.filter((version) => promptIds.includes(version.promptId)).map((version) => version.id);
  await Promise.all(versionIds.map((id) => deleteItem("versions", id)));
  await Promise.all(promptIds.map((id) => deleteItem("prompts", id)));
  await deleteItem("scenes", scene.id);
  state.selectedSceneId = ALL_SCENES;
  state.selectedPromptId = null;
  els.manageDialog.close();
  markDirty();
  showToast("场景已删除");
  await refreshData();
}

function exportJson() {
  const payload = buildPayload();
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `prompthub-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  localStorage.setItem(BACKUP_KEY, now());
  showToast("备份已导出");
}

async function importJson(file, options = {}) {
  const data = normalizePayload(JSON.parse(await file.text()));
  if (!options.skipConfirm && !confirm("导入将覆盖当前浏览器中的全部数据，继续？")) return;
  await replaceAllData(data);
  if (options.asWorkingFile) {
    state.fileName = file.name;
    clearDirty();
  } else {
    markDirty();
  }
  showToast("数据导入完成");
}

async function openWorkingJsonFile() {
  if (!fileAccessSupported) {
    showToast("当前浏览器不支持直接打开并写回文件，请使用导入备份");
    els.importFile.click();
    return;
  }
  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: "PromptHub JSON",
        accept: { "application/json": [".json"] },
      },
    ],
  });
  const file = await handle.getFile();
  if (!confirm(`打开“${file.name}”会覆盖当前浏览器中的库，继续？`)) return;
  await importJson(file, { skipConfirm: true, asWorkingFile: true });
  state.fileHandle = handle;
  state.fileName = file.name;
  clearDirty(new Date(file.lastModified).toISOString());
  showToast(`已打开 ${file.name}`);
}

async function chooseSaveFile() {
  return window.showSaveFilePicker({
    suggestedName: `prompthub-${new Date().toISOString().slice(0, 10)}.json`,
    types: [
      {
        description: "PromptHub JSON",
        accept: { "application/json": [".json"] },
      },
    ],
  });
}

async function saveWorkingJsonFile() {
  if (!fileAccessSupported) {
    exportJson();
    showToast("当前浏览器不支持直接保存到指定文件，已改为导出备份");
    return;
  }
  if (!state.fileHandle) {
    state.fileHandle = await chooseSaveFile();
    state.fileName = state.fileHandle.name;
  }
  const writable = await state.fileHandle.createWritable();
  await writable.write(JSON.stringify(buildPayload(), null, 2));
  await writable.close();
  clearDirty();
  showToast(`已保存到 ${state.fileName}`);
}

function openManageDialog() {
  const lastBackupAt = localStorage.getItem(BACKUP_KEY);
  els.storageStats.innerHTML = [
    ["场景", state.scenes.length],
    ["提示词", state.prompts.length],
    ["版本", state.versions.length],
    ["上次备份", lastBackupAt ? relativeTime(lastBackupAt) : "未导出"],
  ]
    .map(([label, count]) => `<div class="stat-card"><strong>${count}</strong><span>${label}</span></div>`)
    .join("");
  els.storageLocation.textContent = `浏览器 IndexedDB · ${window.location.origin}`;
  els.revealStorageButton.textContent = "导出备份";
  updateFileStatus();
  els.manageDialog.showModal();
}

function toggleTheme() {
  const isDark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = isDark ? "light" : "dark";
  localStorage.setItem(THEME_KEY, isDark ? "light" : "dark");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    els.installButton.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    state.deferredInstallPrompt = null;
    els.installButton.classList.add("hidden");
    showToast("PromptHub 已安装");
  });
}

function bindEvents() {
  document.querySelector("#newSceneButton").addEventListener("click", () =>
    openEditor({ eyebrow: "SCENE", title: "新建场景", html: sceneForm(), onSubmit: (data) => saveScene(data) }),
  );
  document.querySelector("#newPromptButton").addEventListener("click", () => {
    if (!state.scenes.length) return showToast("请先新建场景");
    openEditor({ eyebrow: "PROMPT", title: "新建提示词", html: promptForm(), onSubmit: (data) => savePrompt(data) });
  });
  document.querySelector("#newVersionButton").addEventListener("click", () => {
    if (!selectedPrompt()) return;
    openEditor({ eyebrow: "VERSION", title: "新建版本", html: versionForm(), onSubmit: (data) => saveVersion(data) });
  });
  document.querySelector("#editPromptButton").addEventListener("click", () => {
    const prompt = selectedPrompt();
    if (!prompt) return;
    els.promptMenu.classList.add("hidden");
    openEditor({ eyebrow: "PROMPT", title: "编辑提示词", html: promptForm(prompt), onSubmit: (data) => savePrompt(data, prompt) });
  });
  document.querySelector("#editVersionButton").addEventListener("click", () => {
    const version = selectedVersion();
    if (!version) return;
    els.promptMenu.classList.add("hidden");
    openEditor({ eyebrow: "VERSION", title: "编辑当前版本", html: versionForm(version), onSubmit: (data) => saveVersion(data, version) });
  });
  document.querySelector("#deleteVersionButton").addEventListener("click", deleteVersion);
  document.querySelector("#editNoteButton").addEventListener("click", () => {
    const version = selectedVersion();
    if (!version) return;
    openEditor({ eyebrow: "VERSION", title: "编辑当前版本", html: versionForm(version), onSubmit: (data) => saveVersion(data, version) });
  });
  document.querySelector("#editSceneButton").addEventListener("click", () => {
    const scene = state.scenes.find((item) => item.id === state.selectedSceneId);
    if (!scene) return showToast("请先选择一个具体场景");
    els.manageDialog.close();
    openEditor({ eyebrow: "SCENE", title: "编辑场景", html: sceneForm(scene), onSubmit: (data) => saveScene(data, scene) });
  });
  document.querySelector("#deletePromptButton").addEventListener("click", deletePrompt);
  document.querySelector("#deleteSceneButton").addEventListener("click", deleteScene);
  document.querySelector("#favoritePromptButton").addEventListener("click", togglePromptFavorite);
  document.querySelector("#copyButton").addEventListener("click", async () => {
    await navigator.clipboard.writeText(selectedVersion()?.content || "");
    showToast("提示词内容已复制");
  });
  document.querySelector("#expandButton").addEventListener("click", () => {
    els.contentPanel.classList.toggle("expanded");
    document.querySelector("#expandButton").textContent = els.contentPanel.classList.contains("expanded") ? "×" : "↗";
  });
  document.querySelector("#openJsonButton").addEventListener("click", async () => {
    try {
      await openWorkingJsonFile();
    } catch (error) {
      if (error.name !== "AbortError") showToast(error.message || "打开文件失败");
    }
  });
  document.querySelector("#saveFileButton").addEventListener("click", async () => {
    try {
      await saveWorkingJsonFile();
    } catch (error) {
      if (error.name !== "AbortError") showToast(error.message || "保存文件失败");
    }
  });
  document.querySelector("#exportButton").addEventListener("click", exportJson);
  document.querySelector("#installButton").addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    els.installButton.classList.add("hidden");
  });
  document.querySelector("#themeButton").addEventListener("click", toggleTheme);
  document.querySelector("#settingsButton").addEventListener("click", openManageDialog);
  document.querySelector("#manageButton").addEventListener("click", openManageDialog);
  els.revealStorageButton.addEventListener("click", () => {
    exportJson();
  });
  els.saveFileFromManageButton.addEventListener("click", async () => {
    try {
      await saveWorkingJsonFile();
      updateFileStatus();
    } catch (error) {
      if (error.name !== "AbortError") showToast(error.message || "保存文件失败");
    }
  });
  document.querySelector("#manageCloseButton").addEventListener("click", () => els.manageDialog.close());
  document.querySelector("#dialogCloseButton").addEventListener("click", () => els.editorDialog.close());
  document.querySelector("#cancelDialogButton").addEventListener("click", () => els.editorDialog.close());
  els.promptMenuButton.addEventListener("click", () => els.promptMenu.classList.toggle("hidden"));

  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    reconcileSelection();
    render();
  });
  els.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderPrompts();
  });
  els.sceneList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-scene-id]");
    if (!button) return;
    state.selectedSceneId = button.dataset.sceneId;
    state.selectedPromptId = null;
    reconcileSelection();
    render();
  });
  els.promptList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt-id]");
    if (!button) return;
    state.selectedPromptId = button.dataset.promptId;
    state.selectedVersionId = versionsForPrompt(state.selectedPromptId)[0]?.id || null;
    state.showAllVersions = false;
    render();
  });
  els.versionSelect.addEventListener("change", (event) => {
    state.selectedVersionId = event.target.value;
    renderDetail();
  });
  els.versionHistory.addEventListener("click", (event) => {
    const button = event.target.closest("[data-version-id]");
    if (!button) return;
    state.selectedVersionId = button.dataset.versionId;
    renderDetail();
  });
  els.showAllVersionsButton.addEventListener("click", () => {
    state.showAllVersions = !state.showAllVersions;
    renderDetail();
  });
  els.importFile.addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try {
      await importJson(file);
    } catch (error) {
      showToast(error.message || "导入失败");
    } finally {
      event.target.value = "";
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-wrap")) els.promptMenu.classList.add("hidden");
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      els.searchInput.focus();
    }
    if (event.key === "Escape" && els.contentPanel.classList.contains("expanded")) {
      els.contentPanel.classList.remove("expanded");
      document.querySelector("#expandButton").textContent = "↗";
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.isDirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function seedIfEmpty() {
  if ((await getAll("scenes")).length) return;
  const sceneData = [
    ["代码开发", "代码重构、审查与性能优化", "#0866ff"],
    ["文案写作", "营销、社媒与品牌内容", "#7c5cff"],
    ["数据分析", "SQL、报表与洞察提炼", "#16a36a"],
    ["产品设计", "需求拆解与方案设计", "#ff7b2c"],
    ["学习教育", "课程、总结与知识整理", "#6d73ff"],
    ["其他", "通用与未分类提示词", "#63708a"],
  ].map(([name, description, color]) => ({ id: uid(), name, description, color, createdAt: now(), updatedAt: now() }));
  const promptData = [
    [0, "代码重构：函数优化", "优化以下代码的可读性和性能，遵循最佳实践", ["重构", "函数"]],
    [1, "小红书文案润色", "将以下文案优化为小红书风格，更吸引人", ["小红书", "润色"]],
    [2, "SQL 查询优化", "优化以下 SQL 查询语句，提高查询效率", ["SQL", "优化"]],
    [3, "产品需求拆解", "将产品需求拆解为可执行的任务清单", ["需求分析", "规划"]],
    [4, "周报生成助手", "根据以下内容生成一份简洁的周报", ["周报", "总结"]],
    [5, "会议纪要整理", "从原始记录中提取决策、风险和待办事项", ["会议", "纪要"]],
  ].map(([sceneIndex, title, summary, tags], index) => ({
    id: uid(),
    sceneId: sceneData[sceneIndex].id,
    title,
    summary,
    tags,
    isFavorite: index < 3,
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - index * 7200000).toISOString(),
  }));
  const baseContent = `请优化以下代码的可读性和性能，遵循以下最佳实践：
1. 使用清晰的命名规范
2. 减少代码重复
3. 优化算法复杂度
4. 添加必要的注释
5. 遵循 SOLID 原则

代码如下：
\`\`\`
// 在这里粘贴你的代码
\`\`\``;
  const versionData = promptData.flatMap((prompt, promptIndex) =>
    [0, 1, 2].map((versionIndex) => ({
      id: uid(),
      promptId: prompt.id,
      label: `v3.${2 - versionIndex}`,
      content: promptIndex === 0 ? baseContent : `${prompt.summary}。\n\n请先分析目标受众和输入内容，再输出结构清晰、可直接使用的结果。`,
      notes: ["优化了性能建议，补充了算法复杂度分析", "增加了可读性优化建议和命名规范说明", "重构提示词结构，增加最佳实践列表"][versionIndex],
      model: "通用",
      temperature: "0.3",
      variables: "{{input}}",
      createdAt: new Date(Date.now() - versionIndex * 86400000 - promptIndex * 3600000).toISOString(),
      updatedAt: new Date(Date.now() - versionIndex * 86400000 - promptIndex * 3600000).toISOString(),
    })),
  );
  await Promise.all([
    ...sceneData.map((item) => putItem("scenes", item)),
    ...promptData.map((item) => putItem("prompts", item)),
    ...versionData.map((item) => putItem("versions", item)),
  ]);
}

async function init() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  state.db = await openDb();
  setupInstallPrompt();
  registerServiceWorker();
  bindEvents();
  await seedIfEmpty();
  await refreshData();
}

init().catch((error) => {
  console.error(error);
  showToast("初始化失败，请检查浏览器的本地存储权限");
});
