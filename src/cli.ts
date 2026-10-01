// Entrada de linea de comandos:
//
//   npm run ask -- "por que decidimos idempotencia en las escrituras"

import { ask } from "./agent.ts";
import { pool } from "./db.ts";

const question = process.argv.slice(2).join(" ");

if (!question) {
  console.error('Uso: npm run ask -- "tu pregunta"');
  process.exit(1);
}

const { answer, searches } = await ask(question);

console.log(`\n${answer}\n`);
console.log(`Busquedas que hizo el agente (${searches.length}):`);
for (const query of searches) console.log(`  - ${query}`);

await pool.end();
