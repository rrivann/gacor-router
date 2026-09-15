// The filters. Each takes tool output and returns a denser rendering of it.
//
// Every filter is free to be wrong: the caller enforces that a result is
// non-empty and smaller than its input, and falls back to the original text
// otherwise (see safeApply / compressText in ./index.ts). That safety net is
// what makes aggressive rewriting acceptable here.
//
// A filter that can't make sense of its input returns it unchanged rather than
// emitting a confident-looking but empty summary.

import {
  BUILD_DEPRECATION_KEEP,
  BUILD_WARNINGS_KEEP,
  DEDUP_LINE_MAX,
  FIND_PER_DIR_MAX,
  FIND_TOTAL_DIR_MAX,
  GIT_DIFF_HUNK_MAX_LINES,
  GIT_DIFF_MAX_LINES,
  GIT_LOG_MAX_LINES,
  GREP_PER_FILE_MAX,
  LS_EXT_SUMMARY_TOP,
  LS_NOISE_DIRS,
  LS_NOISE_SUFFIXES,
  SMART_TRUNCATE_HEAD,
  SMART_TRUNCATE_MIN_LINES,
  SMART_TRUNCATE_TAIL,
  STATUS_MAX_FILES,
  TREE_MAX_LINES,
} from "./constants";

export interface Filter {
  name: string;
  apply(text: string): string;
}

const lines = (s: string): string[] => s.split("\n");

// Groups paths by parent directory and prints basenames — shared by `find`
// and the Cursor search-list format, which differ only in their header.
function groupPaths(paths: string[], header: string): string {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const dir = sep === -1 ? "." : path.slice(0, sep) || "/";
    const base = sep === -1 ? path : path.slice(sep + 1);
    const cur = byDir.get(dir);
    if (cur) cur.push(base);
    else byDir.set(dir, [base]);
  }

  const dirs = [...byDir.keys()].sort();
  const out: string[] = [`${header}${paths.length} files in ${dirs.length} dirs:`, ""];
  for (const dir of dirs.slice(0, FIND_TOTAL_DIR_MAX)) {
    const files = byDir.get(dir)!;
    out.push(`${dir.replace(/\\/g, "/")}/  (${files.length})`);
    for (const f of files.slice(0, FIND_PER_DIR_MAX)) out.push(`  ${f}`);
    if (files.length > FIND_PER_DIR_MAX) out.push(`  +${files.length - FIND_PER_DIR_MAX} more`);
  }
  if (dirs.length > FIND_TOTAL_DIR_MAX) {
    out.push("", `+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs`);
  }
  return out.join("\n");
}

// ── git diff ─────────────────────────────────────────────────────
// Keeps the changed lines and a per-file tally; drops the index/---/+++
// preamble, which is pure noise once the path is known.

export const gitDiff: Filter = {
  name: "git-diff",
  apply(input) {
    const out: string[] = [];
    let file = "";
    let added = 0;
    let removed = 0;
    let inHunk = false;
    let shown = 0;
    let skipped = 0;
    let truncated = false;

    const flushSkipped = () => {
      if (skipped > 0) {
        out.push(`  ... (${skipped} lines truncated)`);
        truncated = true;
        skipped = 0;
      }
    };
    const flushFile = () => {
      if (file && (added > 0 || removed > 0)) out.push(`  +${added} -${removed}`);
    };

    for (const line of lines(input)) {
      if (line.startsWith("diff --git")) {
        flushSkipped();
        flushFile();
        const parts = line.split(" b/");
        file = parts.length > 1 ? parts.slice(1).join(" b/") : "unknown";
        out.push("", file);
        added = 0;
        removed = 0;
        inHunk = false;
        shown = 0;
      } else if (line.startsWith("@@")) {
        flushSkipped();
        inHunk = true;
        shown = 0;
        out.push(`  ${line}`);
      } else if (inHunk) {
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isDel = line.startsWith("-") && !line.startsWith("---");
        if (isAdd) added++;
        if (isDel) removed++;

        if (isAdd || isDel) {
          if (shown < GIT_DIFF_HUNK_MAX_LINES) {
            out.push(`  ${line}`);
            shown++;
          } else skipped++;
        } else if (shown > 0 && shown < GIT_DIFF_HUNK_MAX_LINES && !line.startsWith("\\")) {
          // Context is only worth keeping once the hunk has shown a change;
          // leading context before the first +/- is noise.
          out.push(`  ${line}`);
          shown++;
        }
      }

      if (out.length >= GIT_DIFF_MAX_LINES) {
        truncated = true;
        break;
      }
    }
    flushSkipped();
    flushFile();

    if (out.length === 0) return input;
    if (truncated) out.push("", "... (diff truncated)");
    return out.join("\n").trimStart();
  },
};

