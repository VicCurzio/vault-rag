// Migraciones: archivos .sql versionados y una tabla que registra cuales se
// aplicaron. Es lo minimo no negociable, con ORM o sin ORM: sin esto nadie
// sabe en que estado esta una base que no es la propia.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { pool } from "./db.ts";

const dir = resolve(import.meta.dirname, "..", "db", "migrations");

await pool.query(`
  create table if not exists schema_migrations (
    name       text primary key,
    applied_at timestamptz not null default now()
  )
`);

const applied = await pool.query<{ name: string }>("select name from schema_migrations");
const done = new Set(applied.rows.map((row) => row.name));
const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

let count = 0;

for (const file of files) {
  if (done.has(file)) continue;

  const sql = readFileSync(resolve(dir, file), "utf8");
  const client = await pool.connect();

  // La migracion y su registro van en la misma transaccion: si falla a la
  // mitad no queda anotada como aplicada.
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into schema_migrations (name) values ($1)", [file]);
    await client.query("commit");
    console.log(`aplicada: ${file}`);
    count += 1;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

console.log(count === 0 ? "Sin migraciones pendientes." : `${count} migracion(es) aplicada(s).`);
await pool.end();
