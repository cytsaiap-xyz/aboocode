import { test, expect } from "bun:test"

// Parsing contract: an empty line-text field (trailing "|") must NOT be dropped.
function parseLine(line: string) {
  const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
  // FIXED predicate: only require path + line number; empty text is a valid match.
  if (!filePath || !lineNumStr) return null
  return { filePath, lineNum: parseInt(lineNumStr, 10), lineText: lineTextParts.join("|") }
}

test("a grep hit on an empty line is retained", () => {
  expect(parseLine("file.ts|42|")).toEqual({ filePath: "file.ts", lineNum: 42, lineText: "" })
})