// ── git status ───────────────────────────────────────────────────
// Handles porcelain (`XY path`), long form (`modified:   path`), and the
// `## branch` header. Files are bucketed and counted rather than listed in
// full, which is where nearly all the saving comes from.

export const gitStatus: Filter = {
  name: "git-status",
  apply(input) {
    let branch = "";
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    let conflicts = 0;
    // Bare paths under an "Untracked files:" header carry no marker, so the
    // section header is what identifies them.
    let section: "untracked" | null = null;

    for (const raw of lines(input)) {
      const t = raw.trim();
      if (!t) continue;

      if (t.startsWith("## ")) {
        branch = t.slice(3).split("...")[0]!.trim();
        continue;
      }
      const onBranch = /^On branch (.+)$/.exec(t);
      if (onBranch) {
        branch = onBranch[1]!.trim();
        continue;
      }
      if (/^Untracked files:/.test(t)) {
        section = "untracked";
        continue;
      }
      if (/^Changes (not staged|to be committed)/.test(t)) {
        section = null;
        continue;
      }
      if (t.startsWith("(")) continue; // git's "use git add..." hints

      if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
        const x = raw[0]!;
        const y = raw[1]!;
        const file = raw.slice(3);
        if (raw.slice(0, 2) === "??") {
          untracked.push(file);
          continue;
        }
        if ("MADRC".includes(x)) staged.push(file);
        else if (x === "U") conflicts++;
        if (y === "M" || y === "D") modified.push(file);
        continue;
      }

      const long = /^(modified|new file|deleted|renamed|both modified):\s+(.+)$/.exec(t);
      if (long) {
        const kind = long[1]!;
        const path = long[2]!.trim();
        if (kind === "both modified") conflicts++;
        else if (kind === "modified" || kind === "deleted") modified.push(path);
        else staged.push(path);
        continue;
      }

      // An unmarked path inside the untracked section. 9Router dropped these
      // outright, undercounting a fresh repo's status.
      if (section === "untracked" && !t.includes(" ")) untracked.push(t);
    }

    const out: string[] = [];
    if (branch) out.push(`* ${branch}`);

    const bucket = (label: string, files: string[]) => {
      if (files.length === 0) return;
      out.push(`${label}: ${files.length} files`);
      for (const f of files.slice(0, STATUS_MAX_FILES)) out.push(`   ${f}`);
      if (files.length > STATUS_MAX_FILES) out.push(`   ... +${files.length - STATUS_MAX_FILES} more`);
    };
    bucket("+ Staged", staged);
    bucket("~ Modified", modified);
    bucket("? Untracked", untracked);
    if (conflicts > 0) out.push(`! Conflicts: ${conflicts} files`);

    if (out.length === 0) return input;
    if (staged.length + modified.length + untracked.length + conflicts === 0) {
      out.push("clean — nothing to commit");
    }
    return out.join("\n");
  },
};

// ── git log ──────────────────────────────────────────────────────
// Keeps the commit header, author/date, and subject; drops message bodies and
// any diff that `--patch` dragged along.

