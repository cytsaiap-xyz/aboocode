# Phase 4 — 壓縮後身份重注入需求文檔

> **狀態**: 設計完成  
> **優先級**: P1 — Wave 2 核心能力  
> **前置依賴**: Phase 1（上下文壓縮）  
> **後置被依賴**: 無（獨立子系統）

---

## 1. 問題陳述

當主動壓縮（Phase 1）將對話歷史替換為摘要時，以下隱含資訊可能丟失：

| 丟失的資訊 | 後果 |
|------------|------|
| Agent 角色 | 模型忘記自己是 Aboocode，開始用通用語氣回答 |
| 工作目錄 | 模型不知道目前在哪個專案目錄下工作 |
| Agent 類型 | 子 Agent（如 verify agent）忘記自己是唯讀角色 |
| 會話上下文 | 失去對當前任務的連貫理解 |

**問題根因**：這些資訊通常分散在對話歷史的各處（初始系統提示詞、早期使用者訊息、環境設定等）。壓縮摘要不一定會保留它們，因為摘要器關注的是對話內容，而非元資訊。

---

## 2. 設計方案

### 2.1 IdentityContext 資料結構

```typescript
interface IdentityContext {
  /** Agent 名稱，如 "aboocode" 或 "verify-agent" */
  agent: string;
  
  /** Agent 描述，用於模型理解自身角色 */
  description: string;
  
  /** 當前工作目錄的絕對路徑 */
  cwd: string;
  
  /** 是否為壓縮後注入（影響注入格式） */
  postCompaction: boolean;
  
  /** Agent 類型，影響權限和行為 */
  agentType: "primary" | "subagent" | "background" | "verify";
  
  /** 額外限制條件 */
  constraints?: string[];
}
```

### 2.2 身份建構

```typescript
function buildIdentityContext(session: Session): IdentityContext {
  return {
    agent: session.config.agentName ?? "aboocode",
    description: session.config.agentDescription ??
      "Aboocode 是一個 AI 編程助手，幫助使用者完成軟體開發任務。",
    cwd: session.cwd,
    postCompaction: true,
    agentType: session.agentType ?? "primary",
    constraints: session.config.constraints ?? [],
  };
}
```

---

## 3. 注入格式

### 3.1 XML 區塊格式

身份資訊以 `<identity>` XML 區塊的形式注入，確保模型能明確識別：

```typescript
function formatIdentityBlock(ctx: IdentityContext): string {
  const constraintsBlock = ctx.constraints && ctx.constraints.length > 0
    ? `\n  <constraints>\n${ctx.constraints.map(c => `    - ${c}`).join("\n")}\n  </constraints>`
    : "";

  return `<identity>
  <agent>${ctx.agent}</agent>
  <description>${ctx.description}</description>
  <cwd>${ctx.cwd}</cwd>
  <type>${ctx.agentType}</type>
  <post_compaction>true</post_compaction>${constraintsBlock}
</identity>

上方是你的身份資訊。你剛剛經歷了一次對話壓縮——之前的對話已被摘要。
請根據上述身份繼續工作，保持一致的角色和行為。`;
}
```

### 3.2 不同 Agent 類型的身份範例

**主要 Agent**：
```xml
<identity>
  <agent>aboocode</agent>
  <description>Aboocode 是一個 AI 編程助手，幫助使用者完成軟體開發任務。</description>
  <cwd>/Users/dev/my-project</cwd>
  <type>primary</type>
  <post_compaction>true</post_compaction>
</identity>
```

**驗證 Agent**：
```xml
<identity>
  <agent>verify-agent</agent>
  <description>唯讀驗證 Agent，只能使用讀取和搜尋工具，不能修改任何檔案。</description>
  <cwd>/Users/dev/my-project</cwd>
  <type>verify</type>
  <post_compaction>true</post_compaction>
  <constraints>
    - 不能使用 write、edit、apply_patch 工具
    - 不能執行修改檔案的 bash 命令
    - 只能回報驗證結果
  </constraints>
</identity>
```

---

## 4. 注入時機與位置

### 4.1 注入時機

