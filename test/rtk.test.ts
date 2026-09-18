import { test, expect } from "bun:test";
import { compressMessages, formatRtkLog } from "../src/rtk";
import { detectFilter } from "../src/rtk/detect";
import {
  buildOutput,
  dedupLog,
  find,
  gitDiff,
  gitLog,
  gitStatus,
  grep,
  ls,
  readNumbered,
  searchList,
  smartTruncate,
  tree,
} from "../src/rtk/filters";
import { MIN_COMPRESS_SIZE } from "../src/rtk/constants";
import type { CanonicalMessage } from "../src/providers/types";

// Filters only run above MIN_COMPRESS_SIZE, so fixtures have to be realistic
// in size as well as shape.
function pad(text: string, filler: string): string {
  let out = text;
  while (out.length < MIN_COMPRESS_SIZE + 200) out += filler;
  return out;
}

function toolMsg(text: string): CanonicalMessage {
  return { role: "tool", parts: [{ type: "text", text }], toolCallId: "c1" };
}

// ── Detection ────────────────────────────────────────────────────

test("git diff output is detected", () => {
  const text = pad("diff --git a/x.ts b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n", "+more line\n");
  expect(detectFilter(text)?.name).toBe("git-diff");
});

test("a bare hunk header is enough to detect a diff", () => {
  expect(detectFilter(pad("@@ -1,4 +1,6 @@\n-a\n+b\n", "+c\n"))?.name).toBe("git-diff");
});

test("git log output is detected", () => {
  const text = pad(
    "commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\nAuthor: A <a@b.c>\nDate: today\n\n    subject\n",
    "    body line\n"
  );
  expect(detectFilter(text)?.name).toBe("git-log");
});

test("long-form git status is detected", () => {
  const text = pad("On branch main\nChanges not staged for commit:\n\tmodified:   a.ts\n", "\tmodified:   b.ts\n");
  expect(detectFilter(text)?.name).toBe("git-status");
});

test("porcelain status is detected by marker density", () => {
  const text = pad(" M src/a.ts\n?? src/b.ts\nA  src/c.ts\n", " M src/x.ts\n");
  expect(detectFilter(text)?.name).toBe("git-status");
});

// Ordering guard: cargo's "Compiling" lines look like porcelain markers, so
// build detection has to win.
test("cargo output is build-output, not misread as git status", () => {
  const text = pad("   Compiling serde v1.0.1\n   Compiling foo v0.1.0\n", "   Compiling bar v0.1.0\n");
  expect(detectFilter(text)?.name).toBe("build-output");
});

test("grep output is detected", () => {
  const text = pad("src/a.ts:12:  const x = 1\nsrc/b.ts:4:  const y = 2\n", "src/c.ts:9:  hit\n");
  expect(detectFilter(text)?.name).toBe("grep");
});

test("a plain path listing is detected as find", () => {
  const text = pad("./src/a.ts\n./src/b.ts\n./src/c.ts\n", "./src/more.ts\n");
  expect(detectFilter(text)?.name).toBe("find");
});

test("tree glyphs are detected", () => {
  const text = pad("src\n├── a.ts\n└── b.ts\n", "│  nested.ts\n");
  expect(detectFilter(text)?.name).toBe("tree");
});

test("ls -la output is detected", () => {
  const text = pad(
    "total 48\ndrwxr-xr-x  5 me staff   160 Sep 15 14:11 src\n-rw-r--r--  1 me staff  1024 Sep 15 14:11 a.ts\n",
    "-rw-r--r--  1 me staff   512 Sep 15 14:11 b.ts\n"
  );
  expect(detectFilter(text)?.name).toBe("ls");
});

test("the Cursor search-list header is detected", () => {
  const text = pad("Result of search in 'src' (total 3 files):\n- src/a.ts\n- src/b.ts\n", "- src/c.ts\n");
  expect(detectFilter(text)?.name).toBe("search-list");
});

test("generic multi-line noise falls back to dedup-log", () => {
  expect(detectFilter(pad("alpha\nbeta\ngamma\ndelta\nepsilon\n", "zeta\n"))?.name).toBe("dedup-log");
});

test("text below the minimum line count matches no filter", () => {
  expect(detectFilter("just one line")).toBeNull();
});

