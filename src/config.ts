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

// Carpetas o archivos que no se indexan nunca, por prefijo de ruta relativa al
// vault y separados por coma.
//
// Importa aunque todo corra local: la busqueda y los embeddings no salen de la
// maquina, pero `ask` manda al modelo los fragmentos que encontro. Lo que no
// esta indexado no puede viajar, y esa es la unica garantia que no depende de
// acordarse de nada.
const excluded = (process.env.EXCLUDE_PATHS ?? "")
  .split(",")
  .map((entry) => entry.trim().replaceAll("\\", "/").replace(/^\/|\/$/g, ""))
  .filter(Boolean);

// Carpetas cuyas notas son historia y no estado: siguen siendo buscables, pero
// con menos peso. Se comparan por segmento de ruta, no por prefijo, porque
// aparecen en cualquier nivel del arbol.
const demoted = (process.env.DEMOTE_PATHS ?? "")
  .split(",")
  .map((entry) => entry.trim().replaceAll("\\", "/").replace(/^\/|\/$/g, "").toLowerCase())
  .filter(Boolean);

export const config = {
  databaseUrl: required("DATABASE_URL"),
  vaultPath: required("VAULT_PATH"),
  excluded,
  demoted,
  isDemoted(path: string): boolean {
    const segments = path.replaceAll("\\", "/").toLowerCase().split("/");
    return demoted.some((entry) => segments.includes(entry));
  },
  // Cuanto se le baja el puntaje a esas notas. 1 las deja iguales, 0 las hunde.
  // El numero sale de medir con el eval, no de elegirlo.
  demoteFactor: Number(process.env.DEMOTE_FACTOR ?? 0.7),
  // Una ruta queda afuera si es el prefijo exacto, para que "Clientes" excluya
  // "Clientes/Acme/nota.md" pero no "Clientes-publicos/nota.md".
  isExcluded(path: string): boolean {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    return excluded.some((entry) => {
      const prefix = entry.toLowerCase();
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    });
  },
  // Opcional a proposito: la busqueda y los evals corren sin clave.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // El modelo y la dimension van juntos: cambiar uno obliga a cambiar el otro
  // y a reindexar. Por eso viven en el mismo lugar.
  embeddingModel: "Xenova/multilingual-e5-small",
  embeddingDimensions: 384,
  answerModel: "claude-sonnet-5",
  // Segundo modelo, el que reordena. Multilingue (XLM-RoBERTa), que es lo que
  // lo hace servible sobre notas en castellano.
  rerankModel: "Xenova/bge-reranker-base",
  // **Apagado por defecto, y es una decision medida.** Con 20 candidatos da
  // el mismo recall que sin reordenar (89%) y cuesta veinte pasadas de modelo
  // por pregunta; con 40 baja a 86%. Se enciende con RERANK=1 para volver a
  // medirlo, por ejemplo si cambia el modelo o el corpus.
  rerank: process.env.RERANK === "1",
  // Cuantos candidatos se le pasan al reordenador. Mas alto da mas chances de
  // rescatar algo que la busqueda dejo en el puesto quince, y cuesta lineal:
  // el reordenador corre una vez por candidato y no se puede precalcular.
  rerankPool: Number(process.env.RERANK_POOL ?? 20),
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
