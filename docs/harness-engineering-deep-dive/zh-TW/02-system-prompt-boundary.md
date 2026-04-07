# Phase 2 — 系統提示詞動態邊界需求文檔

> **狀態**: 設計完成  
> **優先級**: P0 — Wave 1 基礎層  
> **前置依賴**: 無  
> **後置被依賴**: Phase 4（身份重注入）、Phase 5（記憶系統）

---

## 1. 問題陳述

系統提示詞（System Prompt）是 LLM 行為的核心控制機制。但在實際的 Agent 系統中，系統提示詞面臨兩個矛盾：

- **穩定性需求**：模型行為指令、安全約束等內容不應每次呼叫都改變
- **動態性需求**：環境資訊、使用者記憶、MCP 工具清單等內容必須即時更新

如果把所有內容混在一起，每次呼叫都傳送完整提示詞，會導致：

1. **快取失效**：任何動態內容的變化都會使整個提示詞的快取失效
2. **Token 浪費**：靜態內容重複傳送，按 token 計費造成浪費
3. **維護困難**：靜態和動態內容耦合，修改一處可能影響另一處

---

## 2. 分層設計

### 2.1 靜態層（全域不變）

靜態層包含整個會話期間不會改變的內容：

```typescript
interface StaticPromptSection {
  id: string;
  content: string;
  priority: number; // 排序優先級
}

const STATIC_SECTIONS: StaticPromptSection[] = [
  {
    id: "model-behavior",
    content: `你是 Aboocode，一個 AI 編程助手。你的目標是幫助使用者完成
              軟體開發任務。你應該準確、簡潔、有幫助。`,
    priority: 0,
  },
  {
    id: "tool-usage-rules",
    content: `工具使用規範：
              - 使用 Read 工具前確認檔案路徑存在
              - 使用 Edit 工具前必須先 Read 該檔案
              - 使用 Bash 工具時避免破壞性操作
              - 優先使用專用工具而非 Bash`,
    priority: 10,
  },
  {
    id: "safety-constraints",
    content: `安全約束：
              - 不要執行 rm -rf / 等破壞性命令
              - 不要修改 .env 或認證檔案除非明確要求
              - 不要推送到遠端倉庫除非明確要求
              - 不要跳過 pre-commit hook`,
    priority: 20,
  },
  {
    id: "output-format",
    content: `輸出格式：
              - 使用繁體中文回應（如果使用者使用中文）
              - 程式碼區塊使用適當的語言標記
              - 檔案路徑使用絕對路徑`,
    priority: 30,
  },
];
```

### 2.2 動態層（會話級變化）

動態層包含每次呼叫可能不同的內容：

```typescript
interface DynamicPromptSection {
  id: string;
  builder: (ctx: SessionContext) => string | null;
  priority: number;
}

const DYNAMIC_SECTIONS: DynamicPromptSection[] = [
  {
    id: "environment",
    builder: (ctx) => `# 環境資訊
      作業系統: ${ctx.os}
      Shell: ${ctx.shell}
      工作目錄: ${ctx.cwd}
      Git 分支: ${ctx.gitBranch ?? "無"}
      日期: ${ctx.currentDate}`,
    priority: 100,
  },
  {
    id: "user-instructions",
    builder: (ctx) => {
      if (!ctx.userInstructions) return null;
      return `# 使用者指令\n${ctx.userInstructions}`;
    },
    priority: 110,
  },
  {
    id: "memory",
    builder: (ctx) => {
      if (!ctx.memories || ctx.memories.length === 0) return null;
      const lines = ctx.memories.map((m) => `- ${m.content}`);
      return `# 記憶\n${lines.join("\n")}`;
    },
    priority: 120,
  },
  {
    id: "mcp-tools",
    builder: (ctx) => {
      if (!ctx.mcpTools || ctx.mcpTools.length === 0) return null;
      const toolList = ctx.mcpTools.map((t) => `- ${t.name}: ${t.description}`);
      return `# MCP 工具\n${toolList.join("\n")}`;
    },
    priority: 130,
  },
  {
    id: "identity",
    builder: (ctx) => {
      if (!ctx.identity) return null;
      return `<identity>
        agent: ${ctx.identity.agent}
        description: ${ctx.identity.description}
        cwd: ${ctx.identity.cwd}
      </identity>`;
    },
    priority: 140,
  },
];
```

---

## 3. SystemSection 資料結構

```typescript
interface SystemSection {
  id: string;
  content: string;
  cacheable: boolean; // 是否可快取
  priority: number;   // 排序用（數字越小越靠前）
}

