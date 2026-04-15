/**
 * Bundled skills — skills baked into the binary rather than loaded from
 * disk. Ported from claude-code-leak's src/skills/bundledSkills.ts.
 *
 * These provide default implementations of common skills (commit, review,
 * test) so users get useful behavior out of the box without needing to
 * populate ~/.aboocode/skills/ first. User-defined skills in that
 * directory override the bundled ones by name.
 */

import type { Skill as SkillNs } from "./skill"

export type BundledSkill = Pick<SkillNs.Info, "name" | "description" | "content"> & {
  /** Tag for picker UIs. Bundled skills are labeled "bundled". */
  source: "bundled"
}

const COMMIT_SKILL: BundledSkill = {
  name: "commit",
  description: "Create a well-formed git commit. Analyzes staged/unstaged changes, drafts a conventional message, stages relevant files, and runs pre-commit hooks.",
  source: "bundled",
  content: `# commit

Create a git commit from the current working tree changes.

## Workflow

1. Run these commands in parallel:
   - \`git status\` — see untracked/unstaged files
   - \`git diff\` — see staged + unstaged content
   - \`git log --oneline -5\` — match the repo's commit style

2. Analyze changes:
   - Classify as add/update/fix/refactor/test/docs/chore
   - Draft a subject line under 72 characters
   - Body bullets cover the *why*, not the *what* (the diff is the what)

3. Stage files individually by name (never \`git add -A\` — avoids leaking
   secrets or build artifacts). Skip anything that looks like a secret
   (\`.env\`, \`credentials.json\`, private keys).

4. Run \`git commit\` with a HEREDOC-formatted message:
   \`\`\`
   git commit -m "$(cat <<'EOF'
   <subject line>

   <body>
   EOF
   )"
   \`\`\`

5. Verify with \`git status\` afterward.

## Rules

- NEVER skip hooks (\`--no-verify\`).
- NEVER force-push without explicit user confirmation.
- If a pre-commit hook fails, fix the underlying issue — do NOT amend
  or use \`--no-verify\`.
- Prefer new commits over amending previous ones unless the user asks.
`,
}

const REVIEW_SKILL: BundledSkill = {
  name: "review",
  description: "Review uncommitted changes, a commit, or a branch and surface issues, risks, and suggestions.",
  source: "bundled",
  content: `# review

Review code changes for quality, correctness, and risk.

## Scope resolution

- No argument → review uncommitted changes (\`git diff\`)
- \`commit <sha>\` → review that commit (\`git show <sha>\`)
- \`branch <name>\` → review branch vs main (\`git diff main...<name>\`)
- \`pr <n>\` → review PR diff via \`gh pr diff <n>\`

## What to look for

1. **Correctness** — does the code do what it says it does? Any off-by-one,
   null-deref, race condition, or unhandled error?
2. **Edge cases** — what inputs are not covered? What breaks with an empty
   list, a negative number, a concurrent caller?
3. **Security** — path traversal, SQL injection, XSS, unsafe deserialization,
   credentials in source, crypto misuse?
4. **Performance** — N+1 queries, unnecessary copies, blocking I/O on the
   hot path?
5. **Style** — does it match the surrounding code? Is it idiomatic for the
   language/framework?
6. **Tests** — is the change covered? What's not covered?

## Output format

- Start with a one-line verdict: ship / ship-with-fixes / needs-rework / blocked
- Then a bulleted list of issues grouped by severity (blocker / major / minor / nit)
- Each issue cites \`path:line\` and suggests a concrete fix
- End with positive callouts if anything is notably well-done (not obligatory)

Keep it terse — reviewers are busy.
`,
}

const TEST_SKILL: BundledSkill = {
  name: "test",
  description: "Run the project's test suite and diagnose any failures. Detects npm/pnpm/yarn/bun/pytest/go test automatically.",
  source: "bundled",
  content: `# test

Run the project test suite and diagnose failures.

## Detection order

1. \`package.json\` → check for a \`test\` script; use the right package
   manager: bun (\`bun.lock\`), pnpm (\`pnpm-lock.yaml\`), yarn (\`yarn.lock\`),
   otherwise npm.
2. \`pyproject.toml\` or \`pytest.ini\` → run \`pytest\`.
3. \`go.mod\` → run \`go test ./...\`.
4. \`Cargo.toml\` → run \`cargo test\`.
5. Otherwise, ask the user how to run tests and save the answer as a
   feedback memory so you do not have to ask again.

## On failure

- Read the failing test's source to understand what it expected.
- Read the code under test to see what it actually does.
- Diagnose: is it the test that is wrong, or the code? State your judgment.
- Offer a concrete fix. If the fix is small and obvious, apply it and
  re-run. If not, present the fix and wait for approval.

## Rules

- Never mark a task complete while tests are failing.
- Never \`skip\` / \`xit\` / \`@pytest.mark.skip\` a test to make it green.
  Fix the underlying issue.
`,
}

const PLAN_SKILL: BundledSkill = {
  name: "plan",
  description: "Enter plan mode: read-only investigation, produce a concrete file-by-file change plan, wait for approval.",
  source: "bundled",
  content: `# plan

Enter read-only plan mode. You may NOT make code changes until the user
approves your plan.

## Workflow

1. Re-read the user's ask to make sure you understand it.
2. Investigate using Read, Glob, Grep, Task subagent, WebFetch, WebSearch.
   Do NOT use Write, Edit, NotebookEdit, or mutating Bash commands.
3. Build a concrete change plan:
   - **Goal**: one sentence restating the user's ask
   - **Investigation**: the files you read and what they revealed
   - **Proposed changes**: numbered list of concrete edits. For each:
     - File path (and function/section if applicable)
     - What the change is
     - Why (linked back to the goal)
   - **Risks**: what could break; what depends on this; what tests cover it
   - **Verification**: how the user should confirm the change works
   - **Open questions**: anything you need from the user before starting
4. Present the plan and WAIT for explicit approval.
5. On approval, exit plan mode and execute.

Be specific. A plan that says "update the auth middleware" is useless;
a plan that says "edit \`src/auth/middleware.ts:42\` to check the
X-Team-Id header alongside the existing bearer-token check" is useful.
`,
}

export const BUNDLED_SKILLS: readonly BundledSkill[] = [COMMIT_SKILL, REVIEW_SKILL, TEST_SKILL, PLAN_SKILL]

export function getBundledSkill(name: string): BundledSkill | undefined {
  return BUNDLED_SKILLS.find((s) => s.name === name)
}
