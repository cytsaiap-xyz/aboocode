# Phase 3 — 會話全文持久化需求文檔

> **狀態**: 設計完成  
> **優先級**: P0 — Wave 1 基礎層  
> **前置依賴**: Phase 1（上下文壓縮）  
> **後置被依賴**: Phase 13（失敗恢復）

---

## 1. 問題陳述

上下文壓縮（Phase 1）是必要的——沒有壓縮，長對話會崩潰。但壓縮有一個根本代價：**原始對話被丟棄**。

這帶來三個嚴重問題：

| 問題 | 影響 |
|------|------|
| **不可審計** | 無法回溯模型做了什麼決策、為什麼做 |
| **不可恢復** | 如果壓縮摘要品質不佳或遺漏關鍵資訊，無法回退 |
| **不可學習** | 無法從歷史對話中提取模式、改進提示詞 |

**核心原則**：壓縮是上下文管理策略，不是資料刪除策略。原始對話必須完整保存。

---

## 2. JSONL 格式設計

### 2.1 為什麼選擇 JSONL

| 方案 | 優點 | 缺點 |
|------|------|------|
| JSON | 結構完整 | 大檔案需要全部載入才能解析 |
| SQLite | 查詢能力強 | 對逐行追加不友好，二進位格式 |
| **JSONL** | 逐行追加、可串流讀取、可用任何文字工具檢視 | 無內建索引 |
| Protobuf | 高效 | 可讀性差，需要額外工具 |

JSONL 的優勢在於：每一行是一個獨立的 JSON 物件，可以逐行寫入（`append`），也可以逐行讀取（串流），非常適合對話記錄這種按時間順序追加的場景。

### 2.2 檔案路徑

```
~/.local/share/aboocode/transcripts/{sessionID}/{timestamp}.jsonl
```

範例：
```
~/.local/share/aboocode/transcripts/
  sess_abc123/
    2026-04-08T10-30-00.jsonl   ← 第一次壓縮前的完整對話
    2026-04-08T11-15-00.jsonl   ← 第二次壓縮前的完整對話
  sess_def456/
    2026-04-08T14-00-00.jsonl
```

### 2.3 每行格式

```typescript
interface TranscriptEntry {
  timestamp: string;          // ISO 8601
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;          // 如果 role 是 "tool"
  toolCallId?: string;        // 工具呼叫 ID
  tokenCount?: number;        // 此訊息的預估 token 數
  metadata?: Record<string, unknown>; // 擴展欄位
}
```

範例 JSONL 行：
```json
{"timestamp":"2026-04-08T10:30:15Z","role":"user","content":"請幫我重構 src/utils.ts","tokenCount":12}
{"timestamp":"2026-04-08T10:30:18Z","role":"assistant","content":"好的，讓我先閱讀這個檔案。","tokenCount":15}
{"timestamp":"2026-04-08T10:30:18Z","role":"tool","toolName":"read","toolCallId":"call_001","content":"// src/utils.ts\nexport function ...","tokenCount":350}
```

---

## 3. 儲存時機

**關鍵決策**：Transcript 在 Compaction（主動壓縮）的**最開始**保存，在 LLM 摘要生成**之前**。

```typescript
async function proactiveCompact(
  messages: Message[],
  session: Session
): Promise<Message[]> {
  // ▶ 步驟 1：先保存完整對話（在任何壓縮操作之前）
  await transcriptStore.save(session.id, messages);
  
  // 步驟 2：LLM 生成摘要
  const summary = await llm.summarize({ messages });
  
  // 步驟 3：替換訊息
  // ...
}
```

**理由**：如果在摘要之後保存，一旦摘要過程中出錯（LLM 超時、回傳不完整等），原始對話就永久丟失了。

---

## 4. Transcript 命名空間 API

```typescript
interface TranscriptStore {
  /**
   * 儲存完整訊息陣列為 JSONL 檔案
   * @returns 儲存的檔案路徑
   */
  save(sessionId: string, messages: Message[]): Promise<string>;
  
  /**
   * 載入指定 Transcript 檔案
   * @param filePath JSONL 檔案的完整路徑
   * @returns 訊息陣列
   */
  load(filePath: string): Promise<TranscriptEntry[]>;
  
  /**
   * 列出指定會話的所有 Transcript 檔案
   * @returns 按時間排序的檔案路徑清單
   */
  list(sessionId: string): Promise<TranscriptFileInfo[]>;
}

interface TranscriptFileInfo {
  path: string;
  timestamp: string;
  sizeBytes: number;
  entryCount: number;
}
```

