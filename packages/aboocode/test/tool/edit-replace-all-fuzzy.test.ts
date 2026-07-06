import { test, expect } from "bun:test"
import { replace } from "../../src/tool/edit"

// replaceAll across whitespace-divergent occurrences (fuzzy) must replace ALL, not just
// the first shape found. `replace` is the exported module-level function (there is no
// `Edit` namespace/object in src/tool/edit.ts), so it is exercised directly here.
//
// The first line has extra internal whitespace ("foo(a,   b)") which only the
// WhitespaceNormalizedReplacer fuzzy-matches; the second line is a byte-identical
// match to oldString, which SimpleReplacer finds first. A buggy implementation that
// returns as soon as the first replacer's match is replaceAll'd will leave the
// whitespace-divergent occurrence on line 1 untouched.
test("replaceAll replaces every fuzzy occurrence, not just the first shape", () => {
  const content = "let x = foo(a,   b)\nlet y = foo(a, b)\n"
  const out = replace(content, "foo(a, b)", "bar()", true)
  expect(out).toBe("let x = bar()\nlet y = bar()\n")
  expect(out).not.toContain("foo(")
})
