// Indexa el vault: recorre los .md, los parte en pedazos, calcula un vector
// por pedazo y lo guarda.
//
//   npm run ingest            indexa todo lo que cambio
//   npm run ingest -- --all   reindexa todo, aunque no haya cambiado
//   npm run ingest -- --limit 50
//
// Es incremental por el hash del archivo: calcular embeddings es lo unico caro
// de todo el proyecto, asi que una nota que no cambio no se vuelve a embeber.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { parseNote } from "./chunk.ts";
import { config } from "./config.ts";
import { pool, toVector } from "./db.ts";
import { embed } from "./embed.ts";

const IGNORED = new Set([".git", ".obsidian", "node_modules", ".claude", "dist", "build"]);
const BATCH = 16;

const args = process.argv.slice(2);
const force = args.includes("--all");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex === -1 ? Infinity : Number(args[limitIndex + 1]);

async function walk(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, found);
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

const files = (await walk(config.vaultPath)).slice(0, limit);
console.log(`${files.length} notas encontradas en ${config.vaultPath}`);

let indexed = 0;
let skipped = 0;
let chunkCount = 0;

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const path = relative(config.vaultPath, file).replaceAll("\\", "/");
  const hash = createHash("sha256").update(raw).digest("hex");

  const existing = await pool.query<{ id: string; hash: string }>(
    "select id, hash from notes where path = $1",
    [path],
  );

  if (!force && existing.rows[0]?.hash === hash) {
    skipped += 1;
    continue;
  }

  const { title, chunks } = parseNote(raw, basename(file, ".md"));
  if (chunks.length === 0) {
    skipped += 1;
    continue;
  }

  // Lo que se embebe no es lo mismo que lo que se guarda.
  //
  // Guardamos el texto limpio, para citarlo tal cual. Pero el vector se calcula
  // sobre el texto CON su titulo y su encabezado adelante, porque un pedazo
  // suelto no sabe de que nota salio: la seccion "Contexto" del ADR que elige
  // Drizzle no menciona a Drizzle por ningun lado, y sin el titulo es
  // indistinguible de la seccion "Contexto" de cualquier otro ADR.
  const forEmbedding = chunks.map((chunk) =>
    [title, chunk.heading, chunk.content].filter(Boolean).join("\n"),
  );

  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    vectors.push(...(await embed(forEmbedding.slice(i, i + BATCH), "passage")));
  }

  const client = await pool.connect();

  // Nota y pedazos entran juntos o no entra ninguno: si el proceso se corta a
  // la mitad, la nota no queda registrada como indexada con la mitad de sus
  // pedazos adentro.
  try {
    await client.query("begin");

    const note = await client.query<{ id: string }>(
      `insert into notes (path, title, hash) values ($1, $2, $3)
       on conflict (path) do update set title = excluded.title,
                                        hash = excluded.hash,
                                        indexed_at = now()
       returning id`,
      [path, title, hash],
    );

    const noteId = note.rows[0].id;
    await client.query("delete from chunks where note_id = $1", [noteId]);

    for (const [i, chunk] of chunks.entries()) {
      await client.query(
        `insert into chunks (note_id, ord, heading, content, embedding)
         values ($1, $2, $3, $4, $5)`,
        [noteId, chunk.ord, chunk.heading, chunk.content, toVector(vectors[i])],
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  indexed += 1;
  chunkCount += chunks.length;
  if (indexed % 10 === 0) console.log(`  ${indexed} notas indexadas...`);
}

console.log(`Listo: ${indexed} notas indexadas (${chunkCount} pedazos), ${skipped} sin cambios.`);
await pool.end();
