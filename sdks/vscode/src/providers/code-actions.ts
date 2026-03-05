import * as vscode from "vscode"

export class AbooCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    if (range.isEmpty) return []

    const actions: vscode.CodeAction[] = []

    const explain = new vscode.CodeAction("Aboocode: Explain this code", vscode.CodeActionKind.Empty)
    explain.command = {
      command: "aboocode.explainSelection",
      title: "Explain this code",
    }
    actions.push(explain)

    const fix = new vscode.CodeAction("Aboocode: Fix this code", vscode.CodeActionKind.QuickFix)
    fix.command = {
      command: "aboocode.fixSelection",
      title: "Fix this code",
    }
    actions.push(fix)

    const refactor = new vscode.CodeAction("Aboocode: Refactor this code", vscode.CodeActionKind.Refactor)
    refactor.command = {
      command: "aboocode.refactorSelection",
      title: "Refactor this code",
    }
    actions.push(refactor)

    const test = new vscode.CodeAction("Aboocode: Add tests", vscode.CodeActionKind.Empty)
    test.command = {
      command: "aboocode.addTestsForSelection",
      title: "Add tests for this code",
    }
    actions.push(test)

    return actions
  }
}

export function getSelectionContext(): { text: string; fileRef: string } | undefined {
  const editor = vscode.window.activeTextEditor
  if (!editor) return undefined

  const selection = editor.selection
  if (selection.isEmpty) return undefined

  const text = editor.document.getText(selection)
  const relativePath = vscode.workspace.asRelativePath(editor.document.uri)
  const startLine = selection.start.line + 1
  const endLine = selection.end.line + 1
  const lineRef = startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`

  return {
    text,
    fileRef: `@${relativePath}${lineRef}`,
  }
}
