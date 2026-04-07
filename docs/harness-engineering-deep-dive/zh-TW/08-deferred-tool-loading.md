# Phase 8 — 延遲工具載入需求文檔

> **狀態**: 設計完成  
> **優先級**: P2 — Wave 4 高級 Agent 能力  
> **前置依賴**: 無  
> **後置被依賴**: 無（獨立子系統）

---

## 1. 問題陳述

每個工具的 schema（名稱、描述、參數定義）都會佔用系統提示詞的 token。隨著 MCP 伺服器和插件的增加，工具數量可能達到 50、100 甚至更多。

| 工具數量 | 預估 Schema Token | 佔比（200K 視窗） |
|----------|-------------------|-------------------|
| 15 | ~3,000 | 1.5% |
| 30 | ~6,000 | 3.0% |
| 50 | ~10,000 | 5.0% |
| 100 | ~20,000 | 10.0% |

10% 的上下文視窗被工具定義佔據，意味著更少的空間給對話內容，更早觸發壓縮。

**核心問題**：不是所有工具在每次對話中都會用到。一個程式碼助手會話可能只用到 10 個工具，但系統載入了 60 個。

---

## 2. 延遲載入策略

### 2.1 閾值設定

```typescript
const DEFER_THRESHOLD = 15; // 超過此數量的工具進入延遲模式
```

### 2.2 分類規則

```typescript
interface ToolLoadingPolicy {
  /** 始終載入的內建工具 */
  alwaysLoad: string[];
  
  /** 可延遲的工具（超過閾值時延遲） */
  deferrable: string[];
}

const DEFAULT_POLICY: ToolLoadingPolicy = {
  // 核心內建工具——始終載入
  alwaysLoad: [
    "bash",
    "read",
    "write",
    "edit",
    "grep",
    "glob",
    "apply_patch",
    "task",
    "question",
    "memory-read",
    "memory-write",
    "toolsearch",    // ToolSearch 本身必須始終載入
  ],
  
  // MCP 工具和插件工具——可延遲
  deferrable: [], // 動態填充
};
```

### 2.3 載入決策邏輯

```typescript
function resolveToolLoadingPlan(
  allTools: ToolDefinition[],
  policy: ToolLoadingPolicy
): { immediate: ToolDefinition[]; deferred: ToolDefinition[] } {
  const immediate: ToolDefinition[] = [];
  const deferred: ToolDefinition[] = [];
  
  for (const tool of allTools) {
    if (policy.alwaysLoad.includes(tool.name)) {
      immediate.push(tool);
    } else {
      deferred.push(tool);
    }
  }
  
  // 如果總工具數未超過閾值，全部立即載入
  if (allTools.length <= DEFER_THRESHOLD) {
    return { immediate: allTools, deferred: [] };
  }
  
  return { immediate, deferred };
}
```

---

## 3. ToolSearch 工具

ToolSearch 是延遲工具的「閘道」——模型透過它來發現和啟動延遲工具。

### 3.1 搜尋語法

```typescript
const ToolSearchTool = defineTool({
  name: "toolsearch",
  description: "搜尋並啟動延遲載入的工具。支援三種語法：" +
    "select:工具名 精確選取、關鍵字搜尋、+前綴強制名稱匹配",
  parameters: z.object({
    query: z.string().describe("搜尋查詢"),
    max_results: z.number().optional().default(5),
  }),
  
  execute: async (params, ctx) => {
    const { query, max_results } = params;
    const deferredTools = ctx.getDeferredTools();
    
    let results: ScoredTool[];
    
    if (query.startsWith("select:")) {
      // 精確選取語法：select:toolName1,toolName2
      results = selectByName(query, deferredTools);
    } else if (query.startsWith("+")) {
      // 前綴語法：+slack send → 名稱必須包含 "slack"，排序依據 "send"
      results = prefixSearch(query, deferredTools);
    } else {
      // 關鍵字搜尋
      results = keywordSearch(query, deferredTools, max_results);
    }
    
    // 啟動匹配的工具
    for (const tool of results) {
      ctx.activateTool(tool.definition);
    }
    
    return formatSearchResults(results);
  },
});
```

### 3.2 精確選取

```typescript
function selectByName(
  query: string,
  tools: ToolDefinition[]
): ScoredTool[] {
  // select:Read,Edit,Grep
  const names = query.replace("select:", "").split(",").map(s => s.trim());
  
  return tools
    .filter((t) => names.some(
      (n) => t.name.toLowerCase() === n.toLowerCase()
    ))
    .map((t) => ({ definition: t, score: 10 }));
}
```

### 3.3 前綴語法

```typescript
function prefixSearch(
  query: string,
  tools: ToolDefinition[]
): ScoredTool[] {
  // +slack send → 名稱必須包含 "slack"
  const parts = query.slice(1).trim().split(/\s+/);
  const prefix = parts[0].toLowerCase();
  const keywords = parts.slice(1).map(k => k.toLowerCase());
  
  return tools
    .filter((t) => t.name.toLowerCase().includes(prefix))
    .map((t) => ({
      definition: t,
      score: scoreByKeywords(t, keywords),
    }))
    .sort((a, b) => b.score - a.score);
}
```

