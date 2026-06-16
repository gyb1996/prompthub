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
  selectedPromptIds: new Set(),
  search: "",
  sort: "updated",
  showAllVersions: false,
  directoryHandle: null,
  directoryName: "",
  promptFileHandles: {},
  fileLastSavedAt: "",
  isDirty: false,
  deferredInstallPrompt: null,
};

const els = Object.fromEntries(
  [
    "sceneList",
    "promptList",
    "promptCount",
    "selectVisiblePromptsButton",
    "deleteSelectedPromptsButton",
    "detailEmpty",
    "detailContent",
    "detailTitle",
    "tagList",
    "savePromptFileButton",
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
const directoryAccessSupported = "showDirectoryPicker" in window;
const PROMPT_EXPORT_SCHEMA_VERSION = 2;

function store(name, mode = "readonly") {
  return state.db.transaction(name, mode).objectStore(name);
}

const getAll = (name) => requestToPromise(store(name).getAll());
const putItem = (name, item) => requestToPromise(store(name, "readwrite").put(item));
const deleteItem = (name, id) => requestToPromise(store(name, "readwrite").delete(id));

function slugifyFileName(value = "prompt") {
  const normalized = String(value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (normalized || "prompt").slice(0, 80);
}

function promptExportFileName(prompt) {
  return `${slugifyFileName(prompt.title)}--${prompt.id}.json`;
}

function promptBundle(prompt) {
  const scene = state.scenes.find((item) => item.id === prompt.sceneId) || null;
  return {
    app: "PromptHub",
    schemaVersion: PROMPT_EXPORT_SCHEMA_VERSION,
    type: "prompt",
    exportedAt: now(),
    data: {
      scene,
      prompt,
      versions: versionsForPrompt(prompt.id),
    },
  };
}

function promptBundleText(prompt) {
  return JSON.stringify(promptBundle(prompt), null, 2);
}

function normalizePromptBundle(payload) {
  const data = payload.data || payload;
  const prompt = data.prompt || payload.prompt;
  const versions = data.versions || payload.versions || [];
  const scene = data.scene || payload.scene || null;
  if (!prompt || !prompt.id || !Array.isArray(versions)) throw new Error("单个提示词 JSON 数据结构不正确");
  return { scene, prompt, versions };
}

function normalizeImportPayload(payload) {
  const data = payload.data || payload;
  if (data.prompt || payload.prompt) return [normalizePromptBundle(payload)];
  if (!STORE_NAMES.every((name) => Array.isArray(data[name]))) {
    throw new Error("JSON 数据结构不正确");
  }
  return data.prompts.map((prompt) => ({
    scene: data.scenes.find((scene) => scene.id === prompt.sceneId) || null,
    prompt,
    versions: data.versions.filter((version) => version.promptId === prompt.id),
  }));
}

async function ensureSceneForBundle(scene) {
  if (scene?.id && state.scenes.some((item) => item.id === scene.id)) return scene.id;
  if (scene?.name) {
    const byName = state.scenes.find((item) => item.name === scene.name);
    if (byName) return byName.id;
  }
  if (scene?.name) {
    const item = {
      ...scene,
      id: scene.id && !state.scenes.some((entry) => entry.id === scene.id) ? scene.id : uid(),
      createdAt: scene.createdAt || now(),
      updatedAt: now(),
    };
    await putItem("scenes", item);
    state.scenes.push(item);
    return item.id;
  }
  let fallback = state.scenes.find((item) => item.name === "其他");
  if (!fallback) {
    fallback = {
      id: uid(),
      name: "其他",
      description: "通用与未分类提示词",
      color: "#63708a",
      createdAt: now(),
      updatedAt: now(),
    };
    await putItem("scenes", fallback);
    state.scenes.push(fallback);
  }
  return fallback.id;
}

async function mergePromptBundles(bundles) {
  const usedPromptIds = new Set(state.prompts.map((prompt) => prompt.id));
  const usedVersionIds = new Set(state.versions.map((version) => version.id));
  let imported = 0;
  let copied = 0;
  let lastPromptId = null;

  for (const bundle of bundles) {
    const sceneId = await ensureSceneForBundle(bundle.scene);
    const sourcePrompt = bundle.prompt;
    const isDuplicate = usedPromptIds.has(sourcePrompt.id);
    const promptId = isDuplicate ? uid() : sourcePrompt.id;
    const importedAt = now();
    const prompt = {
      ...sourcePrompt,
      id: promptId,
      sceneId,
      title: isDuplicate ? `${sourcePrompt.title || "未命名提示词"}（副本）` : sourcePrompt.title,
      createdAt: sourcePrompt.createdAt || importedAt,
      updatedAt: importedAt,
    };
    await putItem("prompts", prompt);
    usedPromptIds.add(prompt.id);

    for (const sourceVersion of bundle.versions) {
      const versionId = usedVersionIds.has(sourceVersion.id) || isDuplicate ? uid() : sourceVersion.id;
      const version = {
        ...sourceVersion,
        id: versionId,
        promptId,
        createdAt: sourceVersion.createdAt || importedAt,
        updatedAt: sourceVersion.updatedAt || importedAt,
      };
      await putItem("versions", version);
      usedVersionIds.add(version.id);
    }

    imported += 1;
    if (isDuplicate) copied += 1;
    lastPromptId = promptId;
  }

  if (lastPromptId) state.selectedPromptId = lastPromptId;
  markDirty();
  await refreshData();
  return { imported, copied, lastPromptId };
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
  const status = state.directoryHandle
    ? `${state.directoryName}/prompthub-prompts${dirtyLabel}${state.fileLastSavedAt ? ` · ${relativeTime(state.fileLastSavedAt)}` : ""}`
    : directoryAccessSupported
      ? "未连接备份文件夹，点击“保存”可选择文件夹"
      : "当前浏览器不支持直接写入文件夹，请使用导出备份";
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
  state.selectedPromptIds = new Set([...state.selectedPromptIds].filter((id) => state.prompts.some((prompt) => prompt.id === id)));
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
          const isSelected = state.selectedPromptIds.has(prompt.id);
          return `
            <article class="prompt-card ${prompt.id === state.selectedPromptId ? "active" : ""} ${isSelected ? "selected" : ""}" data-prompt-id="${prompt.id}" role="button" tabindex="0" aria-label="${escapeHtml(prompt.title)}">
              <span class="prompt-card-title">
                <h3>${escapeHtml(prompt.title)}</h3>
                <span class="card-inline-actions">
                  <span class="card-star">${prompt.isFavorite ? "★" : "☆"}</span>
                  <button class="prompt-select-button ${isSelected ? "selected" : ""}" data-select-prompt-id="${prompt.id}" type="button" aria-pressed="${isSelected}" aria-label="${isSelected ? "取消选择" : "选择"}${escapeHtml(prompt.title)}">
                    ${isSelected ? "✓" : ""}
                  </button>
                </span>
              </span>
              <span class="prompt-summary">${escapeHtml(prompt.summary || "暂无描述")}</span>
              <span class="card-footer">
                <span class="card-tags">
                  ${tags.map((tag, index) => `<span class="tag ${index === 0 ? "primary" : ""}">${escapeHtml(tag)}</span>`).join("")}
                </span>
                <span class="card-time">${relativeTime(prompt.updatedAt)}</span>
              </span>
            </article>
          `;
        })
        .join("")
    : `<div class="empty-state"><div class="empty-icon">P</div><h2>没有匹配结果</h2><p>调整搜索词或新建提示词。</p></div>`;
  const selectedCount = state.selectedPromptIds.size;
  const allVisibleSelected = prompts.length > 0 && prompts.every((prompt) => state.selectedPromptIds.has(prompt.id));
  els.promptCount.textContent = selectedCount ? `共 ${prompts.length} 条提示词 · 已选 ${selectedCount} 条` : `共 ${prompts.length} 条提示词`;
  els.selectVisiblePromptsButton.textContent = allVisibleSelected ? "取消全选" : "全选";
  els.selectVisiblePromptsButton.disabled = prompts.length === 0;
  els.deleteSelectedPromptsButton.disabled = selectedCount === 0;
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
  state.selectedPromptIds.delete(prompt.id);
  state.selectedPromptId = null;
  markDirty();
  showToast("提示词已删除");
  await refreshData();
}

async function deleteSelectedPrompts() {
  const promptIds = [...state.selectedPromptIds].filter((id) => state.prompts.some((prompt) => prompt.id === id));
  if (!promptIds.length) return;
  if (!confirm(`删除已选的 ${promptIds.length} 条提示词及其全部版本？`)) return;
  const versionIds = state.versions.filter((version) => promptIds.includes(version.promptId)).map((version) => version.id);
  await Promise.all(versionIds.map((id) => deleteItem("versions", id)));
  await Promise.all(promptIds.map((id) => deleteItem("prompts", id)));
  if (promptIds.includes(state.selectedPromptId)) {
    state.selectedPromptId = null;
    state.selectedVersionId = null;
  }
  state.selectedPromptIds.clear();
  markDirty();
  showToast(`已删除 ${promptIds.length} 条提示词`);
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

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const contentBytes = encoder.encode(file.content);
    const checksum = crc32(contentBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x0800);
    writeUint16(localView, 8, 0);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, contentBytes.length);
    writeUint32(localView, 22, contentBytes.length);
    writeUint16(localView, 26, nameBytes.length);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, contentBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, 0);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, contentBytes.length);
    writeUint32(centralView, 24, contentBytes.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + contentBytes.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endHeader = new Uint8Array(22);
  const endView = new DataView(endHeader.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, offset);
  return new Blob([...localParts, ...centralParts, endHeader], { type: "application/zip" });
}

