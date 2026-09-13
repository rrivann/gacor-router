// The app's single Pool instance, wired to the DB.

import { Pool } from "./pool";
import { listAccounts, rotationFor } from "../db/accounts";

export const pool = new Pool(listAccounts, rotationFor);
export { Pool } from "./pool";
export type { AccountRow, RotationMode } from "./pool";