// 9Router gated these on the 1KB head's line count, which needed ~4-char
// lines; both filters were unreachable in practice.
test("a long line-numbered dump reaches read-numbered", () => {
  const text = Array.from({ length: 300 }, (_, i) => `${i + 1}| const value = ${i};`).join("\n");
  expect(detectFilter(text)?.name).toBe("read-numbered");
});

test("a long unstructured blob reaches smart-truncate", () => {
  // Blank-heavy, so the head holds fewer than five non-empty lines and the
  // dedup-log fallback doesn't claim it first.
  const text = "opening line\n" + "\n".repeat(400) + "closing line";
  expect(detectFilter(text)?.name).toBe("smart-truncate");
});

// ── Filters ──────────────────────────────────────────────────────

test("git-diff keeps changed lines and tallies them per file", () => {
  const out = gitDiff.apply(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-removed",
      "+added",
      "+added two",
    ].join("\n")
  );
  expect(out).toContain("src/a.ts");
  expect(out).toContain("+added");
  expect(out).toContain("-removed");
  expect(out).toContain("+2 -1");
  // The index/---/+++ preamble is noise once the path is known.
  expect(out).not.toContain("index 111");
  expect(out).not.toContain("--- a/src/a.ts");
});

test("git-diff caps a huge hunk and says how much it dropped", () => {
  const body = Array.from({ length: 300 }, (_, i) => `+line ${i}`).join("\n");
  const out = gitDiff.apply(`diff --git a/x b/x\n@@ -1,300 +1,300 @@\n${body}`);
  expect(out).toContain("truncated");
  expect(out.split("\n").length).toBeLessThan(300);
});

test("git-status buckets files and counts them", () => {
  const out = gitStatus.apply(
    ["## main...origin/main", "M  staged.ts", " M modified.ts", "?? untracked.ts", "UU conflict.ts"].join("\n")
  );
  expect(out).toContain("* main");
  expect(out).toContain("+ Staged: 1 files");
  expect(out).toContain("~ Modified: 1 files");
  expect(out).toContain("? Untracked: 1 files");
  expect(out).toContain("! Conflicts: 1 files");
});

test("git-status reads the long form too", () => {
  const out = gitStatus.apply(
    ["On branch feature", "Changes to be committed:", "\tnew file:   a.ts", "\tmodified:   b.ts"].join("\n")
  );
  expect(out).toContain("* feature");
  expect(out).toContain("+ Staged: 1 files");
  expect(out).toContain("~ Modified: 1 files");
});

// 9Router dropped these, undercounting a fresh repo.
test("git-status counts unmarked paths under an untracked header", () => {
  const out = gitStatus.apply(["On branch main", "Untracked files:", "  (use git add)", "\ta.ts", "\tb.ts"].join("\n"));
  expect(out).toContain("? Untracked: 2 files");
});

test("git-status caps the file list", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ` M file${i}.ts`).join("\n");
  const out = gitStatus.apply(`## main\n${rows}`);
  expect(out).toContain("~ Modified: 25 files");
  expect(out).toContain("+15 more");
});

test("git-log keeps headers and subjects but drops bodies and diffs", () => {
  const out = gitLog.apply(
    [
      "commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "Author: Me <me@x.com>",
      "Date:   Mon Sep 15",
      "",
      "    Fix the thing",
      "",
      "    Long explanation nobody needs here.",
      "diff --git a/x b/x",
      "+noise",
    ].join("\n")
  );
  expect(out).toContain("commit a1b2c3d");
  expect(out).toContain("Author:");
  expect(out).toContain("Subject: Fix the thing");
  expect(out).toContain("diff body omitted");
  expect(out).not.toContain("Long explanation");
  expect(out).not.toContain("+noise");
});

test("build-output keeps every error but counts progress lines", () => {
  const out = buildOutput.apply(
    [
      "   Compiling serde v1.0",
      "   Compiling tokio v1.0",
      "   Compiling foo v0.1",
      "error[E0425]: cannot find value `x`",
      " --> src/main.rs:4:5",
      "  |",
      "4 |     x + 1",
      "  |     ^ not found",
      "warning: unused import",
      "BUILD FAILED",
    ].join("\n")
  );
  expect(out).toContain("Compiled 3 packages");
  expect(out).toContain("error[E0425]");
  // The whole cargo error block, not just its first line.
  expect(out).toContain("--> src/main.rs:4:5");
  expect(out).toContain("not found");
  expect(out).toContain("BUILD FAILED");
});

