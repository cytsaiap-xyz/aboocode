# Phase 12 — 工作區隔離模式需求文檔

> **狀態**: 設計完成  
> **優先級**: P2 — Wave 4 高級 Agent 能力  
> **前置依賴**: Phase 6（流式執行器）  
> **後置被依賴**: Phase 9（後台 Agent）、Phase 11（驗證 Agent）

---

## 1. 問題陳述

在多 Agent 場景中，所有 Agent 共享同一個工作目錄會導致：

- **檔案衝突**：主 Agent 正在編輯 `src/utils.ts`，後台 Agent 也在讀取同一檔案
- **狀態污染**：驗證 Agent 執行的測試修改了資料庫狀態
- **權限洩漏**：應該唯讀的 Agent 意外修改了檔案
- **無法回退**：後台任務修改了檔案但結果不理想，無法輕鬆撤銷

**核心原則**：權限最小化應該成為架構保證，而非口頭約定。

---

## 2. 五級隔離模式

```typescript
type WorkspaceMode = "shared" | "readonly" | "temp" | "worktree" | "sandbox";

interface WorkspaceConfig {
  mode: WorkspaceMode;
  basePath: string;       // 原始工作目錄
  effectivePath: string;  // 實際使用的工作目錄
  cleanup: CleanupPolicy;
}
```

### 2.1 各模式一覽

| 模式 | 路徑 | 可寫 | 用途 | 隔離級別 |
|------|------|------|------|----------|
| shared | 原始 cwd | 是 | 建構、Lint、主 Agent | 無 |
| readonly | 原始 cwd | 否 | 探索、驗證 | 邏輯隔離 |
| temp | /tmp/aboo-{id}/ | 是 | 驗證腳本、臨時程式碼 | 檔案系統隔離 |
| worktree | {cwd}/.worktrees/{id}/ | 是 | 後台任務、並行修改 | Git 隔離 |
| sandbox | 容器/VM | 是 | 不受信任的插件（未來） | 完全隔離 |

---

## 3. shared 模式

最基礎的模式，直接使用原始工作目錄。

```typescript
function createSharedWorkspace(basePath: string): WorkspaceConfig {
  return {
    mode: "shared",
    basePath,
    effectivePath: basePath,
    cleanup: { policy: "none" },
  };
}
```

**適用場景**：主 Agent 的日常操作、建構命令、Lint 檢查。

**風險**：無隔離，所有操作直接影響工作目錄。

---

## 4. readonly 模式

### 4.1 設計

readonly 模式使用原始工作目錄路徑，但在工具層攔截所有寫入操作。

```typescript
class ReadOnlyWorkspaceError extends Error {
  constructor(operation: string, path: string) {
    super(
      `唯讀工作區不允許 ${operation} 操作: ${path}。` +
      `此 Agent 在 readonly 模式下運行，只能讀取檔案和執行唯讀命令。`
    );
    this.name = "ReadOnlyWorkspaceError";
  }
}
```

### 4.2 攔截機制

```typescript
const readonlyGuard: CustomValidator = {
  id: "readonly-workspace-guard",
  toolNames: ["write", "edit", "apply_patch", "bash"],
  validate: async (input, ctx) => {
    if (ctx.workspaceMode !== "readonly") return { valid: true };
    
    const toolName = ctx.currentTool;
    
    // write/edit/apply_patch 直接拒絕
    if (["write", "edit", "apply_patch"].includes(toolName)) {
      return {
        valid: false,
        reason: new ReadOnlyWorkspaceError(toolName, String(input.file_path ?? input.path)).message,
      };
    }
    
    // bash 需要檢查命令內容
    if (toolName === "bash") {
      const cmd = input.command as string;
      if (isMutatingCommand(cmd)) {
        return {
          valid: false,
          reason: new ReadOnlyWorkspaceError("bash", cmd).message,
        };
      }
    }
    
    return { valid: true };
  },
};

function isMutatingCommand(cmd: string): boolean {
  const mutatingPatterns = [
    /\b(rm|mv|cp|mkdir|touch|chmod|chown|ln)\b/,
    /\b(git\s+(add|commit|push|merge|rebase|reset|checkout|stash))\b/,
    /\b(npm|bun|yarn|pnpm)\s+(install|uninstall|publish)\b/,
    /\b(sed|awk)\s+-i\b/,  // 就地編輯
    />/,                     // 重導向寫入
    /\btee\b/,              // tee 命令
  ];
  
  return mutatingPatterns.some((p) => p.test(cmd));
}
```

**適用場景**：驗證 Agent（Phase 11）、探索任務。

---

## 5. temp 模式

### 5.1 設計

建立一個臨時目錄，用於不需要存取主工作區的操作。

```typescript
async function createTempWorkspace(): Promise<WorkspaceConfig> {
  const id = generateId();
  const tempPath = `/tmp/aboo-${id}`;
  await fs.mkdir(tempPath, { recursive: true });
  
  return {
    mode: "temp",
    basePath: tempPath,
    effectivePath: tempPath,
    cleanup: { policy: "on_complete" },
  };
}
```

**適用場景**：驗證腳本、臨時程式碼生成、安全沙箱測試。

---

## 6. worktree 模式

### 6.1 設計

使用 Git Worktree 建立一個獨立的工作副本。這是最強大的隔離模式（除了 sandbox），因為它提供了完整的檔案系統副本，同時共享 Git 歷史。

