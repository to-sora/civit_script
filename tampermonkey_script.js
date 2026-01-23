// ==UserScript==
// @name         Civitai Scraper Manager (HTML+JSON, Versioned, Editable)
// @namespace    http://tampermonkey.net/
// @version      2.3.0
// @description  Full manager for Civitai models: scrape, store, import/export, edit, manage 100+ items.
// @match        https://civitai.com/models/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// ==/UserScript==

(function () {
'use strict';

/* =====================================================================================
 * DATA MODEL
 * =====================================================================================

QueueItem {
  key: "modelId:versionId"
  modelId: number
  versionId: string ("000000" allowed)
  name: string
  meta: {
    ModelTitle?: string
    downloadlinks: string[]
    metaPairs: { key, value }[] | null
    pageUrl: string
    copiedMessage?: string | null
  }
  html: string
  updatedAt: ISOString
}

===================================================================================== */

const STORAGE_KEY = "civitai_manager_queue";

/* =====================================================================================
 * UTILITIES
 * ===================================================================================== */

const log = (msg) => console.log("[CivitaiManager]", msg);

const qs = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slugifyPreserveUnicode(s) {
  if (!s) return null;
  let out = "";
  for (const ch of s.trim()) {
    const c = ch.codePointAt(0);
    if (c <= 0x7f) {
      if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122)
      ) out += ch;
      else out += "_";
    } else out += ch;
  }
  return out.replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function parseModelAndVersionFromUrl() {
  const m = location.pathname.match(/^\/models\/(\d+)/);
  if (!m) return null;
  const sp = new URLSearchParams(location.search);
  return {
    modelId: parseInt(m[1], 10),
    versionId: sp.get("modelVersionId") || "000000"
  };
}

function makeKey(modelId, versionId) {
  return `${modelId}:${versionId}`;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function safeLower(s) { return (s || "").toString().toLowerCase(); }

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? (iso || "") : d.toLocaleString();
  } catch { return iso || ""; }
}

/* =====================================================================================
 * STORAGE (FIXED FOR MULTI-TAB)
 * ===================================================================================== */

async function loadQueue() {
  const raw = await GM_getValue(STORAGE_KEY, "[]");
  try { return JSON.parse(raw); }
  catch { return []; }
}

async function saveQueue(queue) {
  await GM_setValue(STORAGE_KEY, JSON.stringify(queue));
}