### 3.4 關鍵字搜尋與評分

```typescript
function keywordSearch(
  query: string,
  tools: ToolDefinition[],
  maxResults: number
): ScoredTool[] {
  const keywords = query.toLowerCase().split(/\s+/);
  
  return tools
    .map((t) => ({
      definition: t,
      score: scoreTool(t, keywords),
    }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function scoreTool(tool: ToolDefinition, keywords: string[]): number {
  let score = 0;
  
  for (const kw of keywords) {
    // 名稱匹配 +3 分
    if (tool.name.toLowerCase().includes(kw)) {
      score += 3;
    }
    
    // 描述匹配 +1 分
    if (tool.description.toLowerCase().includes(kw)) {
      score += 1;
    }
    
    // 參數名匹配 +1 分
    for (const param of Object.keys(tool.parameters ?? {})) {
      if (param.toLowerCase().includes(kw)) {
        score += 1;
        break;
      }
    }
  }
  
  return score;
}

interface ScoredTool {
  definition: ToolDefinition;
  score: number;
}
```

---

## 4. 會話級快取

一旦工具被 ToolSearch 啟動，它在整個會話期間都可用。不需要每次使用都重新搜尋。

```typescript
class DeferredToolCache {
  private activated: Map<string, ToolDefinition> = new Map();
  
  activate(tool: ToolDefinition): void {
    this.activated.set(tool.name, tool);
  }
  
  isActivated(toolName: string): boolean {
    return this.activated.has(toolName);
  }
  
  getActivated(): ToolDefinition[] {
    return Array.from(this.activated.values());
  }
  
  /** 取得目前可用的所有工具（立即 + 已啟動） */
  getAllAvailable(immediateTools: ToolDefinition[]): ToolDefinition[] {
    return [...immediateTools, ...this.getActivated()];
  }
}
```

---

## 5. Token 節省估算

| 場景 | 無延遲載入 | 有延遲載入 | 節省 |
|------|-----------|-----------|------|
| 15 內建 + 30 MCP 工具 | ~9,000 token | ~3,000 token | 67% |
| 15 內建 + 50 MCP 工具 | ~13,000 token | ~3,000 token | 77% |
| 15 內建 + 100 MCP 工具 | ~23,000 token | ~3,000 token | 87% |

---

## 6. 模型感知

模型需要知道有延遲工具可用。這透過系統提示詞的一段說明實現：

```typescript
function buildDeferredToolNotice(deferredCount: number): string {
  if (deferredCount === 0) return "";
  
  return `\n注意：目前有 ${deferredCount} 個額外工具可用但尚未載入。` +
    `如果你需要使用內建工具以外的功能（如 MCP 工具、插件工具），` +
    `請使用 ToolSearch 工具來搜尋和啟動它們。\n` +
    `搜尋語法：\n` +
    `- "select:工具名" — 精確選取\n` +
    `- "關鍵字" — 模糊搜尋\n` +
    `- "+前綴 關鍵字" — 名稱前綴 + 關鍵字排序\n`;
}
```

---

## 驗收標準

- [ ] 工具數量超過 `DEFER_THRESHOLD`（15）時自動啟用延遲載入
- [ ] 內建工具始終載入，不受延遲影響
- [ ] ToolSearch 支援三種語法：select:、關鍵字、+前綴
- [ ] 評分機制：名稱匹配 +3 分、描述匹配 +1 分
- [ ] 啟動的工具在整個會話期間可用（會話級快取）
- [ ] 模型透過系統提示詞知曉延遲工具的存在
- [ ] Token 節省可量測，30 個 MCP 工具場景下節省 67%+
- [ ] ToolSearch 回傳格式清晰，包含工具名稱和描述
- [ ] 單元測試覆蓋三種搜尋語法和評分邏輯

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/tools/deferred-loader.ts` | 延遲載入策略 |
| `src/tools/toolsearch.ts` | ToolSearch 工具實作 |
| `src/core/tools/deferred-cache.ts` | 會話級快取 |
| `src/core/tools/scoring.ts` | 搜尋評分邏輯 |

---

## 產品經理視角總結

工具數量的增長不應成為系統的負擔。

延遲工具載入就像手機的 App 列表——你不需要把所有 App 同時打開，只需要能快速找到並打開想用的那個。ToolSearch 就是那個「搜尋列」。

關鍵的洞察是：**大多數會話只用到少數幾個工具**。10 個內建工具能覆蓋 80% 的使用場景，而 100 個 MCP 工具可能整個會話都不用一個。為什麼要讓它們佔據寶貴的上下文空間？

延遲載入的代價是模型需要額外一步（呼叫 ToolSearch）才能使用非內建工具，但這個代價微乎其微——一次 ToolSearch 呼叫大約 200 token，遠小於 50 個工具 schema 的 10,000 token。
