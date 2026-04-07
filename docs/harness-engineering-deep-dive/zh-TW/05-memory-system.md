# Phase 5 — 原生記憶系統需求文檔

> **狀態**: 設計完成  
> **優先級**: P1 — Wave 3 持久化與治理  
> **前置依賴**: Phase 2（系統提示詞動態邊界）  
> **後置被依賴**: 無（獨立子系統）

---

## 1. 問題陳述

每次會話結束，模型就失去所有知識。下次開啟新會話時：

- 不記得使用者偏好（例如「我喜歡用繁體中文」「我習慣 4 空格縮排」）
- 不記得專案結構（例如「src/core/ 是核心邏輯」「測試在 __tests__/ 目錄」）
- 不記得過去的決策（例如「上次我們決定用 SQLite 而不是 PostgreSQL」）
- 不記得過去的錯誤回饋（例如「上次 Lint 失敗是因為少了分號」）

這意味著模型在每個會話中都是一個「新人」，必須重新學習所有東西。

---

## 2. 四種記憶類型

```typescript
type MemoryType = "user" | "feedback" | "project" | "reference";

interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  tags?: string[];
}
```

### 2.1 使用者記憶（user）

記錄使用者的角色、偏好和工作習慣。

| 範例 | 說明 |
|------|------|
| "使用者偏好繁體中文回應" | 語言偏好 |
| "使用者習慣 2 空格縮排" | 程式碼風格 |
| "使用者不喜歡 emoji" | 輸出格式 |
| "使用者是後端工程師，專注 TypeScript" | 角色背景 |

### 2.2 回饋記憶（feedback）

記錄工作過程中的糾正和確認。每條回饋記憶都包含 **Why**（為什麼）和 **How to apply**（如何應用）結構。

```typescript
interface FeedbackMemory extends MemoryEntry {
  type: "feedback";
  why: string;           // 為什麼這是重要的
  howToApply: string;    // 如何在未來應用
  direction: "correction" | "confirmation"; // 糾正還是確認
}
```

| 範例 | direction | why | howToApply |
|------|-----------|-----|------------|
| "不要用 var，用 const/let" | correction | 使用者的程式碼規範要求避免 var | 所有新程式碼使用 const，可變變數用 let |
| "測試命名很好，繼續保持" | confirmation | 使用者認可 describe/it 命名模式 | 持續使用 describe(元件名)/it(行為描述) 命名 |

**重要**：雙向記錄——糾正和確認都記。確認同樣重要，它告訴模型哪些做法是正確的。

### 2.3 專案記憶（project）

記錄專案的動態知識（不是靜態設定，而是隨時間演變的理解）。

| 範例 | 說明 |
|------|------|
| "此專案使用 Bun 而非 Node.js" | 運行時資訊 |
| "資料庫遷移使用 Drizzle Kit" | 工具鏈 |
| "API 路由在 src/routes/ 下" | 專案結構 |
| "最近從 REST 遷移到 tRPC" | 架構變更 |

### 2.4 參考記憶（reference）

記錄外部資源連結和文檔參考。

| 範例 | 說明 |
|------|------|
| "Vercel AI SDK 文檔: https://sdk.vercel.ai/docs" | API 文檔 |
| "專案 RFC: ./docs/rfc-001-auth.md" | 內部文件 |
| "設計稿: https://figma.com/..." | 設計資源 |

---

## 3. 儲存結構

### 3.1 檔案系統佈局

```
~/.config/aboocode/projects/{cwd-hash}/memory/
├── MEMORY.md          ← 記憶索引（最多 200 行 / 25KB）
├── user/
│   ├── preferences.md
│   └── background.md
├── feedback/
│   ├── code-style.md
│   └── testing.md
├── project/
│   ├── architecture.md
│   └── toolchain.md
└── reference/
    ├── docs.md
    └── rfcs.md
```

### 3.2 MEMORY.md 索引

MEMORY.md 是記憶的入口索引，會在系統提示詞的動態區段中載入。它有嚴格的大小限制：

```typescript
const MEMORY_INDEX_MAX_LINES = 200;
const MEMORY_INDEX_MAX_BYTES = 25 * 1024; // 25KB

function buildMemoryIndex(memories: MemoryEntry[]): string {
  const lines: string[] = ["# 記憶索引", ""];
  
  const grouped = groupBy(memories, "type");
  
  for (const [type, entries] of Object.entries(grouped)) {
    lines.push(`## ${getTypeLabel(type)}`);
    for (const entry of entries) {
      lines.push(`- ${entry.content}`);
      if (entry.type === "feedback") {
        const fb = entry as FeedbackMemory;
        lines.push(`  - 原因: ${fb.why}`);
        lines.push(`  - 應用方式: ${fb.howToApply}`);
      }
    }
    lines.push("");
  }
  
  // 截斷保護
  let result = lines.join("\n");
  if (result.length > MEMORY_INDEX_MAX_BYTES) {
    result = result.slice(0, MEMORY_INDEX_MAX_BYTES) + "\n\n[索引已截斷]";
  }
  
  return result;
}

function getTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    user: "使用者偏好",
    feedback: "工作回饋",
    project: "專案知識",
    reference: "參考資源",
  };
  return labels[type] ?? type;
}
```

---

## 4. 記憶工具 API

### 4.1 MemoryWriteTool

```typescript
const MemoryWriteTool = defineTool({
  name: "memory-write",
  description: "儲存一條記憶，用於跨會話持久化知識",
  parameters: z.object({
    type: z.enum(["user", "feedback", "project", "reference"]),
    content: z.string().describe("記憶內容"),
    tags: z.array(z.string()).optional().describe("標籤"),
    // feedback 類型專屬欄位
    why: z.string().optional().describe("為什麼這是重要的（feedback 類型必填）"),
    howToApply: z.string().optional().describe("如何在未來應用（feedback 類型必填）"),
    direction: z.enum(["correction", "confirmation"]).optional()
      .describe("糾正還是確認（feedback 類型必填）"),
  }),
  
  execute: async (params, ctx) => {
    // 校驗 feedback 必填欄位
    if (params.type === "feedback") {
      if (!params.why || !params.howToApply || !params.direction) {
        throw new Error("feedback 類型需要 why、howToApply 和 direction 欄位");
      }
    }
    
    const entry: MemoryEntry = {
      id: generateId(),
      type: params.type,
      content: params.content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: params.tags,
      ...(params.type === "feedback" ? {
        why: params.why,
        howToApply: params.howToApply,
        direction: params.direction,
      } : {}),
    };
    
    await memoryStore.write(ctx.cwd, entry);
    await memoryStore.rebuildIndex(ctx.cwd);
    
    return `記憶已儲存: [${params.type}] ${params.content}`;
  },
});
```

### 4.2 MemoryReadTool

```typescript
const MemoryReadTool = defineTool({
  name: "memory-read",
  description: "讀取記憶，可按類型或關鍵字篩選",
  parameters: z.object({
    type: z.enum(["user", "feedback", "project", "reference"]).optional(),
    query: z.string().optional().describe("搜尋關鍵字"),
    limit: z.number().optional().default(20),
  }),
  
  execute: async (params, ctx) => {
    let memories = await memoryStore.readAll(ctx.cwd);
    
    if (params.type) {
      memories = memories.filter((m) => m.type === params.type);
    }
    
    if (params.query) {
      const q = params.query.toLowerCase();
      memories = memories.filter((m) =>
        m.content.toLowerCase().includes(q) ||
        m.tags?.some((t) => t.toLowerCase().includes(q))
      );
    }
    
    return memories.slice(0, params.limit);
  },
});
```

---

## 5. 記憶注入流程

記憶透過系統提示詞的動態區段（Phase 2）注入到 LLM 呼叫中：

```typescript
// 在 dynamic-sections.ts 中
{
  id: "memory",
  builder: async (ctx) => {
    const indexContent = await memoryStore.readIndex(ctx.cwd);
    if (!indexContent) return null;
    return `# 記憶\n以下是你對此使用者和專案的記憶：\n\n${indexContent}`;
  },
  priority: 120,
}
```

---

## 6. 記憶生命週期

```
使用者糾正 → 模型呼叫 memory-write → 寫入檔案 → 重建索引
                                                      │
下次會話啟動 → 載入 MEMORY.md → 注入動態提示詞 ←────────┘
                                      │
                              模型帶著記憶工作
```

---

## 驗收標準

- [ ] 支援四種記憶類型：user、feedback、project、reference
- [ ] 記憶儲存在 `~/.config/aboocode/projects/{cwd-hash}/memory/` 目錄
- [ ] MEMORY.md 索引限制在 200 行 / 25KB 以內
- [ ] feedback 類型包含 why、howToApply、direction 欄位
- [ ] feedback 記憶同時記錄糾正和確認
- [ ] MemoryWriteTool 校驗 feedback 類型的必填欄位
- [ ] MemoryReadTool 支援按類型和關鍵字篩選
- [ ] 記憶透過系統提示詞動態區段注入
- [ ] 新會話啟動時自動載入記憶索引
- [ ] 單元測試覆蓋四種類型的寫入和讀取

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/memory/store.ts` | 記憶儲存與索引 |
| `src/core/memory/types.ts` | 型別定義 |
| `src/tools/memory-write.ts` | MemoryWriteTool 實作 |
| `src/tools/memory-read.ts` | MemoryReadTool 實作 |
| `src/core/prompt/dynamic-sections.ts` | 記憶注入區段 |

---

## 產品經理視角總結

記憶系統讓 Aboocode 能夠跨會話積累對使用者、專案和工作方式的理解。

沒有記憶，每次打開 Agent 都是第一天上班的新人。有了記憶，Agent 是一個越來越了解你、了解專案、了解團隊習慣的同事。

四種記憶類型的設計反映了四個不同維度的知識：**你是誰**（user）、**什麼有效什麼無效**（feedback）、**專案怎麼運作**（project）、**去哪裡找答案**（reference）。特別值得注意的是 feedback 記憶的雙向設計——不只記住「做錯了什麼」，也記住「做對了什麼」，這樣模型才能在對的路上繼續走。
