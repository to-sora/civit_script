# Civitai Manager + Downloader (Tampermonkey + Python)

一套兩段式工作流，用於批量收集 Civitai 模型/版本資訊與下載連結，然後在本機按規則落盤下載，同時把下載結果回寫到 JSON 方便追蹤。

- **Tampermonkey 腳本**：在 `https://civitai.com/models/*` 頁面抓取模型描述 HTML、meta table、下載連結、以及（可選）AIR URN `copiedMessage`，並提供管理 UI（新增/刪除/搜尋/分頁/匯入匯出）。
- **Python 腳本**：讀取 Tampermonkey 匯出的 `civitai_export.json`，對每個 item 的 `meta.downloadlinks` 逐一下載，按 AIR 解析結果分資料夾並命名，完成後把下載路徑與大小寫回 JSON。

---

## Repo 結構

```
.
├── tampermonkey_script.js          # Tampermonkey 腳本 - 在 Civitai 頁面收集模型資訊
├── download_civitai_json.py        # Python 下載器 - 根據 JSON 下載檔案
├── Comfyui_link_builder.sh         # ComfyUI 連結生成 - 建立符號連結到模型資料夾
├── demo.json                       # 示例 JSON 檔案 - 展示匯出格式與結構
├── README.md                       # 本文檔
└── LICENSE
```

---

## 需求

### Tampermonkey 腳本
- 瀏覽器：Chrome / Chromium / Firefox
- 擴充套件：Tampermonkey

### Python 下載器
- Python 3.9+（建議 3.10+）
- 套件：`requests`

安裝：
```bash
python3 -m pip install -U requests
````

---

## 1) 安裝 Tampermonkey 腳本

1. 在 Tampermonkey 新增腳本，貼上 `tampermonkey_script.js` 內容並儲存。
2. 打開任意 Civitai 模型頁：`https://civitai.com/models/...`
3. 右上會出現 **Civitai Manager** 浮動面板：

   * **Add Current**：把當前頁面模型/版本加入 queue（同 key 會更新）
   * **Manage**：打開 Overlay 管理器（分頁、詳情、刪除、HTML preview/raw）
   * **Export**：匯出 `civitai_export.json` + `civitai_export.html`
   * **Import JSON / Import HTML**：把之前匯出的檔案合併回 queue（按 key 合併）

### 重要：key 規則

每個條目 key 為：

```
modelId:versionId
```

其中 `versionId` 若 URL 沒有 `modelVersionId` 參數，會用 `"000000"`。

---

## 2) 匯出 JSON

在浮動面板點 **Export**，你會得到：

* `civitai_export.json`（Python 下載器用）
* `civitai_export.html`（方便人類閱讀/備份）

JSON 格式概覽：

```json
{
  "exportedAt": "...",
  "items": [
    {
      "key": "12345:67890",
      "modelId": 12345,
      "versionId": "67890",
      "name": "...",
      "meta": {
        "ModelTitle": "...",
        "downloadlinks": ["https://.../api/download/models/..."],
        "metaPairs": [{"key":"...","value":"..."}],
        "pageUrl": "...",
        "copiedMessage": "urn:air:..."
      },
      "html": "<div>...</div>",
      "updatedAt": "..."
    }
  ]
}
```

---

## 3) 設定 Civitai API Token（Python 下載器需要）

Python 腳本以環境變數讀取 token：

* 變數名：`CIVIT_API`
* 值：你的 Civitai API token（Bearer token）

例子（Linux/macOS）：

```bash
export CIVIT_API="YOUR_TOKEN_HERE"
```

---

## 4) 下載（Python）

基本用法：

```bash
python3 download_civitai_json.py civitai_export.json ./downloads
```

* 第一個參數：匯出的 `civitai_export.json`
* 第二個參數：下載根目錄（會自動建立子資料夾）

### 下載路徑規則

Python 會對每個 item 嘗試解析 `meta.copiedMessage`（AIR URN）。成功時：

* 以 `type` 作為子資料夾：`<root>/<type>/`
* 檔名會加上 `ecosystem_` 前綴：`<ecosystem>_<filename>`

解析失敗或缺失時：

* 會落到：`<root>/default/`
* 檔名不加 ecosystem 前綴

此外：

* 會對 `downloadlinks` 做**列表內去重**（同一個 item 內不重複下載同 URL）
* 若目標檔已存在，會自動改名：`name__2.ext`, `name__3.ext`…

### 下載後 JSON 回寫

下載成功後，腳本會為 item 新增/追加：

```json
"downloads": [
  {
    "url": "...",
    "relative_path": "/abs/path/or/resolved/path",
    "size_bytes": 1234567
  }
]
```

並把更新寫回原本的 `meta_json`（透過 `.tmp` 原子替換）。

---

## 5) ComfyUI 連結生成工具

