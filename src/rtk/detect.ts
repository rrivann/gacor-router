// Picks a filter by sniffing the text's shape. Order matters: the cascade runs
// from most specific to most general, and the first match wins.
//
// Shape decisions read the head only (cheap, and a format is recognizable from
// its opening lines), but the two size gates read the FULL line count. 9Router
// gated those on the head as well, which required ~250 lines inside 1KB — under
// 4 chars per line. The result was that read-numbered and smart-truncate were
// effectively dead code; here they actually fire.

import {
  DEDUP_MIN_LINES,
  DETECT_WINDOW,
  FIND_MIN_LINES,
  GREP_PROBE_LINES,
  LS_MIN_ROWS,
  PORCELAIN_MIN_RATIO,
  READ_NUMBERED_MIN_HIT_RATIO,
  READ_NUMBERED_SAMPLE,
  SMART_TRUNCATE_MIN_LINES,
} from "./constants";
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
  READ_NUMBERED_LINE_RE,
  searchList,
  SEARCH_LIST_HEADER_RE,
  smartTruncate,
  tree,
  type Filter,
} from "./filters";

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/;
const RE_BUILD_OUTPUT =
  /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE_GLYPH = /[├└]──|│ {2}/;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;

// `path/to/file.ts:42:  matched text`
function isGrepLine(line: string): boolean {
  const first = line.indexOf(":");
  if (first === -1) return false;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return false;
  return /^\d+$/.test(line.slice(first + 1, second));
}

function isPathLike(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // A drive letter is a path, not a grep separator.
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(":")) return false;
  return t.startsWith(".") || t.startsWith("/") || t.includes("/");
}

function isMostlyPorcelain(headLines: string[]): boolean {
  const nonEmpty = headLines.filter((l) => l.trim());
  if (nonEmpty.length < 3) return false;
  const hits = nonEmpty.filter((l) => RE_PORCELAIN.test(l)).length;
  return hits / nonEmpty.length >= PORCELAIN_MIN_RATIO;
}

function isLineNumbered(all: string[]): boolean {
  let hits = 0;
  let nonEmpty = 0;
  for (const l of all.slice(0, READ_NUMBERED_SAMPLE)) {
    if (!l) continue;
    nonEmpty++;
    if (READ_NUMBERED_LINE_RE.test(l)) hits++;
  }
  if (nonEmpty < 5) return false;
  return hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO;
}

function countMatches(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(g) ?? []).length;
}

export function detectFilter(text: string): Filter | null {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;
  const headLines = head.split("\n");
  const nonEmpty = headLines.filter((l) => l.trim());
  const totalLines = text.split("\n").length;

  if (RE_GIT_LOG.test(head)) return gitLog;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiff;
  if (RE_GIT_STATUS.test(head)) return gitStatus;

  // Checked before the porcelain ratio: cargo's "Compiling foo" lines otherwise
  // read as porcelain status markers.
  if (RE_BUILD_OUTPUT.test(head)) return buildOutput;
  if (isMostlyPorcelain(headLines)) return gitStatus;

  if (nonEmpty.slice(0, GREP_PROBE_LINES).some(isGrepLine)) return grep;
  if (nonEmpty.length >= FIND_MIN_LINES && nonEmpty.every(isPathLike)) return find;
  if (RE_TREE_GLYPH.test(head)) return tree;
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= LS_MIN_ROWS) return ls;
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList;

  // Size-gated from here down — these read the full text, not the head.
  if (totalLines >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(text.split("\n"))) {
    return readNumbered;
  }
  if (nonEmpty.length >= DEDUP_MIN_LINES) return dedupLog;
  if (totalLines >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;

  return null;
}