async function readPromptBundlesFromZip(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  let offset = 0;
  const bundles = [];

  while (offset + 30 <= buffer.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const contentStart = nameStart + fileNameLength + extraLength;
    const contentEnd = contentStart + compressedSize;
    if (contentEnd > buffer.byteLength) throw new Error("ZIP 数据不完整");
    const name = decoder.decode(new Uint8Array(buffer, nameStart, fileNameLength));
    if (name.endsWith(".json") && !name.endsWith("prompthub-manifest.json")) {
      if (method !== 0) throw new Error("暂不支持压缩过的 ZIP，请导入 PromptHub 导出的备份包或直接选择 JSON 文件");
      const text = decoder.decode(new Uint8Array(buffer, contentStart, compressedSize));
      bundles.push(...normalizeImportPayload(JSON.parse(text)));
    }
    offset = contentEnd;
  }

  if (!bundles.length) throw new Error("ZIP 中没有可导入的提示词 JSON");
  return bundles;
}

async function readPromptBundlesFromFiles(files) {
  const bundles = [];
  for (const file of files) {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".zip")) {
      bundles.push(...(await readPromptBundlesFromZip(file)));
    } else {
      bundles.push(...normalizeImportPayload(JSON.parse(await file.text())));
    }
  }
  return bundles;
}