function buildSystemPrompt(ctx: SessionContext): SystemSection[] {
  const sections: SystemSection[] = [];
  
  // 靜態區段（可快取）
  for (const s of STATIC_SECTIONS) {
    sections.push({
      id: s.id,
      content: s.content,
      cacheable: true,
      priority: s.priority,
    });
  }
  
  // 動態區段（不可快取）
  for (const d of DYNAMIC_SECTIONS) {
    const content = d.builder(ctx);
    if (content === null) continue;
    sections.push({
      id: d.id,
      content,
      cacheable: false,
      priority: d.priority,
    });
  }
  
  // 按優先級排序
  sections.sort((a, b) => a.priority - b.priority);
  
  return sections;
}
```

---

## 4. Provider 感知快取策略

### 4.1 Anthropic Provider

Anthropic API 支援 `cache_control` 標記，可以顯式標記哪些內容應被快取：

```typescript
function formatForAnthropic(sections: SystemSection[]): AnthropicMessage {
  const blocks = sections.map((s) => ({
    type: "text" as const,
    text: s.content,
    ...(s.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  
  return {
    role: "system",
    content: blocks,
  };
}
```

**效果**：靜態區段命中快取後，只需傳送動態區段的 token。假設靜態區段佔 3000 token，每次呼叫節省 3000 輸入 token。

### 4.2 其他 Provider（OpenAI、Ollama 等）

其他 Provider 不支援顯式快取標記，採用降級策略——直接拼接所有區段：

```typescript
function formatForGeneric(sections: SystemSection[]): GenericMessage {
  const fullContent = sections.map((s) => s.content).join("\n\n---\n\n");
  
  return {
    role: "system",
    content: fullContent,
  };
}
```

### 4.3 Provider 路由

```typescript
function formatSystemPrompt(
  sections: SystemSection[],
  provider: Provider
): ProviderMessage {
  switch (provider.type) {
    case "anthropic":
      return formatForAnthropic(sections);
    case "openai":
    case "ollama":
    case "custom":
    default:
      return formatForGeneric(sections);
  }
}
```

---

## 5. 靜態與動態的組裝

```typescript
function staticPrompt(): SystemSection[] {
  return STATIC_SECTIONS.map((s) => ({
    id: s.id,
    content: s.content,
    cacheable: true,
    priority: s.priority,
  }));
}

function dynamicPrompt(ctx: SessionContext): SystemSection[] {
  const sections: SystemSection[] = [];
  for (const d of DYNAMIC_SECTIONS) {
    const content = d.builder(ctx);
    if (content === null) continue;
    sections.push({
      id: d.id,
      content,
      cacheable: false,
      priority: d.priority,
    });
  }
  return sections;
}

// 最終組裝
function assembleSystemPrompt(ctx: SessionContext): SystemSection[] {
  const allSections = [...staticPrompt(), ...dynamicPrompt(ctx)];
  allSections.sort((a, b) => a.priority - b.priority);
  return allSections;
}
```

---

## 6. Token 節省估算

| 場景 | 無分層 | 有分層（Anthropic） | 節省 |
|------|--------|---------------------|------|
| 靜態提示詞 3000 token | 每次 3000 | 首次 3000，後續 ~0 | ~100%（命中後） |
| 動態區段 500 token | 每次 500 | 每次 500 | 0% |
| 100 次呼叫總計 | 350,000 | ~53,000 | 85% |

---

## 驗收標準

- [ ] 系統提示詞分為靜態和動態兩層
- [ ] 靜態層內容在會話期間不改變
- [ ] 動態層支援按需生成（builder 模式）
- [ ] 動態區段回傳 `null` 時自動跳過
- [ ] Anthropic Provider 使用 `cache_control: ephemeral` 標記靜態區段
- [ ] 非 Anthropic Provider 降級為直接拼接
- [ ] 區段按 `priority` 排序
- [ ] 新增區段不需要修改核心邏輯（開放/封閉原則）
- [ ] 單元測試覆蓋 Anthropic 和 Generic 兩種格式化路徑

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/prompt/static-sections.ts` | 靜態區段定義 |
| `src/core/prompt/dynamic-sections.ts` | 動態區段生成器 |
| `src/core/prompt/assembler.ts` | 提示詞組裝器 |
| `src/core/prompt/provider-formatter.ts` | Provider 感知格式化 |
| `src/core/prompt/types.ts` | 型別定義 |

---

## 產品經理視角總結

系統提示詞動態邊界的核心洞察是：**不是所有提示詞內容都同等重要，也不是所有內容都以相同頻率變化**。

透過將提示詞分為**可快取的靜態層**和**按需更新的動態層**，我們實現了兩個目標：

1. **大幅降低 token 消耗**：靜態內容（模型指令、安全約束）在 Anthropic Provider 上可被快取，100 次呼叫節省高達 85% 的系統提示詞 token
2. **維護清晰度**：靜態和動態內容解耦，各自獨立演進

這不是一個花哨的最佳化——當系統每天處理數千次 LLM 呼叫時，系統提示詞的 token 節省直接轉化為可量化的成本降低。