```typescript
async function createWorktreeWorkspace(
  basePath: string,
  branch?: string
): Promise<WorkspaceConfig> {
  const id = generateId();
  const worktreePath = `${basePath}/.worktrees/${id}`;
  
  // 建立 Git Worktree
  const branchName = branch ?? `aboo-worktree-${id}`;
  await exec(`git worktree add -b ${branchName} ${worktreePath} HEAD`, {
    cwd: basePath,
  });
  
  return {
    mode: "worktree",
    basePath,
    effectivePath: worktreePath,
    cleanup: { policy: "on_complete_if_clean" },
  };
}
```

### 6.2 保留策略

```typescript
async function cleanupWorktree(config: WorkspaceConfig): Promise<void> {
  if (config.mode !== "worktree") return;
  
  // 檢查是否有未提交的修改
  const status = await exec("git status --porcelain", {
    cwd: config.effectivePath,
  });
  
  if (status.trim().length > 0) {
    // 有修改 → 保留 worktree，通知使用者
    console.log(
      `[工作區] worktree ${config.effectivePath} 有未提交的修改，已保留。`
    );
    return;
  }
  
  // 無修改 → 清理
  await exec(`git worktree remove ${config.effectivePath}`, {
    cwd: config.basePath,
  });
}
```

**適用場景**：後台修改任務、並行開發分支、實驗性修改。

---

## 7. sandbox 模式（未來規劃）

```typescript
// 未來實作：容器級隔離
interface SandboxConfig extends WorkspaceConfig {
  mode: "sandbox";
  containerImage?: string;
  networkAccess: boolean;
  mountPoints: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>;
}
```

**適用場景**：不受信任的插件、第三方 MCP 工具。

---

## 8. 清理策略表

```typescript
type CleanupPolicy =
  | { policy: "none" }                    // shared: 不清理
  | { policy: "on_complete" }             // temp: 完成後刪除
  | { policy: "on_complete_if_clean" }    // worktree: 無修改時刪除
  | { policy: "manual" }                  // sandbox: 手動清理
  ;
```

| 模式 | 清理策略 | 觸發時機 | 說明 |
|------|----------|----------|------|
| shared | none | — | 不清理，是主工作區 |
| readonly | none | — | 不清理，使用原始路徑 |
| temp | on_complete | 任務結束 | 自動刪除臨時目錄 |
| worktree | on_complete_if_clean | 任務結束 | 有修改則保留，無修改則刪除 |
| sandbox | manual | 使用者決定 | 容器級清理 |

---

## 9. 工作區工廠

```typescript
class WorkspaceFactory {
  static async create(
    mode: WorkspaceMode,
    basePath: string,
    options?: WorkspaceOptions
  ): Promise<WorkspaceConfig> {
    switch (mode) {
      case "shared":
        return createSharedWorkspace(basePath);
        
      case "readonly":
        return {
          mode: "readonly",
          basePath,
          effectivePath: basePath,
          cleanup: { policy: "none" },
        };
        
      case "temp":
        return createTempWorkspace();
        
      case "worktree":
        return createWorktreeWorkspace(basePath, options?.branch);
        
      case "sandbox":
        throw new Error("sandbox 模式尚未實作");
        
      default:
        throw new Error(`未知的工作區模式: ${mode}`);
    }
  }
  
  static async cleanup(config: WorkspaceConfig): Promise<void> {
    switch (config.cleanup.policy) {
      case "none":
        return;
        
      case "on_complete":
        await fs.rm(config.effectivePath, { recursive: true, force: true });
        return;
        
      case "on_complete_if_clean":
        await cleanupWorktree(config);
        return;
        
      case "manual":
        console.log(`[工作區] ${config.effectivePath} 需要手動清理`);
        return;
    }
  }
}
```

---

## 驗收標準

- [ ] 支援五種工作區模式：shared、readonly、temp、worktree、sandbox（未來）
- [ ] readonly 模式攔截所有寫入工具（write、edit、apply_patch）
- [ ] readonly 模式攔截 bash 中的修改命令
- [ ] `ReadOnlyWorkspaceError` 提供清晰的錯誤訊息
- [ ] temp 模式建立獨立的臨時目錄
- [ ] temp 模式在任務結束後自動清理
- [ ] worktree 模式使用 `git worktree add` 建立
- [ ] worktree 有修改時保留，無修改時自動清理
- [ ] WorkspaceFactory 統一建立和清理介面
- [ ] 單元測試覆蓋各模式的建立和清理

---

## 參考原始碼

| 檔案 | 說明 |
|------|------|
| `src/core/workspace/factory.ts` | WorkspaceFactory 工廠 |
| `src/core/workspace/readonly.ts` | 唯讀模式守衛 |
| `src/core/workspace/worktree.ts` | Git Worktree 管理 |
| `src/core/workspace/temp.ts` | 臨時工作區 |
| `src/core/workspace/types.ts` | 型別定義 |

---

## 產品經理視角總結

工作區隔離讓權限最小化成為架構保證，而非口頭約定。

在安全領域有一個原則叫「最小權限原則」（Principle of Least Privilege）：每個元件只應該擁有完成其任務所需的最小權限。工作區隔離把這個原則從理論變成了實作：

- 驗證 Agent **不能**修改檔案（readonly），不是因為我們告訴它不要，而是因為架構不允許
- 後台任務在 worktree 中工作，即使出錯也不會污染主工作區
- 臨時工具程式碼在 temp 目錄中運行，結束後自動清理

五級隔離的設計也考慮了實用性：不是所有場景都需要最強的隔離。shared 模式零成本，適合大多數操作；worktree 成本適中，適合並行任務；sandbox 成本最高，留給不受信任的場景。**正確的安全設計不是最大化安全，而是匹配風險等級**。