function exportBackupZip() {
  const files = state.prompts.map((prompt) => ({
    name: `prompts/${promptExportFileName(prompt)}`,
    content: promptBundleText(prompt),
  }));
  files.push({
    name: "prompthub-manifest.json",
    content: JSON.stringify(
      {
        app: "PromptHub",
        schemaVersion: PROMPT_EXPORT_SCHEMA_VERSION,
        type: "backup-manifest",
        exportedAt: now(),
        promptCount: state.prompts.length,
      },
      null,
      2,
    ),
  });
  const url = URL.createObjectURL(buildZip(files));
  const link = document.createElement("a");
  link.href = url;
  link.download = `prompthub-${new Date().toISOString().slice(0, 10)}.zip`;
  link.click();
  URL.revokeObjectURL(url);
  localStorage.setItem(BACKUP_KEY, now());
  showToast("备份已导出");
}

async function importJson(file, options = {}) {
  const bundles = await readPromptBundlesFromFiles([file]);
  const result = await mergePromptBundles(bundles);
  if (options.asWorkingFile && bundles.length === 1 && result.lastPromptId && options.handle) {
    state.promptFileHandles[result.lastPromptId] = options.handle;
  }
  showToast(`已导入 ${result.imported} 条提示词${result.copied ? `，${result.copied} 条另存为副本` : ""}`);
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
  await importJson(file, { asWorkingFile: true, handle });
}