export const gitLog: Filter = {
  name: "git-log",
  apply(input) {
    const out: string[] = [];
    let inCommit = false;
    let inDiff = false;
    let subjectSeen = false;

    for (const line of lines(input)) {
      const t = line.trim();

      if (/^[*|/\\ ]*commit [0-9a-f]{7,40}$/i.test(t)) {
        inCommit = true;
        inDiff = false;
        subjectSeen = false;
        out.push(t);
        continue;
      }
      // A diff run ends only at the next commit header, so everything in
      // between is dropped without re-testing it.
      if (inDiff) continue;
      if (!inCommit) {
        // --oneline has no commit header; keep those lines as-is.
        if (t) out.push(t);
        continue;
      }
      if (/^[*|/\\ ]*(Author|Date):/i.test(t)) {
        out.push(`  ${t}`);
        continue;
      }
      if (!t) continue;
      // git indents the commit subject by four spaces.
      if (!subjectSeen && /^[*|/\\ ]*    \S/.test(line)) {
        out.push(`  Subject: ${t}`);
        subjectSeen = true;
        continue;
      }
      if (/^\d+ files? changed/.test(t)) {
        out.push(`  ${t}`);
        continue;
      }
      if (t.startsWith("diff --git")) {
        out.push("  ... diff body omitted");
        inDiff = true;
        continue;
      }
      // Remaining commit-body prose is dropped.
      if (!subjectSeen) {
        out.push(`  Subject: ${t}`);
        subjectSeen = true;
      }
    }

    if (out.length === 0) return input;
    if (out.length > GIT_LOG_MAX_LINES) {
      const cut = out.length - GIT_LOG_MAX_LINES;
      return [...out.slice(0, GIT_LOG_MAX_LINES), `... (${cut} more lines)`].join("\n");
    }
    return out.join("\n");
  },
};

// ── build output ─────────────────────────────────────────────────
// npm/cargo/maven logs are mostly progress chatter. Errors are kept in full
// (they're the reason anyone reads this), progress lines become counts.

const RE_CARGO_ERR_CONT = /^\s*(-->|\||\d+\s*\||=)/;