test("build-output caps warnings and deprecations", () => {
  const input = [
    ...Array.from({ length: 10 }, (_, i) => `npm warn deprecated pkg${i}@1.0.0: old`),
    ...Array.from({ length: 10 }, (_, i) => `npm warn something else ${i}`),
    "added 120 packages",
  ].join("\n");
  const out = buildOutput.apply(input);
  expect(out).toContain("more deprecation warnings");
  expect(out).toContain("more warnings");
  expect(out).toContain("added 120 packages");
});

test("grep groups matches by file", () => {
  const out = grep.apply(
    ["src/a.ts:1:  first", "src/a.ts:9:  second", "src/b.ts:4:  third", "not a match line"].join("\n")
  );
  expect(out).toContain("3 matches in 2 files");
  expect(out).toContain("src/a.ts (2):");
  expect(out).toContain("first");
  expect(out).not.toContain("not a match line");
});

test("grep caps matches per file", () => {
  const rows = Array.from({ length: 25 }, (_, i) => `src/a.ts:${i}:  hit ${i}`).join("\n");
  const out = grep.apply(rows);
  expect(out).toContain("25 matches in 1 files");
  expect(out).toContain("+15 more");
});

test("grep returns its input untouched when nothing parses", () => {
  const input = "no colons here\nnor here\n";
  expect(grep.apply(input)).toBe(input);
});

test("find groups paths by directory", () => {
  const out = find.apply(["src/a.ts", "src/b.ts", "test/c.ts"].join("\n"));
  expect(out).toContain("3 files in 2 dirs");
  expect(out).toContain("src/  (2)");
  expect(out).toContain("  a.ts");
});

test("ls summarizes entries and skips dependency noise", () => {
  const out = ls.apply(
    [
      "total 48",
      "drwxr-xr-x  5 me staff    160 Sep 15 14:11 .",
      "drwxr-xr-x  5 me staff    160 Sep 15 14:11 node_modules",
      "drwxr-xr-x  5 me staff    160 Sep 15 14:11 src",
      "-rw-r--r--  1 me staff   2048 Sep 15 14:11 a.ts",
      "-rw-r--r--  1 me staff 1048576 Sep 15 14:11 big.ts",
    ].join("\n")
  );
  expect(out).toContain("src/");
  expect(out).not.toContain("node_modules");
  expect(out).toContain("a.ts  2.0K");
  expect(out).toContain("big.ts  1.0M");
  expect(out).toContain("Summary: 2 files, 1 dirs");
  expect(out).toContain("2 .ts");
});

test("tree drops its summary line", () => {
  const out = tree.apply(["src", "├── a.ts", "└── b.ts", "", "1 directory, 2 files"].join("\n"));
  expect(out).toContain("├── a.ts");
  expect(out).not.toContain("1 directory, 2 files");
});

// 9Router's substring test ate any line containing both "director" and "file".
test("tree keeps a path that merely looks like its summary line", () => {
  const out = tree.apply(["root", "├── directory/file.ts", "└── b.ts"].join("\n"));
  expect(out).toContain("directory/file.ts");
});

test("search-list groups the Cursor glob result", () => {
  const out = searchList.apply(
    ["Result of search in 'src' (total 3 files):", "- src/a.ts", "- src/b.ts", "- test/c.ts"].join("\n")
  );
  expect(out).toContain("Result of search in 'src'");
  expect(out).toContain("3 files in 2 dirs");
});

test("dedup-log collapses runs of identical lines", () => {
  const out = dedupLog.apply(["start", ...Array(50).fill("repeated"), "end"].join("\n"));
  expect(out).toContain("start");
  expect(out).toContain("repeated");
  expect(out).toContain("49 duplicate lines");
  expect(out).toContain("end");
  expect(out.split("\n").length).toBeLessThan(10);
});

test("dedup-log collapses blank-line padding", () => {
  const out = dedupLog.apply(["a", "", "", "", "", "b"].join("\n"));
  expect(out.split("\n").filter((l) => l === "").length).toBe(1);
});

