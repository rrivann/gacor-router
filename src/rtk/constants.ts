// RTK tunables. Every threshold the filters and the detector use lives here —
// 9Router scattered several of these as literals inside individual filters,
// which made the aggressive ones hard to reason about.

export const RAW_CAP = 10 * 1024 * 1024; // skip absurd payloads entirely
export const MIN_COMPRESS_SIZE = 500; // below this there's nothing worth saving
export const DETECT_WINDOW = 1024; // chars of the head the detector sniffs

// ── Detection ratios / probes ────────────────────────────────────
export const PORCELAIN_MIN_RATIO = 0.6;
export const GREP_PROBE_LINES = 5;
export const FIND_MIN_LINES = 3;
export const LS_MIN_ROWS = 3;
export const DEDUP_MIN_LINES = 5;
export const READ_NUMBERED_SAMPLE = 100;
export const READ_NUMBERED_MIN_HIT_RATIO = 0.7;

// ── git diff ─────────────────────────────────────────────────────
export const GIT_DIFF_HUNK_MAX_LINES = 100;
export const GIT_DIFF_MAX_LINES = 500;

// ── git log ──────────────────────────────────────────────────────
export const GIT_LOG_MAX_LINES = 200;

// ── git status ───────────────────────────────────────────────────
export const STATUS_MAX_FILES = 10;

// ── build output ─────────────────────────────────────────────────
export const BUILD_DEPRECATION_KEEP = 3;
export const BUILD_WARNINGS_KEEP = 5;

// ── grep / find / search-list ────────────────────────────────────
export const GREP_PER_FILE_MAX = 10;
export const FIND_PER_DIR_MAX = 10;
export const FIND_TOTAL_DIR_MAX = 20;

// ── ls ───────────────────────────────────────────────────────────
export const LS_EXT_SUMMARY_TOP = 5;
export const LS_NOISE_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "__pycache__",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".vercel",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  // Python's legacy virtualenv dir. `.env` (dotenv) is deliberately absent —
  // it's a file worth seeing, not noise.
  "env",
  "coverage",
  ".nyc_output",
  ".DS_Store",
  "Thumbs.db",
  ".idea",
  ".vscode",
  ".vs",
  ".eggs",
]);
// `*.egg-info` can't be a set member — it's a glob, so it needs a suffix test.
export const LS_NOISE_SUFFIXES = [".egg-info"];

// ── tree ─────────────────────────────────────────────────────────
export const TREE_MAX_LINES = 200;

// ── dedup log ────────────────────────────────────────────────────
export const DEDUP_LINE_MAX = 2000;

// ── smart truncate / read numbered ───────────────────────────────
export const SMART_TRUNCATE_HEAD = 120;
export const SMART_TRUNCATE_TAIL = 60;
export const SMART_TRUNCATE_MIN_LINES = 250;