async function writeTextFileHandle(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function savePromptJsonFile(prompt = selectedPrompt()) {
  if (!prompt) return showToast("请先选择一条提示词");
  const text = promptBundleText(prompt);
  if (!fileAccessSupported) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = promptExportFileName(prompt);
    link.click();
    URL.revokeObjectURL(url);
    showToast("提示词 JSON 已下载");
    return;
  }
  if (!state.promptFileHandles[prompt.id]) {
    state.promptFileHandles[prompt.id] = await window.showSaveFilePicker({
      suggestedName: promptExportFileName(prompt),
      types: [
        {
          description: "PromptHub Prompt JSON",
          accept: { "application/json": [".json"] },
        },
      ],
    });
  }
  await writeTextFileHandle(state.promptFileHandles[prompt.id], text);
  showToast(`已保存 ${prompt.title}`);
}

async function getManagedPromptDirectory() {
  if (!state.directoryHandle) {
    state.directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    state.directoryName = state.directoryHandle.name;
  }
  return state.directoryHandle.getDirectoryHandle("prompthub-prompts", { create: true });
}

async function fileExistsInDirectory(directory, fileName) {
  try {
    await directory.getFileHandle(fileName);
    return true;
  } catch (error) {
    if (error.name === "NotFoundError") return false;
    throw error;
  }
}