test("smart-truncate keeps the head and tail", () => {
  const input = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const out = smartTruncate.apply(input);
  expect(out).toContain("line 0");
  expect(out).toContain("line 399");
  expect(out).toContain("lines truncated");
  expect(out).not.toContain("line 200");
});

test("read-numbered marks that the file continues", () => {
  const input = Array.from({ length: 400 }, (_, i) => `${i}| code`).join("\n");
  expect(readNumbered.apply(input)).toContain("file continues");
});

test("head-tail filters leave short input alone", () => {
  const input = "a\nb\nc";
  expect(smartTruncate.apply(input)).toBe(input);
  expect(readNumbered.apply(input)).toBe(input);
});

// ── Integration over canonical messages ──────────────────────────

test("a tool message is compressed and the saving reported", () => {
  const noisy = ["start", ...Array(200).fill("repeated log line"), "end"].join("\n");
  const messages = [toolMsg(noisy)];
  const stats = compressMessages(messages, true);

  expect(stats).not.toBeNull();
  expect(stats!.hits[0]!.filter).toBe("dedup-log");
  expect(stats!.bytesAfter).toBeLessThan(stats!.bytesBefore);
  expect(messages[0]!.parts[0]!.text!.length).toBeLessThan(noisy.length);
  expect(messages[0]!.parts[0]!.text).toContain("duplicate lines");
});

// The whole point of hooking canonical messages: /v1/messages gets this for
// free, because an Anthropic tool_result is a canonical tool message by now.
test("compression is driven by role, so both wire formats are covered", () => {
  const noisy = ["x", ...Array(200).fill("dup")].join("\n");
  const messages: CanonicalMessage[] = [
    { role: "user", parts: [{ type: "text", text: noisy }] },
    toolMsg(noisy),
  ];
  compressMessages(messages, true);
  // A user turn is the human's own words — never rewritten.
  expect(messages[0]!.parts[0]!.text).toBe(noisy);
  expect(messages[1]!.parts[0]!.text).not.toBe(noisy);
});

test("disabled means nothing is touched", () => {
  const noisy = ["x", ...Array(200).fill("dup")].join("\n");
  const messages = [toolMsg(noisy)];
  expect(compressMessages(messages, false)).toBeNull();
  expect(messages[0]!.parts[0]!.text).toBe(noisy);
});

test("small tool output is left alone", () => {
  const small = "tiny result";
  const messages = [toolMsg(small)];
  expect(compressMessages(messages, true)).toBeNull();
  expect(messages[0]!.parts[0]!.text).toBe(small);
});

// The safety rail that makes aggressive filters acceptable.
test("output that a filter would not shrink is kept verbatim", () => {
  // Unique lines, no blank runs: dedup-log can only reproduce the input.
  const text = Array.from({ length: 40 }, (_, i) => `unique line ${i} ${"x".repeat(20)}`).join("\n");
  const messages = [toolMsg(text)];
  expect(compressMessages(messages, true)).toBeNull();
  expect(messages[0]!.parts[0]!.text).toBe(text);
});

test("images and other parts are ignored", () => {
  const messages: CanonicalMessage[] = [
    { role: "tool", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }], toolCallId: "c1" },
  ];
  expect(compressMessages(messages, true)).toBeNull();
  expect(messages[0]!.parts[0]!.data).toBe("QUJD");
});

test("every tool message in a conversation is compressed", () => {
  const noisy = ["x", ...Array(200).fill("dup")].join("\n");
  const messages = [toolMsg(noisy), toolMsg(noisy)];
  const stats = compressMessages(messages, true);
  expect(stats!.hits).toHaveLength(2);
});

test("the log line reports the saving and the filters used", () => {
  const stats = { bytesBefore: 1000, bytesAfter: 250, hits: [{ filter: "grep", saved: 750 }] };
  const line = formatRtkLog(stats)!;
  // 9router-inspired shape: uppercase [RTK] tag + "NB / MB" bandwidth units.
  expect(line.startsWith("[RTK]")).toBe(true);
  expect(line).toContain("saved 750B / 1000B");
  expect(line).toContain("75.0%");
  expect(line).toContain("[grep]");
});

test("no hits means no log line", () => {
  expect(formatRtkLog(null)).toBeNull();
  expect(formatRtkLog({ bytesBefore: 10, bytesAfter: 10, hits: [] })).toBeNull();
});