export const buildOutput: Filter = {
  name: "build-output",
  apply(input) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const deprecations: string[] = [];
    const summary: string[] = [];
    let compiling = 0;
    let downloading = 0;
    let inCargoError = false;

    for (const line of lines(input)) {
      const t = line.trim();
      if (!t) continue;

      // A cargo error spans several indented lines; keep the whole block.
      if (inCargoError) {
        if (RE_CARGO_ERR_CONT.test(line)) {
          errors.push(line);
          continue;
        }
        inCargoError = false;
      }

      if (/^error(\[|:)/i.test(t) || t.startsWith("error -->")) {
        errors.push(line);
        inCargoError = true;
        continue;
      }
      if (/^(npm ERR!|\[ERROR\]|ERROR:)/i.test(t)) {
        errors.push(line);
        continue;
      }
      if (/deprecated/i.test(t)) {
        deprecations.push(line);
        continue;
      }
      if (/^(npm warn|yarn warn|warning(\[|:)|\[WARNING\])/i.test(t)) {
        warnings.push(line);
        continue;
      }
      if (/^Compiling\s+\S+/i.test(t)) {
        compiling++;
        continue;
      }
      if (/^Downloading\s+\S+/i.test(t)) {
        downloading++;
        continue;
      }
      if (/^(BUILD (SUCCESS|FAILED)|Finished\s|Successfully |added \d+ package)/i.test(t)) {
        summary.push(line);
        continue;
      }
      // Anything unclassified is dropped — that's the compression.
    }

    const out: string[] = [];
    for (const d of deprecations.slice(0, BUILD_DEPRECATION_KEEP)) out.push(d);
    if (deprecations.length > BUILD_DEPRECATION_KEEP) {
      out.push(`... +${deprecations.length - BUILD_DEPRECATION_KEEP} more deprecation warnings`);
    }
    if (compiling > 0) out.push(`Compiled ${compiling} packages`);
    if (downloading > 0) out.push(`Downloaded ${downloading} packages`);
    out.push(...errors);
    for (const w of warnings.slice(0, BUILD_WARNINGS_KEEP)) out.push(w);
    if (warnings.length > BUILD_WARNINGS_KEEP) {
      out.push(`... +${warnings.length - BUILD_WARNINGS_KEEP} more warnings`);
    }
    out.push(...summary);

    return out.length > 0 ? out.join("\n") : input;
  },
};

// ── grep ─────────────────────────────────────────────────────────
// `file:line:content` grouped per file.

export const grep: Filter = {
  name: "grep",
  apply(input) {
    const byFile = new Map<string, [string, string][]>();
    let total = 0;

    for (const line of lines(input)) {
      const first = line.indexOf(":");
      if (first === -1) continue;
      const second = line.indexOf(":", first + 1);
      if (second === -1) continue;
      const lineNo = line.slice(first + 1, second);
      if (!/^\d+$/.test(lineNo)) continue;

      const file = line.slice(0, first);
      const content = line.slice(second + 1);
      total++;
      const cur = byFile.get(file);
      if (cur) cur.push([lineNo, content]);
      else byFile.set(file, [[lineNo, content]]);
    }
    if (total === 0) return input;

    const files = [...byFile.keys()].sort();
    const out: string[] = [`${total} matches in ${files.length} files`, ""];
    for (const file of files) {
      const matches = byFile.get(file)!;
      out.push(`${file} (${matches.length}):`);
      for (const [no, content] of matches.slice(0, GREP_PER_FILE_MAX)) {
        out.push(`  ${no.padStart(4)}: ${content.trim()}`);
      }
      if (matches.length > GREP_PER_FILE_MAX) {
        out.push(`  +${matches.length - GREP_PER_FILE_MAX} more`);
      }
      out.push("");
    }
    return out.join("\n").trimEnd();
  },
};

// ── find ─────────────────────────────────────────────────────────

export const find: Filter = {
  name: "find",
  apply(input) {
    const paths = lines(input)
      .map((l) => l.trim())
      .filter(Boolean);
    if (paths.length === 0) return input;
    return groupPaths(paths, "");
  },
};

// ── search-list ──────────────────────────────────────────────────
// Cursor's Glob tool: a header line then `- path` entries.

export const SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;

export const searchList: Filter = {
  name: "search-list",
  apply(input) {
    const all = lines(input);
    const header = all[0] ?? "";
    const paths: string[] = [];
    for (const raw of all.slice(1)) {
      const t = raw.trim();
      if (t.startsWith("- ")) paths.push(t.slice(2));
    }
    if (paths.length === 0) return input;
    return groupPaths(paths, `${header}\n`);
  },
};

// ── ls ───────────────────────────────────────────────────────────

const LS_DATE_RE =
  /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

function isNoise(name: string): boolean {
  return LS_NOISE_DIRS.has(name) || LS_NOISE_SUFFIXES.some((s) => name.endsWith(s));
}

export const ls: Filter = {
  name: "ls",
  apply(input) {
    const dirs: string[] = [];
    const files: { name: string; size: number }[] = [];
    const byExt = new Map<string, number>();

    for (const line of lines(input)) {
      const m = LS_DATE_RE.exec(line);
      if (!m) continue;
      const name = line.slice(m.index + m[0].length);
      const before = line.slice(0, m.index).split(/\s+/).filter(Boolean);
      if (before.length < 4) continue;

      const kind = before[0]![0]!;
      // The size is the last purely-numeric field before the date.
      let size = 0;
      for (let i = before.length - 1; i >= 0; i--) {
        const v = Number(before[i]);
        if (Number.isInteger(v) && String(v) === before[i]) {
          size = v;
          break;
        }
      }

      if (name === "." || name === ".." || isNoise(name)) continue;
      if (kind === "d") {
        dirs.push(name);
        continue;
      }
      files.push({ name, size });
      const dot = name.lastIndexOf(".");
      if (dot > 0) {
        const ext = name.slice(dot);
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
      }
    }

    if (dirs.length === 0 && files.length === 0) return input;

    const out: string[] = [];
    for (const d of dirs.sort()) out.push(`${d}/`);
    for (const f of files) out.push(`${f.name}  ${humanSize(f.size)}`);

    let summary = `\nSummary: ${files.length} files, ${dirs.length} dirs`;
    if (byExt.size > 0) {
      const ranked = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
      const top = ranked.slice(0, LS_EXT_SUMMARY_TOP).map(([e, c]) => `${c} ${e}`);
      summary += ` (${top.join(", ")}`;
      if (ranked.length > LS_EXT_SUMMARY_TOP) summary += `, +${ranked.length - LS_EXT_SUMMARY_TOP} more`;
      summary += ")";
    }
    out.push(summary);
    return out.join("\n");
  },
};

// ── tree ─────────────────────────────────────────────────────────

// Anchored so a path like `directory/file.ts` isn't mistaken for the summary.
const TREE_SUMMARY_RE = /^\d+ director(y|ies), \d+ files?$/;

export const tree: Filter = {
  name: "tree",
  apply(input) {
    const kept: string[] = [];
    for (const line of lines(input)) {
      if (TREE_SUMMARY_RE.test(line.trim())) continue;
      if (line.trim() === "" && kept.length === 0) continue;
      kept.push(line);
    }
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    if (kept.length === 0) return input;

    if (kept.length > TREE_MAX_LINES) {
      const cut = kept.length - TREE_MAX_LINES;
      return [...kept.slice(0, TREE_MAX_LINES), `... +${cut} more lines`].join("\n");
    }
    return kept.join("\n");
  },
};

// ── dedup log ────────────────────────────────────────────────────
// Collapses runs of identical lines and blank-line padding. Only adjacent
// duplicates collapse; a global dedup would reorder meaning.

export const dedupLog: Filter = {
  name: "dedup-log",
  apply(input) {
    const out: string[] = [];
    let prev: string | null = null;
    let run = 0;
    let blanks = 0;

    const flush = () => {
      if (prev !== null && run > 1) out.push(`  ... (${run - 1} duplicate lines)`);
    };

    for (const line of lines(input)) {
      if (line.trim() === "") {
        if (blanks < 1) out.push(line);
        blanks++;
        flush();
        prev = null;
        run = 0;
        continue;
      }
      blanks = 0;
      if (line === prev) {
        run++;
        continue;
      }
      flush();
      out.push(line);
      prev = line;
      run = 1;

      if (out.length >= DEDUP_LINE_MAX) {
        out.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
        return out.join("\n");
      }
    }
    flush();
    return out.join("\n");
  },
};

// ── smart truncate / read numbered ───────────────────────────────
// Head and tail survive; the middle goes. The two differ only in the marker,
// which tells the model whether it's looking at a file or a log.

function headTail(input: string, marker: (cut: number) => string): string {
  const all = lines(input);
  if (all.length < SMART_TRUNCATE_MIN_LINES) return input;
  const head = all.slice(0, SMART_TRUNCATE_HEAD);
  const tail = all.slice(all.length - SMART_TRUNCATE_TAIL);
  const cut = all.length - head.length - tail.length;
  return [...head, marker(cut), ...tail].join("\n");
}

export const smartTruncate: Filter = {
  name: "smart-truncate",
  apply: (input) => headTail(input, (cut) => `... +${cut} lines truncated`),
};

export const READ_NUMBERED_LINE_RE = /^\s*\d+\|/;

export const readNumbered: Filter = {
  name: "read-numbered",
  apply: (input) => headTail(input, (cut) => `... +${cut} lines truncated (file continues)`),
};

export const ALL_FILTERS: Filter[] = [
  gitDiff,
  gitStatus,
  gitLog,
  buildOutput,
  grep,
  find,
  ls,
  tree,
  searchList,
  dedupLog,
  smartTruncate,
  readNumbered,
];
