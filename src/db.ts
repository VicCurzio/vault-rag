import pg from "pg";

import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// pgvector espera el literal '[1,2,3]'. Lo armamos en un solo lugar para que
// ningun llamador invente su propio formato.
export function toVector(values: number[]): string {
  return `[${values.join(",")}]`;
}
