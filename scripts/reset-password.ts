// Reset the dashboard password from the CLI. The recovery path when the
// operator forgets the password on a live VPS install — SSH in, run this,
// log back in with the new one.
//
// Usage:
//   bun run scripts/reset-password.ts <new-password>
//
// The old JWT secret is rotated at the same time (setPassword() mints a new
// one), so any session tokens still floating around stop verifying immediately.

import { setPassword } from "../src/lib/dashboardAuth";

const pw = process.argv[2];
if (!pw) {
  console.error("usage: bun run scripts/reset-password.ts <new-password>");
  process.exit(1);
}
if (pw.length < 6) {
  console.error("password must be at least 6 characters");
  process.exit(1);
}

try {
  await setPassword(pw);
  console.log("✓ dashboard password reset. Existing sessions have been invalidated.");
} catch (err) {
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exit(2);
}