async function saveAllPromptsToFolder() {
  if (!directoryAccessSupported) {
    showToast("当前页面不支持写入文件夹，请用 Chrome 或 Edge 在 localhost 或 HTTPS 页面打开");
    return;
  }
  const directory = await getManagedPromptDirectory();
  const files = await Promise.all(
    state.prompts.map(async (prompt) => {
      const fileName = promptExportFileName(prompt);
      return {
        prompt,
        fileName,
        exists: await fileExistsInDirectory(directory, fileName),
      };
    }),
  );
  const duplicateCount = files.filter((file) => file.exists).length;
  const shouldOverwrite =
    duplicateCount === 0 ||
    confirm(`检测到 ${duplicateCount} 个同名提示词 JSON。点击“确定”覆盖这些文件，点击“取消”跳过重复文件。`);
  let savedCount = 0;
  let skippedCount = 0;
  for (const file of files) {
    if (file.exists && !shouldOverwrite) {
      skippedCount += 1;
      continue;
    }
    const fileHandle = await directory.getFileHandle(file.fileName, { create: true });
    await writeTextFileHandle(fileHandle, promptBundleText(file.prompt));
    savedCount += 1;
  }
  const manifestHandle = await directory.getFileHandle("prompthub-manifest.json", { create: true });
  await writeTextFileHandle(
    manifestHandle,
    JSON.stringify(
      {
        app: "PromptHub",
        schemaVersion: PROMPT_EXPORT_SCHEMA_VERSION,
        type: "folder-manifest",
        savedAt: now(),
        promptCount: state.prompts.length,
      },
      null,
      2,
    ),
  );
  localStorage.setItem(BACKUP_KEY, now());
  if (skippedCount === 0) clearDirty();
  else updateFileStatus();
  showToast(`已保存 ${savedCount} 条提示词到文件夹${skippedCount ? `，跳过 ${skippedCount} 条` : ""}`);
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
      await saveAllPromptsToFolder();
    } catch (error) {
      if (error.name !== "AbortError") showToast(error.message || "保存到文件夹失败");
    }
  });
  document.querySelector("#exportButton").addEventListener("click", exportBackupZip);
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
    exportBackupZip();
  });
  els.saveFileFromManageButton.addEventListener("click", async () => {
    try {
      await saveAllPromptsToFolder();
      updateFileStatus();
    } catch (error) {
      if (error.name !== "AbortError") showToast(error.message || "保存到文件夹失败");
    }
  });
  els.savePromptFileButton.addEventListener("click", async () => {
    try {
      await savePromptJsonFile();
    } catch (error) {
      if (error.name !== "AbortError") showToast(error.message || "保存提示词失败");
    }
  });
  document.querySelector("#manageCloseButton").addEventListener("click", () => els.manageDialog.close());
  document.querySelector("#dialogCloseButton").addEventListener("click", () => els.editorDialog.close());
  document.querySelector("#cancelDialogButton").addEventListener("click", () => els.editorDialog.close());
  els.promptMenuButton.addEventListener("click", () => els.promptMenu.classList.toggle("hidden"));

  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    state.selectedPromptIds.clear();
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
    state.selectedPromptIds.clear();
    reconcileSelection();
    render();
  });
  els.selectVisiblePromptsButton.addEventListener("click", () => {
    const prompts = visiblePrompts();
    const allSelected = prompts.length > 0 && prompts.every((prompt) => state.selectedPromptIds.has(prompt.id));
    if (allSelected) {
      prompts.forEach((prompt) => state.selectedPromptIds.delete(prompt.id));
    } else {
      prompts.forEach((prompt) => state.selectedPromptIds.add(prompt.id));
    }
    renderPrompts();
  });
  els.deleteSelectedPromptsButton.addEventListener("click", deleteSelectedPrompts);
  els.promptList.addEventListener("click", (event) => {
    const selectButton = event.target.closest("[data-select-prompt-id]");
    if (selectButton) {
      const id = selectButton.dataset.selectPromptId;
      if (state.selectedPromptIds.has(id)) state.selectedPromptIds.delete(id);
      else state.selectedPromptIds.add(id);
      renderPrompts();
      return;
    }
    const button = event.target.closest("[data-prompt-id]");
    if (!button) return;
    state.selectedPromptId = button.dataset.promptId;
    state.selectedVersionId = versionsForPrompt(state.selectedPromptId)[0]?.id || null;
    state.showAllVersions = false;
    render();
  });
  els.promptList.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const card = event.target.closest("[data-prompt-id]");
    if (!card || event.target.closest("[data-select-prompt-id]")) return;
    event.preventDefault();
    state.selectedPromptId = card.dataset.promptId;
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
    const files = Array.from(event.target.files);
    if (!files.length) return;
    try {
      const result = await mergePromptBundles(await readPromptBundlesFromFiles(files));
      showToast(`已导入 ${result.imported} 条提示词${result.copied ? `，${result.copied} 条另存为副本` : ""}`);
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
    [3, "产品需求拆解", "将产品想法拆解为目标、用户场景、范围和验收标准", ["需求分析", "PRD"]],
  ].map(([sceneIndex, title, summary, tags], index) => ({
    id: uid(),
    sceneId: sceneData[sceneIndex].id,
    title,
    summary,
    tags,
    isFavorite: true,
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - index * 7200000).toISOString(),
  }));
  const baseContent = `请把下面的产品想法整理成一份可执行的需求说明。

请按以下结构输出：
1. 背景与目标
2. 目标用户与使用场景
3. 核心需求范围
4. 非目标范围
5. 关键流程
6. 验收标准
7. 风险与待确认问题

产品想法：
{{input}}`;
  const versionData = promptData.flatMap((prompt, promptIndex) =>
    [0].map((versionIndex) => ({
      id: uid(),
      promptId: prompt.id,
      label: "v1.0",
      content: baseContent,
      notes: "初始产品需求拆解模板",
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
