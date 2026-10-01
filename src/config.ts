// Lee .env sin dependencias: Node 22 trae --env-file, pero queremos que
// `npm run x` funcione sin recordar el flag, asi que lo cargamos a mano.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "..", ".env");

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

// El servicio no arranca sin lo que necesita, en vez de fallar mas adelante
// con un error que no dice nada.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta ${name}. Copia .env.example a .env y completalo.`);
  }
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  vaultPath: required("VAULT_PATH"),
  // Opcional a proposito: la busqueda y los evals corren sin clave.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // El modelo y la dimension van juntos: cambiar uno obliga a cambiar el otro
  // y a reindexar. Por eso viven en el mismo lugar.
  embeddingModel: "Xenova/multilingual-e5-small",
  embeddingDimensions: 384,
  answerModel: "claude-sonnet-5",
  // Arriba de esta distancia no se considera que haya respuesta en las notas.
  //
  // El 0.15 esta medido, no elegido: con el set de evals del 2026-10-01 las
  // preguntas con respuesta caian entre 0.110 y 0.137, y las que no la tenian
  // en 0.164 y 0.194. Cualquier numero del medio las parte.
  //
  // Es un piso, no una solucion: son nueve ejemplos, y con mas preguntas las
  // dos nubes se van a pisar. Lo que sostiene la regla de "no inventar" es que
  // el modelo lea lo que trajo y decida; el umbral solo corta lo grosero antes
  // de llegar a el.
  absentThreshold: 0.15,
};