```typescript
async function proactiveCompact(
  messages: Message[],
  session: Session
): Promise<Message[]> {
  // 步驟 1：儲存 Transcript
  await transcriptStore.save(session.id, messages);
  
  // 步驟 2：LLM 生成摘要
  const summary = await llm.summarize({ messages });
  
  // 步驟 3：建構壓縮後訊息
  const compactedMessages: Message[] = [
    { role: "assistant", content: `[對話摘要]\n${summary}\n[/對話摘要]` },
  ];
  
  // ▶ 步驟 4：注入身份區塊
  const identity = buildIdentityContext(session);
  const identityBlock = formatIdentityBlock(identity);
  compactedMessages.unshift({
    role: "system",
    content: identityBlock,
  });
  
  // 步驟 5：標記身份已注入
  session.identityInjected = true;
  
  return compactedMessages;
}
```

### 4.2 注入位置

身份區塊插入在壓縮後訊息的**最前方**（`unshift`），確保模型在讀取摘要前先確立身份。

```
訊息順序（壓縮後）：
  1. [system] <identity> 區塊    ← 身份重注入
  2. [assistant] [對話摘要]...   ← LLM 生成的摘要
  3. [user] 使用者的下一個訊息   ← 繼續對話
```

### 4.3 一次性注入

```typescript
function shouldInjectIdentity(session: Session): boolean {
  // 只在壓縮後注入一次
  // 成功注入後清除標記，避免重複注入
  if (session.pendingIdentityInjection) {
    session.pendingIdentityInjection = false;
    return true;
  }
  return false;
}
```

---

## 5. 核心設計原則

### 5.1 確定性 vs 生成性

**身份是確定性的（從設定讀取），不是生成性的（依賴 LLM）。**

```typescript
// ✅ 正確：從設定直接讀取
function buildIdentityContext(session: Session): IdentityContext {
  return {
    agent: session.config.agentName,
    cwd: session.cwd,
    // ... 全部來自確定性的設定值
  };
}

// ❌ 錯誤：讓 LLM 生成身份
// const identity = await llm.chat("你是誰？你在做什麼？");
```

**理由**：
- LLM 生成的身份可能不準確（幻覺）
- LLM 生成需要額外的 API 呼叫（成本）
- 確定性讀取是可預測和可測試的

---

## 6. 邊界情況

### 6.1 多次壓縮

如果一個長會話觸發多次壓縮，每次壓縮都會重新注入身份。這是正確的行為——每次壓縮都會丟棄前一次的身份注入。

### 6.2 子 Agent 壓縮

子 Agent 的身份注入使用子 Agent 自己的設定，而非父 Agent 的設定：

```typescript
// 子 Agent 壓縮時
const identity = buildIdentityContext(subAgentSession);
// identity.agent === "verify-agent"
// identity.agentType === "verify"
```

### 6.3 身份衝突

如果系統提示詞的靜態層已經包含角色描述，身份重注入不會與之衝突——它是補充而非覆蓋：

```typescript
// 靜態層：通用角色描述（每次呼叫都有）
// 身份注入：壓縮後的上下文恢復（只在壓縮後出現）
// 兩者互補，不衝突
```

---

## 驗收標準

- [ ] `IdentityContext` 包含 agent、description、cwd、agentType 欄位
- [ ] 身份區塊使用 `<identity>` XML 格式
- [ ] 身份在壓縮後自動注入到訊息最前方
- [ ] 身份資訊從設定確定性讀取，不依賴 LLM 生成
- [ ] 注入後標記清除，避免重複注入
- [ ] 驗證 Agent 的身份包含唯讀限制
- [ ] 多次壓縮場景下每次都正確重注入
- [ ] 子 Agent 使用自己的身份設定
- [ ] 單元測試覆蓋各 Agent 類型的身份格式

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/identity/context.ts` | IdentityContext 定義與建構 |
| `src/core/identity/formatter.ts` | XML 格式化 |
| `src/core/identity/injector.ts` | 注入邏輯 |
| `src/core/compaction/proactive.ts` | 壓縮流程中的注入呼叫點 |

---

## 產品經理視角總結

壓縮不應該讓模型失憶。

想像你在和一位同事進行長時間的結對程式設計。中間你去喝了杯咖啡回來，同事把之前的討論做了個摘要給你。但如果摘要裡沒提到「我們在做什麼專案」「我們的角色分工是什麼」「我們在哪個目錄下工作」——你回來後會完全迷失。

身份重注入就是確保這些基本的「我是誰、我在哪、我在做什麼」資訊在每次壓縮後都能恢復。它很簡單，但缺少它會讓整個壓縮機制變得脆弱不堪。
