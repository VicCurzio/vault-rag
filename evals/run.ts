// Evals: medir si la busqueda encuentra lo que tiene que encontrar.
//
//   npm run eval
//
// Por que existe esto antes que cualquier mejora: sin numero, "mejorar el RAG"
// es una opinion. Con numero, cambiar el tamano de los pedazos o el modelo deja
// de ser charla y pasa a ser una comparacion.
//
// Mide dos cosas distintas, y la segunda es la importante:
//
//   recall@k  de las preguntas que SI tienen respuesta en las notas, en
//             cuantas aparece la nota correcta entre los k primeros resultados.
//
//   rechazo   de las preguntas que NO tienen respuesta en las notas, en
//             cuantas el mejor resultado queda lo bastante lejos como para
//             poder decir "no se" en vez de inventar.
//
// La segunda es la que prueba que la regla central del proyecto esta encendida.
// Una corrida donde todo pasa pero nunca se le dio nada que rechazar no prueba
// que el control funcione: prueba que no salto, que es lo mismo que se ve
// cuando esta apagado.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../src/config.ts";
import { pool } from "../src/db.ts";
import { type Hit, search } from "../src/search.ts";

// `expect` admite varias rutas cuando el hecho vive en mas de una nota: el ADR
// que decide algo y la nota de concern que lo describe contestan los dos, y
// exigir una sola seria medir mal. No es aflojar el eval: lo que se afloja es
// la pregunta mal formulada, no el resultado.
type Case = { question: string; expect: string | string[] | null };

const expected = (item: Case): string[] =>
  item.expect === null ? [] : Array.isArray(item.expect) ? item.expect : [item.expect];

const K = 5;

// El umbral sale de config.ts, el mismo que usa el agente. Si el eval midiera
// contra un numero propio, estaria midiendo un sistema que no es el que corre.
const ABSENT_THRESHOLD = config.absentThreshold;

// El set real apunta a notas privadas y no se versiona. El repo lleva el
// ejemplo, que muestra el formato y no dice nada de nadie.
const questionsPath = resolve(import.meta.dirname, "questions.json");

if (!existsSync(questionsPath)) {
  console.error(
    "Falta evals/questions.json. Copia evals/questions.example.json y escribi las preguntas sobre tus notas.",
  );
  process.exit(1);
}

const cases: Case[] = JSON.parse(readFileSync(questionsPath, "utf8"))
  // Las entradas que solo documentan el formato no son casos.
  .filter((item: Partial<Case>) => typeof item.question === "string");

const present = cases.filter((item) => item.expect !== null);
const absent = cases.filter((item) => item.expect === null);

let found = 0;
let rejected = 0;

console.log(`Recuperacion (recall@${K}) sobre ${present.length} preguntas con respuesta:\n`);

const presentDistances: number[] = [];

for (const item of present) {
  const hits = await search(item.question, K);
  const wanted = expected(item);
  const position = hits.findIndex((hit) => wanted.some((path) => hit.path.includes(path)));
  const ok = position !== -1;
  if (ok) found += 1;

  // La distancia del mejor resultado, haya acertado o no. Es el dato que hace
  // falta para elegir el umbral de rechazo con evidencia en vez de a ojo.
  const best = hits[0]?.distance ?? Infinity;
  presentDistances.push(best);

  const mark = ok ? `ok (puesto ${position + 1})` : "NO ENCONTRADA";
  console.log(`  [${mark}] d=${best.toFixed(3)}  ${item.question}`);
  if (!ok) {
    console.log(`      esperaba: ${item.expect}`);
    console.log(`      trajo:    ${hits.map((hit) => hit.path).join(", ") || "nada"}`);
  }
}

console.log(`\nRechazo sobre ${absent.length} preguntas que no estan en las notas:\n`);

const absentDistances: number[] = [];

for (const item of absent) {
  // La mas cercana de las que trajo, no la primera: desde que la busqueda es
  // hibrida, el orden lo decide la fusion y el primer resultado puede no ser
  // el mas cercano por vector. La pregunta que importa sigue siendo si hay
  // ALGO lo bastante cerca como para considerarlo una fuente.
  const hits = await search(item.question, K);
  const best = hits.reduce<Hit | undefined>(
    (closest, hit) => (closest && closest.distance <= hit.distance ? closest : hit),
    undefined,
  );
  const distance = best?.distance ?? Infinity;
  absentDistances.push(distance);
  const ok = distance > ABSENT_THRESHOLD;
  if (ok) rejected += 1;

  console.log(`  [${ok ? "ok" : "FALSO POSITIVO"}] ${item.question}`);
  if (!ok) console.log(`      mejor resultado a ${distance.toFixed(3)}: ${best?.path ?? "nada"}`);
}

const recall = present.length === 0 ? 0 : (found / present.length) * 100;
const rejection = absent.length === 0 ? 0 : (rejected / absent.length) * 100;

console.log(`\n-----`);
console.log(`recall@${K}: ${found}/${present.length} (${recall.toFixed(0)}%)`);
console.log(`rechazo:    ${rejected}/${absent.length} (${rejection.toFixed(0)}%)`);

// Las dos distribuciones, una al lado de la otra. Si la peor distancia de una
// pregunta con respuesta es MENOR que la mejor de una pregunta sin respuesta,
// hay un umbral posible y queda en el medio. Si se cruzan, la distancia sola no
// alcanza para decidir y hace falta otro mecanismo.
const worstPresent = Math.max(...presentDistances);
const bestAbsent = Math.min(...absentDistances);

console.log(`\ndistancias con respuesta:  ${presentDistances.map((d) => d.toFixed(3)).join("  ")}`);
console.log(`distancias sin respuesta:  ${absentDistances.map((d) => d.toFixed(3)).join("  ")}`);
console.log(
  worstPresent < bestAbsent
    ? `separables: cualquier umbral entre ${worstPresent.toFixed(3)} y ${bestAbsent.toFixed(3)} las parte`
    : `NO separables por distancia: la peor con respuesta (${worstPresent.toFixed(3)}) cae despues de la mejor sin respuesta (${bestAbsent.toFixed(3)})`,
);

await pool.end();

// Sale con error si algo fallo, para que esto pueda ser una puerta de entrada
// a un commit y no solo un informe que nadie mira.
if (found < present.length || rejected < absent.length) process.exit(1);