### 用途

`Comfyui_link_builder.sh` 是一個 bash 腳本，用於快速將多個來源目錄的檔案透過**符號連結（symlink）**整合到單一目錄（通常是 ComfyUI 的模型資料夾）。

### 基本用法

```bash
bash Comfyui_link_builder.sh <TARGET_DIR> <SOURCE1> <SOURCE2> [SOURCE3 ...]
```

**參數說明：**

* `<TARGET_DIR>`：目標資料夾（建立符號連結的目的地）
* `<SOURCE1> ... <SOURCEN>`：一個或多個來源資料夾路徑

**範例：**

```bash
# 將 downloads 資料夾的所有模型連結到 ComfyUI models 資料夾
bash Comfyui_link_builder.sh ~/ComfyUI/models ~/civit_script/downloads

# 從多個來源整合到單一資料夾
bash Comfyui_link_builder.sh ~/ComfyUI/models \
  ~/civit_script/downloads \
  ~/other_models_backup
```

### 選項

**環境變數 `MATCH_GLOB`**：篩選要連結的檔案類型（預設為所有檔案）

```bash
# 只連結 .safetensors 檔案
MATCH_GLOB="*.safetensors" bash Comfyui_link_builder.sh <TARGET_DIR> <SOURCES...>

# 連結多種格式
MATCH_GLOB="*.{safetensors,ckpt,pth}" bash Comfyui_link_builder.sh <TARGET_DIR> <SOURCES...>
```

### 行為說明

* **保留目錄結構**：來源資料夾內的目錄結構會完整複製到目標資料夾
* **符號連結**：建立的是軟連結（symlink），不佔用實際磁碟空間
* **衝突處理**：若多個來源有同名檔案，**後來的來源會覆蓋先前的連結**
* **自動建立目錄**：若目標路徑不存在，腳本會自動建立所需的子目錄

---

## 6) 示例檔案

`demo.json` 是一個示例 JSON 檔案，展示 Tampermonkey 腳本匯出的資料格式與結構。

**用途：**
* 了解 `civitai_export.json` 的預期格式
* 測試 `download_civitai_json.py` 下載器的功能
* 參考 AIR URN 與模型元資料的結構

**快速測試：**

```bash
export CIVIT_API="your_api_token"
python3 download_civitai_json.py demo.json ./test_downloads
```

---

## 注意事項 / 已知行為

* Python 下載器每次實際下載前會 `sleep(5)`，用於降低請求頻率。
* `probe_filename()` 會先嘗試 `HEAD` 拿 `Content-Disposition` / redirect 後 URL；失敗會退回 `GET` stream 讀 headers。
* Tampermonkey 腳本讀取 `copiedMessage` 需要瀏覽器允許 clipboard：它會嘗試點擊頁面 meta table 內的 copy button，再用 `navigator.clipboard.readText()` 讀取。若瀏覽器限制（常見於權限/焦點/手勢不足），`copiedMessage` 可能是 `null`，不影響下載，只影響分流規則。

---

## 快速工作流（建議）

1. 在 Civitai 模型頁逐個點 **Add Current** 收集想要的模型/版本。
2. 點 **Manage** 檢查每個 item 的 download links / copiedMessage 是否存在。
3. 點 **Export** 生成 `civitai_export.json`。
4. 在本機：

   ```bash
   export CIVIT_API="..."
   python3 download_civitai_json.py civitai_export.json ./downloads
   ```
5. 下載完成後，`civitai_export.json` 會包含每個 item 的 `downloads` 記錄，便於後續追蹤與增量補抓。

---
### 關於 Tampermonkey 權限、程式碼注入與下載 API 設定說明

本專案的 Tampermonkey 腳本需要在 Civitai 模型頁面中**動態注入並執行使用者腳本（DOM scraping + UI 注入）**，同時嘗試透過 **clipboard API** 讀取由頁面內建 Copy 按鈕產生的文字（`copiedMessage`），以及存取與管理 **跨分頁共享的 Tampermonkey storage**；因此使用者必須在 Tampermonkey 設定中允許該腳本於 `https://civitai.com/models/*` 執行、啟用 `@grant GM_getValue / GM_setValue / GM_download`，並確保瀏覽器未封鎖 `navigator.clipboard.readText()`（部分瀏覽器需要頁面具備使用者互動或允許剪貼簿權限，否則 `copiedMessage` 可能為空，但不影響下載）。另一方面，實際檔案下載由 **Python 腳本** 透過 Civitai 官方下載 API 進行，必須由使用者自行設定 `CIVIT_API` 環境變數作為 Bearer token；此設計刻意將「頁面抓取／管理」與「受權下載」分離，避免在瀏覽器端直接處理敏感 token，同時與你目前提供的腳本行為與安全邊界保持一致。