### 4.1 save 實作

```typescript
async function save(sessionId: string, messages: Message[]): Promise<string> {
  const dir = path.join(TRANSCRIPT_BASE_DIR, sessionId);
  await fs.mkdir(dir, { recursive: true });
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${timestamp}.jsonl`);
  
  const lines = messages.map((msg) => {
    const entry: TranscriptEntry = {
      timestamp: new Date().toISOString(),
      role: msg.role,
      content: msg.content,
      ...(msg.toolName ? { toolName: msg.toolName } : {}),
      ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
    };
    return JSON.stringify(entry);
  });
  
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
  
  return filePath;
}
```

### 4.2 load 實作

```typescript
async function load(filePath: string): Promise<TranscriptEntry[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  
  return lines
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}
```

### 4.3 list 實作

```typescript
async function list(sessionId: string): Promise<TranscriptFileInfo[]> {
  const dir = path.join(TRANSCRIPT_BASE_DIR, sessionId);
  
  if (!await fs.exists(dir)) return [];
  
  const files = await fs.readdir(dir);
  const results: TranscriptFileInfo[] = [];
  
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    const content = await fs.readFile(filePath, "utf-8");
    const entryCount = content.trim().split("\n").length;
    
    results.push({
      path: filePath,
      timestamp: file.replace(".jsonl", "").replace(/-/g, ":"),
      sizeBytes: stat.size,
      entryCount,
    });
  }
  
  return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
```

---

## 5. 容量估算

| 會話規模 | 估算大小 | 說明 |
|----------|---------|------|
| 50 輪對話 | 100-250 KB | 輕量開發會話 |
| 100 輪對話 | 200-500 KB | 典型重構會話 |
| 200 輪對話 | 400 KB - 1 MB | 長時間工作會話 |
| 每日 10 個會話 | 2-5 MB/天 | 正常使用量 |
| 每月累計 | 60-150 MB/月 | 可接受的磁碟佔用 |

---

## 6. 清理策略

**目前設計**：不做自動清理。理由：

1. 儲存成本極低（每月百 MB 級別）
2. 自動刪除可能造成審計資料丟失
3. 使用者可自行刪除 `~/.local/share/aboocode/transcripts/` 目錄

**未來考慮**：

```typescript
// 未來可選的清理策略
interface RetentionPolicy {
  maxAgeDays?: number;     // 保留天數
  maxSizeBytes?: number;   // 單一會話最大容量
  maxTotalBytes?: number;  // 全域最大容量
}
```

---

## 驗收標準

- [ ] Transcript 在主動壓縮的最開始保存（LLM 摘要之前）
- [ ] JSONL 格式，每行是有效 JSON
- [ ] 檔案路徑格式為 `~/.local/share/aboocode/transcripts/{sessionID}/{timestamp}.jsonl`
- [ ] `save` 方法正確建立目錄結構
- [ ] `load` 方法可還原完整訊息清單
- [ ] `list` 方法回傳按時間排序的檔案清單
- [ ] 支援大型對話（200+ 輪）的儲存和讀取
- [ ] 不做自動清理（使用者可手動刪除）
- [ ] 單元測試覆蓋 save/load/list 操作
- [ ] 效能測試：100 輪對話的 save 操作 < 100ms

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/transcript/store.ts` | Transcript 儲存實作 |
| `src/core/transcript/types.ts` | 型別定義 |
| `src/core/transcript/index.ts` | 模組入口 |
| `src/core/compaction/proactive.ts` | 壓縮中的 save 呼叫點 |

---

## 產品經理視角總結

壓縮是必要的，但丟失原始對話是不可接受的。

這就像資料庫的 WAL（Write-Ahead Log）——你可以做任何最佳化和壓縮，但在此之前，必須先把原始資料安全地寫到磁碟上。這不是功能特性，這是**資料安全的基本保證**。

Transcript 的價值不僅在於恢復——它還是審計、除錯和持續改進的基礎。當你能看到模型在每一步做了什麼決策，你才能理解它為什麼成功或失敗，進而改進整個系統。