// Robust: always return array
async function loadQueueSafe() {
  const raw = await GM_getValue(STORAGE_KEY, "[]");
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Merge by key (last-write-wins for duplicates)
function mergeQueuesByKey(base, incoming) {
  const map = new Map();
  (base || []).forEach(it => { if (it && it.key) map.set(it.key, it); });
  (incoming || []).forEach(it => { if (it && it.key) map.set(it.key, it); });
  return Array.from(map.values());
}

// Atomic-ish upsert: read-latest → merge → write
async function upsertItemToStorage(item) {
  const latest = await loadQueueSafe();
  const merged = mergeQueuesByKey(latest, [item]);
  await GM_setValue(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

// Atomic-ish delete: read-latest → filter → write
async function deleteKeyFromStorage(key) {
  const latest = await loadQueueSafe();
  const next = latest.filter(x => x && x.key !== key);
  await GM_setValue(STORAGE_KEY, JSON.stringify(next));
  return next;
}

// Atomic-ish merge import: read-latest → merge(all) → write
async function mergeItemsIntoStorage(items) {
  const latest = await loadQueueSafe();
  const merged = mergeQueuesByKey(latest, items || []);
  await GM_setValue(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/* =====================================================================================
 * SCRAPE CURRENT PAGE
 * ===================================================================================== */

/**
 * Try to locate the "copy" button inside the original metadata table and read the copied message.
 * - Locate by span class: "m_8d3afb97 mantine-ActionIcon-icon"
 * - Some pages have 2 buttons; take the last one.
 * - Best-effort: click the button, then read clipboard.
 *   If clipboard access fails, returns null.
 */
async function tryGetCopiedMessageFromMetaTable() {
  try {
    const tbody = qs("tbody.m_b2404537");
    if (!tbody) return null;

    const iconSpans = qsa("span.m_8d3afb97.mantine-ActionIcon-icon", tbody);
    if (!iconSpans.length) return null;

    const lastIcon = iconSpans[iconSpans.length - 1];
    const btn = lastIcon.closest("button");
    if (!btn) return null;

    // Attempt to copy
    btn.click();
    await sleep(80);

    if (navigator.clipboard && navigator.clipboard.readText) {
      const txt = await navigator.clipboard.readText();
      const out = (txt || "").trim();
      return out || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function scrapeCurrentPage() {
  const ids = parseModelAndVersionFromUrl();
  if (!ids) throw new Error("Cannot parse model id");

  const h1 = qs("h1.__slug_titleF0Iq");
  const modelTitleRaw = h1?.textContent?.trim() || null;
  const ModelTitle = slugifyPreserveUnicode(modelTitleRaw);

  const descNodes = qsa(".TypographyStylesWrapper_root__qXSUB.RenderHtml_htmlRenderer__z8vxT");
  if (descNodes.length === 0) throw new Error("Description not found");

  const html = descNodes.slice(0, 2).map(n => n.innerHTML).join("\n<!-- ---- -->\n");

  const downloadlinks = qsa('a[href*="/api/download/models/"]')
    .map(a => a.getAttribute("href"))
    .filter(Boolean)
    .map(h => new URL(h.replace(/&amp;/g, "&"), location.origin).toString());

  if (!downloadlinks.length) throw new Error("Download link not found");

  const metaPairs = [];
  const tbody = qs("tbody.m_b2404537");
  if (tbody) {
    qsa("tr", tbody).forEach(tr => {
      const tds = qsa("td", tr);
      if (tds.length >= 2)
        metaPairs.push({
          key: tds[0].textContent.trim() || null,
          value: tds[1].textContent.trim() || null
        });
    });
  }

  const copiedMessage = await tryGetCopiedMessageFromMetaTable();

  const key = makeKey(ids.modelId, ids.versionId);

  return {
    key,
    modelId: ids.modelId,
    versionId: ids.versionId,
    name: modelTitleRaw || `model_${ids.modelId}`,
    html,
    meta: {
      ModelTitle,
      downloadlinks,
      metaPairs,
      pageUrl: location.href,
      copiedMessage
    },
    updatedAt: new Date().toISOString()
  };
}

/* =====================================================================================
 * IMPORT
 * ===================================================================================== */

function importFromJSON(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.items)) throw new Error("Invalid JSON");
  return data.items.map(x => ({
    key: x.key,
    modelId: x.modelId,
    versionId: x.versionId,
    name: x.name,
    html: "",
    meta: x.meta,
    updatedAt: new Date().toISOString()
  }));
}

function importFromHTML(text) {
  const items = [];
  const regex = /<!--\s*CIVITAI_ITEM([\s\S]*?)-->/g;
  let m;
  while ((m = regex.exec(text))) {
    const block = m[1];
    const modelId = block.match(/modelId=(\d+)/)?.[1];
    const versionId = block.match(/versionId=([0-9]+)/)?.[1] || "000000";
    if (!modelId) continue;
    const key = makeKey(modelId, versionId);
    items.push({
      key,
      modelId: parseInt(modelId, 10),
      versionId,
      name: key,
      html: text,
      meta: {},
      updatedAt: new Date().toISOString()
    });
  }
  return items;
}

/* =====================================================================================
 * EXPORT
 * ===================================================================================== */

async function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function exportAll(queue) {
  const json = {
    exportedAt: new Date().toISOString(),
    items: queue
  };
  await downloadFile(
    "civitai_export.json",
    JSON.stringify(json, null, 2),
    "application/json;charset=utf-8"
  );

  const html = queue.map(q => `
<!-- CIVITAI_ITEM
modelId=${q.modelId}
versionId=${q.versionId}
key=${q.key}
-->
<h1>${escapeHtml(q.name)}</h1>
${q.html}
<hr/>
`).join("\n");

  await downloadFile(
    "civitai_export.html",
    html,
    "text/html;charset=utf-8"
  );
}

/* =====================================================================================
 * UI (Floating Panel + Overlay Manager)
 * ===================================================================================== */

function buildUI() {
  // Floating panel
  const root = document.createElement("div");
  root.id = "cm-root";
  root.style.cssText = `
    position:fixed;
    top:60px; right:20px;
    width:420px; height:900px;
    background:#282c34; color:#abb2bf;
    z-index:99999; border-radius:10px;
    display:flex; flex-direction:column;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    box-shadow: 0 8px 30px rgba(0,0,0,.35);
    overflow:hidden;
  `;

  root.innerHTML = `
    <div id="cm-header" style="padding:10px 10px; background:#3a404d; cursor:move; display:flex; align-items:center; gap:8px;">
      <b style="flex:1; user-select:none;">Civitai Manager</b>
      <button id="cm-open-overlay" title="Open full manager" style="padding:4px 8px;">Manage</button>
      <button id="cm-min" title="Minimize" style="padding:4px 8px;">_</button>
    </div>

    <div id="cm-body" style="display:flex; flex-direction:column; min-height:0; flex:1;">
      <div style="padding:10px; display:flex; gap:6px; flex-wrap:wrap;">
        <button id="cm-add">Add Current</button>
        <button id="cm-export">Export</button>
        <button id="cm-import-json">Import JSON</button>
        <button id="cm-import-html">Import HTML</button>
      </div>

      <input id="cm-search" placeholder="search..." style="margin:0 10px 8px 10px; padding:6px; border-radius:6px; border:1px solid #444; background:#1f232a; color:#abb2bf;">

      <div id="cm-list" style="flex:1; overflow:auto; padding:6px 10px 10px 10px; min-height:0;"></div>

      <div id="cm-logwrap" style="border-top:1px solid #444; padding:8px 10px; background:#1f232a;">
        <div style="display:flex; align-items:center; gap:8px;">
          <b style="font-size:12px; color:#c8ccd4; flex:1;">Status / Errors</b>
          <button id="cm-clear-log" style="padding:2px 6px; font-size:12px;">Clear</button>
        </div>
        <div id="cm-log" style="margin-top:6px; max-height:90px; overflow:auto; font-size:12px; line-height:1.35; white-space:pre-wrap;"></div>
      </div>
    </div>
  `;

  document.body.appendChild(root);

  // Overlay manager (hidden by default)
  const overlay = document.createElement("div");
  overlay.id = "cm-overlay";
  overlay.style.cssText = `
    position:fixed; inset:0;
    z-index:100000;
    display:none;
    background: rgba(0,0,0,.65);
    color:#abb2bf;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;

  overlay.innerHTML = `
    <div id="cm-ov-card" style="
      position:absolute; inset:24px;
      background:#1f232a;
      border-radius:12px;
      display:flex;
      flex-direction:column;
      overflow:hidden;
      box-shadow: 0 10px 40px rgba(0,0,0,.45);
      border:1px solid rgba(255,255,255,.08);
    ">
      <div style="padding:12px 14px; background:#2b313c; display:flex; align-items:center; gap:10px;">
        <b style="flex:1;">Manager (Overlay)</b>
        <button id="cm-ov-close" style="padding:6px 10px;">Close</button>
      </div>

      <div style="display:flex; gap:12px; padding:12px; align-items:center; flex-wrap:wrap; border-bottom:1px solid rgba(255,255,255,.08);">
        <input id="cm-ov-search" placeholder="search..." style="flex:1; min-width:260px; padding:8px; border-radius:8px; border:1px solid #444; background:#12151a; color:#abb2bf;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:12px; color:#c8ccd4;">Per page</span>
          <select id="cm-ov-pagesize" style="padding:6px; border-radius:8px; border:1px solid #444; background:#12151a; color:#abb2bf;">
            <option value="15">15</option>
            <option value="25" selected>25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </div>
      </div>

      <div style="display:flex; flex:1; min-height:0;">
        <div style="width:420px; border-right:1px solid rgba(255,255,255,.08); display:flex; flex-direction:column; min-height:0;">
          <div id="cm-ov-list" style="flex:1; overflow:auto; padding:10px; min-height:0;"></div>
          <div style="padding:10px; border-top:1px solid rgba(255,255,255,.08); display:flex; align-items:center; gap:8px;">
            <button id="cm-ov-prev" style="padding:6px 10px;">Prev</button>
            <button id="cm-ov-next" style="padding:6px 10px;">Next</button>
            <div id="cm-ov-pageinfo" style="margin-left:auto; font-size:12px; color:#c8ccd4;"></div>
          </div>
        </div>

        <div style="flex:1; min-width:0; display:flex; flex-direction:column; min-height:0;">
          <div id="cm-ov-detail" style="flex:1; overflow:auto; padding:12px; min-height:0;"></div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  return { root, overlay };
}

/* =====================================================================================
 * MAIN
 * ===================================================================================== */

async function main() {
  const { root: ui, overlay } = buildUI();

  // Always treat in-memory queue as cache only.
  let queue = await loadQueueSafe();

  const header = qs("#cm-header", ui);
  const body = qs("#cm-body", ui);
  const list = qs("#cm-list", ui);
  const search = qs("#cm-search", ui);
  const logBox = qs("#cm-log", ui);

  const ovClose = qs("#cm-ov-close", overlay);
  const ovSearch = qs("#cm-ov-search", overlay);
  const ovList = qs("#cm-ov-list", overlay);
  const ovDetail = qs("#cm-ov-detail", overlay);
  const ovPrev = qs("#cm-ov-prev", overlay);
  const ovNext = qs("#cm-ov-next", overlay);
  const ovPageInfo = qs("#cm-ov-pageinfo", overlay);
  const ovPageSize = qs("#cm-ov-pagesize", overlay);

  let minimized = false;
  let overlayState = {
    open: false,
    page: 1,
    pageSize: parseInt(ovPageSize.value, 10) || 25,
    selectedKey: null
  };

  const uiLog = [];
  function pushLog(line, isError = false) {
    const ts = new Date().toLocaleTimeString();
    const msg = `[${ts}] ${isError ? "ERROR: " : ""}${line}`;
    uiLog.push(msg);
    while (uiLog.length > 40) uiLog.shift();
    logBox.textContent = uiLog.join("\n");
  }

  // Keep queue in sync when other tabs write.
  function refreshFromStorageSoon() {
    // small debounce
    clearTimeout(refreshFromStorageSoon._t);
    refreshFromStorageSoon._t = setTimeout(async () => {
      queue = await loadQueueSafe();
      renderFloatingList();
      if (overlayState.open) renderOverlay();
    }, 120);
  }

  // GM_addValueChangeListener is not guaranteed in all setups; keep optional.
  try {
    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(STORAGE_KEY, async () => {
        refreshFromStorageSoon();
      });
    }
  } catch {}

  function filterQueueByKw(q, kw) {
    const s = safeLower(kw);
    if (!s) return true;
    return (
      safeLower(q.key).includes(s) ||
      safeLower(q.name).includes(s) ||
      safeLower(q.meta?.ModelTitle).includes(s) ||
      safeLower(q.meta?.pageUrl).includes(s) ||
      safeLower(q.meta?.copiedMessage).includes(s)
    );
  }

  function renderFloatingList() {
    const kw = search.value.toLowerCase();
    list.innerHTML = "";

    const items = queue.filter(q => filterQueueByKw(q, kw));

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:10px; color:#8b93a5; font-size:13px;";
      empty.textContent = "No items.";
      list.appendChild(empty);
      return;
    }

    items.forEach((q) => {
      const d = document.createElement("div");
      d.style.cssText = `
        border-bottom:1px solid #444;
        padding:8px 6px;
        display:flex;
        gap:8px;
        align-items:flex-start;
      `;

      const title = document.createElement("div");
      title.style.cssText = "flex:1; min-width:0;";
      title.innerHTML = `
        <div style="font-weight:600; color:#d6dae3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(q.name)}</div>
        <div style="font-size:12px; color:#9aa3b5;">${escapeHtml(q.key)}</div>
        <div style="font-size:12px; color:#7f889d; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${escapeHtml(q.meta?.ModelTitle || "")}
        </div>
      `;

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex; flex-direction:column; gap:6px;";

      const btnManage = document.createElement("button");
      btnManage.textContent = "View";
      btnManage.style.cssText = "padding:4px 8px; font-size:12px;";
      btnManage.onclick = () => openOverlayWithSelected(q.key);

      const btnDel = document.createElement("button");
      btnDel.textContent = "Delete";
      btnDel.style.cssText = "padding:4px 8px; font-size:12px;";
      btnDel.onclick = async () => { await deleteByKey(q.key); };

      actions.appendChild(btnManage);
      actions.appendChild(btnDel);

      d.appendChild(title);
      d.appendChild(actions);
      list.appendChild(d);
    });
  }

  async function deleteByKey(key) {
    queue = await deleteKeyFromStorage(key);
    pushLog(`Deleted ${key}`);
    renderFloatingList();
    if (overlayState.open) {
      if (overlayState.selectedKey === key) overlayState.selectedKey = null;
      const filtered = currentOverlayFiltered();
      const totalPages = Math.max(1, Math.ceil(filtered.length / overlayState.pageSize));
      overlayState.page = clamp(overlayState.page, 1, totalPages);
      renderOverlay();
    }
  }

  // Drag floating
  (function setupDrag() {
    const rect = ui.getBoundingClientRect();
    ui.style.right = "auto";
    ui.style.left = `${Math.max(10, rect.left)}px`;
    ui.style.top = `${Math.max(10, rect.top)}px`;

    let dragging = false;
    let dx = 0, dy = 0;

    header.addEventListener("mousedown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "BUTTON" || t.closest("button"))) return;

      dragging = true;
      const r = ui.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const w = ui.offsetWidth;
      const h = ui.offsetHeight;
      const maxLeft = window.innerWidth - w - 10;
      const maxTop = window.innerHeight - h - 10;
      const left = clamp(e.clientX - dx, 10, Math.max(10, maxLeft));
      const top = clamp(e.clientY - dy, 10, Math.max(10, maxTop));
      ui.style.left = `${left}px`;
      ui.style.top = `${top}px`;
    });

    window.addEventListener("mouseup", () => { dragging = false; });
  })();

  function setMinimized(v) {
    minimized = !!v;
    body.style.display = minimized ? "none" : "flex";
    ui.style.height = minimized ? "auto" : "900px";
    pushLog(minimized ? "Minimized" : "Restored");
  }
  qs("#cm-min", ui).onclick = () => setMinimized(!minimized);

  function openOverlayWithSelected(key) {
    overlayState.open = true;
    overlay.style.display = "block";
    overlayState.pageSize = parseInt(ovPageSize.value, 10) || overlayState.pageSize;
    overlayState.selectedKey = key || overlayState.selectedKey;
    if (!overlayState.selectedKey && queue.length) overlayState.selectedKey = queue[0].key;

    const filtered = currentOverlayFiltered();
    const idx = filtered.findIndex(x => x.key === overlayState.selectedKey);
    if (idx >= 0) overlayState.page = Math.floor(idx / overlayState.pageSize) + 1;

    renderOverlay();
  }
  qs("#cm-open-overlay", ui).onclick = () => openOverlayWithSelected(overlayState.selectedKey);

  ovClose.onclick = () => {
    overlayState.open = false;
    overlay.style.display = "none";
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlayState.open = false;
      overlay.style.display = "none";
    }
  });

  function currentOverlayFiltered() {
    const kw = safeLower(ovSearch.value);
    return queue.filter(q => filterQueueByKw(q, kw));
  }

  function renderOverlayList(filtered) {
    ovList.innerHTML = "";

    if (filtered.length === 0) {
      ovList.innerHTML = `<div style="padding:10px; color:#8b93a5;">No items.</div>`;
      return;
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / overlayState.pageSize));
    overlayState.page = clamp(overlayState.page, 1, totalPages);

    const start = (overlayState.page - 1) * overlayState.pageSize;
    const end = Math.min(filtered.length, start + overlayState.pageSize);
    const pageItems = filtered.slice(start, end);

    pageItems.forEach((q) => {
      const row = document.createElement("div");
      const selected = (q.key === overlayState.selectedKey);
      row.style.cssText = `
        padding:10px;
        border:1px solid rgba(255,255,255,.08);
        border-radius:10px;
        margin-bottom:8px;
        background:${selected ? "rgba(90,120,200,.18)" : "rgba(255,255,255,.03)"};
        cursor:pointer;
      `;

      row.innerHTML = `
        <div style="display:flex; align-items:flex-start; gap:10px;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:700; color:#d6dae3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(q.name)}</div>
            <div style="font-size:12px; color:#9aa3b5;">${escapeHtml(q.key)}</div>
            <div style="font-size:12px; color:#7f889d; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(q.meta?.ModelTitle || "")}</div>
          </div>
          <button data-del="1" style="padding:6px 10px;">Delete</button>
        </div>
      `;

      row.onclick = (e) => {
        const btn = e.target && e.target.closest && e.target.closest("button");
        if (btn && btn.getAttribute("data-del") === "1") return;
        overlayState.selectedKey = q.key;
        renderOverlay();
      };

      row.querySelector('button[data-del="1"]').onclick = async (e) => {
        e.stopPropagation();
        await deleteByKey(q.key);
      };

      ovList.appendChild(row);
    });

    ovPageInfo.textContent = `Page ${overlayState.page} / ${totalPages}  •  ${filtered.length} items`;
    ovPrev.disabled = (overlayState.page <= 1);
    ovNext.disabled = (overlayState.page >= totalPages);
  }

  function renderOverlayDetail(item) {
    if (!item) {
      ovDetail.innerHTML = `<div style="padding:10px; color:#8b93a5;">Select an item.</div>`;
      return;
    }

    const metaPairs = Array.isArray(item.meta?.metaPairs) ? item.meta.metaPairs : [];
    const links = Array.isArray(item.meta?.downloadlinks) ? item.meta.downloadlinks : [];
    const pageUrl = item.meta?.pageUrl || "";
    const copiedMessage = item.meta?.copiedMessage || null;

    const pairsHtml = metaPairs.length
      ? `<table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr>
              <th style="text-align:left; padding:6px; border-bottom:1px solid rgba(255,255,255,.10); color:#c8ccd4; width:35%;">Key</th>
              <th style="text-align:left; padding:6px; border-bottom:1px solid rgba(255,255,255,.10); color:#c8ccd4;">Value</th>
            </tr>
          </thead>
          <tbody>
            ${metaPairs.map(p => `
              <tr>
                <td style="padding:6px; border-bottom:1px solid rgba(255,255,255,.06); color:#aeb6c7; vertical-align:top;">${escapeHtml(p.key)}</td>
                <td style="padding:6px; border-bottom:1px solid rgba(255,255,255,.06); color:#d6dae3; vertical-align:top;">${escapeHtml(p.value)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>`
      : `<div style="color:#8b93a5; font-size:12px;">No metaPairs.</div>`;

    const linksHtml = links.length
      ? `<div style="display:flex; flex-direction:column; gap:6px;">
          ${links.map(l => `
            <a href="${escapeHtml(l)}" target="_blank" rel="noopener noreferrer"
               style="color:#7fb0ff; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${escapeHtml(l)}
            </a>
          `).join("")}
        </div>`
      : `<div style="color:#8b93a5; font-size:12px;">No download links.</div>`;

    const copiedHtml = copiedMessage
      ? `<textarea readonly style="width:100%; min-height:90px; border-radius:8px; border:1px solid #444; background:#12151a; color:#abb2bf; padding:10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;">${copiedMessage}</textarea>`
      : `<div style="color:#8b93a5; font-size:12px;">(missing / clipboard not accessible)</div>`;

    ovDetail.innerHTML = `
      <div style="display:flex; align-items:flex-start; gap:10px; flex-wrap:wrap;">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:800; color:#d6dae3; font-size:18px; word-break:break-word;">${escapeHtml(item.name)}</div>
          <div style="margin-top:4px; font-size:12px; color:#9aa3b5;">Key: <span style="color:#d6dae3;">${escapeHtml(item.key)}</span></div>
          <div style="font-size:12px; color:#9aa3b5;">ModelId: <span style="color:#d6dae3;">${escapeHtml(String(item.modelId))}</span>  •  VersionId: <span style="color:#d6dae3;">${escapeHtml(String(item.versionId))}</span></div>
          <div style="font-size:12px; color:#9aa3b5;">Updated: <span style="color:#d6dae3;">${escapeHtml(formatTime(item.updatedAt))}</span></div>
          <div style="margin-top:6px; font-size:12px;">
            Page:
            ${pageUrl ? `<a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer" style="color:#7fb0ff; text-decoration:none;">Open</a>` : `<span style="color:#8b93a5;">(none)</span>`}
          </div>
        </div>

        <div style="display:flex; gap:8px;">
          <button id="cm-ov-del" style="padding:8px 12px;">Delete</button>
        </div>
      </div>

      <div style="margin-top:14px;">
        <div style="font-weight:700; color:#c8ccd4; margin-bottom:6px;">Copied Message</div>
        <div style="padding:10px; border:1px solid rgba(255,255,255,.08); border-radius:10px; background:rgba(255,255,255,.03);">
          ${copiedHtml}
        </div>
      </div>

      <div style="margin-top:14px;">
        <div style="font-weight:700; color:#c8ccd4; margin-bottom:6px;">Download Links</div>
        <div style="padding:10px; border:1px solid rgba(255,255,255,.08); border-radius:10px; background:rgba(255,255,255,.03);">
          ${linksHtml}
        </div>
      </div>

      <div style="margin-top:14px;">
        <div style="font-weight:700; color:#c8ccd4; margin-bottom:6px;">Meta</div>
        <div style="padding:10px; border:1px solid rgba(255,255,255,.08); border-radius:10px; background:rgba(255,255,255,.03); overflow:auto;">
          ${pairsHtml}
        </div>
      </div>

      <div style="margin-top:14px;">
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
          <div style="font-weight:700; color:#c8ccd4; flex:1;">HTML</div>
          <button data-tab="preview" class="cm-ov-tabs" style="padding:6px 10px;">Preview</button>
          <button data-tab="raw" class="cm-ov-tabs" style="padding:6px 10px;">Raw</button>
        </div>

        <div id="cm-ov-htmlbox" style="padding:10px; border:1px solid rgba(255,255,255,.08); border-radius:10px; background:rgba(255,255,255,.03);">
          <div id="cm-ov-html-preview" style="display:block;">${item.html || ""}</div>
          <textarea id="cm-ov-html-raw" style="display:none; width:100%; min-height:240px; border-radius:8px; border:1px solid #444; background:#12151a; color:#abb2bf; padding:10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;">${item.html || ""}</textarea>
        </div>
      </div>
    `;

    qs("#cm-ov-del", ovDetail).onclick = async () => { await deleteByKey(item.key); };

    const previewBtn = ovDetail.querySelector(`button.cm-ov-tabs[data-tab="preview"]`);
    const rawBtn = ovDetail.querySelector(`button.cm-ov-tabs[data-tab="raw"]`);
    const prev = qs("#cm-ov-html-preview", ovDetail);
    const raw = qs("#cm-ov-html-raw", ovDetail);

    function setTab(tab) {
      if (tab === "raw") { prev.style.display = "none"; raw.style.display = "block"; }
      else { raw.style.display = "none"; prev.style.display = "block"; }
    }
    previewBtn.onclick = () => setTab("preview");
    rawBtn.onclick = () => setTab("raw");
  }

  function renderOverlay() {
    if (!overlayState.open) return;

    overlayState.pageSize = parseInt(ovPageSize.value, 10) || overlayState.pageSize;

    const filtered = currentOverlayFiltered();
    if (!overlayState.selectedKey && filtered.length) overlayState.selectedKey = filtered[0].key;
    if (overlayState.selectedKey && filtered.length && !filtered.some(x => x.key === overlayState.selectedKey)) {
      overlayState.selectedKey = filtered[0].key;
    }

    renderOverlayList(filtered);
    const item = queue.find(x => x.key === overlayState.selectedKey) || null;
    renderOverlayDetail(item);
  }

  ovSearch.oninput = () => { overlayState.page = 1; renderOverlay(); };
  ovPageSize.onchange = () => { overlayState.pageSize = parseInt(ovPageSize.value, 10) || 25; overlayState.page = 1; renderOverlay(); };
  ovPrev.onclick = () => { overlayState.page = Math.max(1, overlayState.page - 1); renderOverlay(); };
  ovNext.onclick = () => { overlayState.page = overlayState.page + 1; renderOverlay(); };

  // Floating: Add current (FIXED multi-tab: upsertItemToStorage)
  qs("#cm-add", ui).onclick = async () => {
    try {
      const item = await scrapeCurrentPage();
      queue = await upsertItemToStorage(item);
      pushLog(item.meta?.copiedMessage ? `Added/Updated ${item.key} (copiedMessage ok)` : `Added/Updated ${item.key} (copiedMessage missing)`);
      renderFloatingList();
      if (overlayState.open) {
        overlayState.selectedKey = item.key;
        renderOverlay();
      }
    } catch (e) {
      pushLog(String(e?.message || e), true);
      alert(e.message);
    }
  };

  // Export (read latest first to ensure complete)
  qs("#cm-export", ui).onclick = async () => {
    try {
      queue = await loadQueueSafe();
      await exportAll(queue);
      pushLog("Exported JSON + HTML");
      renderFloatingList();
      if (overlayState.open) renderOverlay();
    } catch (e) {
      pushLog(String(e?.message || e), true);
      alert(e.message);
    }
  };

  // Import JSON (FIXED multi-tab: mergeItemsIntoStorage)
  qs("#cm-import-json", ui).onclick = async () => {
    const f = document.createElement("input");
    f.type = "file";
    f.accept = ".json";
    f.onchange = async () => {
      try {
        const text = await f.files[0].text();
        const items = importFromJSON(text);
        queue = await mergeItemsIntoStorage(items);
        pushLog(`Imported JSON: ${items.length} items`);
        renderFloatingList();
        if (overlayState.open) renderOverlay();
      } catch (e) {
        pushLog(String(e?.message || e), true);
        alert(e.message);
      }
    };
    f.click();
  };

  // Import HTML (FIXED multi-tab: mergeItemsIntoStorage)
  qs("#cm-import-html", ui).onclick = async () => {
    const f = document.createElement("input");
    f.type = "file";
    f.accept = ".html";
    f.onchange = async () => {
      try {
        const text = await f.files[0].text();
        const items = importFromHTML(text);
        queue = await mergeItemsIntoStorage(items);
        pushLog(`Imported HTML: ${items.length} items`);
        renderFloatingList();
        if (overlayState.open) renderOverlay();
      } catch (e) {
        pushLog(String(e?.message || e), true);
        alert(e.message);
      }
    };
    f.click();
  };

  qs("#cm-clear-log", ui).onclick = () => { uiLog.length = 0; logBox.textContent = ""; };
  search.oninput = () => renderFloatingList();

  pushLog(`Loaded ${queue.length} items`);
  renderFloatingList();

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayState.open) {
      overlayState.open = false;
      overlay.style.display = "none";
    }
  });
}

window.addEventListener("load", main);

})();
