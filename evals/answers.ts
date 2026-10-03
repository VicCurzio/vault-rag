// Evals sobre la RESPUESTA, no sobre lo que se recupera.
//
//   npm run eval:answers            las 34 preguntas
//   npm run eval:answers -- --limit 5
//
// Necesita ANTHROPIC_API_KEY: es el unico eval que llama al modelo.
//
// Por que no hay un modelo juez. Lo habitual es pedirle a otro modelo que
// puntue la respuesta, y es caro, lento y opinable. Pero la regla de este
// proyecto no es "que conteste bien" —eso no se puede medir sin criterio—, es
// **que no invente y que cite**. Y eso es verdadero o falso:
//
//   cita          la respuesta nombra al menos una nota
//   la nota vive  esa ruta existe de verdad en el indice
//   se la dieron  esa ruta estaba entre las que le mostro la busqueda
//   se planta     ante una pregunta sin respuesta, dice que no sabe
//
// Las cuatro se chequean sin pedirle opinion a nadie. Un eval con juez mide si
// la respuesta suena bien; este mide si el sistema cumple su propia regla, que
// es lo unico que prometio.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ask } from "../src/agent.ts";
import { config } from "../src/config.ts";
import { pool } from "../src/db.ts";

type Case = { question: string; expect: string | string[] | null };

const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex === -1 ? Infinity : Number(args[limitIndex + 1]);

if (!config.anthropicApiKey) {
  console.error(
    "Falta ANTHROPIC_API_KEY en .env. Es el unico eval que la necesita;\n" +
      "`npm run eval` mide la recuperacion y corre gratis.",
  );
  process.exit(1);
}

const cases: Case[] = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "questions.json"), "utf8"),
)
  .filter((item: Partial<Case>) => typeof item.question === "string")
  .slice(0, limit);

// Las rutas se reconocen por terminar en .md. Es deliberadamente simple: si el
// modelo cita de otra forma, el eval lo cuenta como "no cito", que es
// exactamente lo que queremos que pase — la instruccion le pide la ruta.
//
// Los parentesis NO van en el patron, aunque las citas vengan entre parentesis.
// Con ellos adentro el patron se come el renglon entero y cierra en el ultimo
// .md, asi que "A (a/b.md) y B (c/d.md)" contaba UNA cita en vez de dos. Lo
// agarro un caso de prueba antes de gastar una sola llamada al modelo.
const RUTA = /[\w .\-/]+\.md/g;

const citadas = (texto: string) => [...new Set(texto.match(RUTA) ?? [])].map((r) => r.trim());

// Una respuesta cuenta como "se planto" si dice que no encontro nada y no
// nombra ninguna nota. Las dos cosas: decir que no sabe y ademas citar algo
// seria peor que cualquiera de las dos por separado.
const sePlanto = (texto: string) =>
  /no encontr[eé]/i.test(texto) && citadas(texto).length === 0;

const existentes = new Set(
  (await pool.query<{ path: string }>("select path from notes")).rows.map((r) => r.path),
);

const conRespuesta = cases.filter((c) => c.expect !== null);
const sinRespuesta = cases.filter((c) => c.expect === null);

let cito = 0;
let rutasVivas = 0;
let rutasDadas = 0;
let acerto = 0;
let plantado = 0;

console.log(`${conRespuesta.length} preguntas con respuesta:\n`);

for (const item of conRespuesta) {
  const { answer, sources } = await ask(item.question);
  const rutas = citadas(answer);
  const esperadas = Array.isArray(item.expect) ? item.expect : [item.expect!];

  const ok = {
    cito: rutas.length > 0,
    viven: rutas.length > 0 && rutas.every((r) => existentes.has(r)),
    dadas: rutas.length > 0 && rutas.every((r) => sources.includes(r)),
    acerto: rutas.some((r) => esperadas.some((e) => r.includes(e))),
  };

  if (ok.cito) cito += 1;
  if (ok.viven) rutasVivas += 1;
  if (ok.dadas) rutasDadas += 1;
  if (ok.acerto) acerto += 1;

  const marca = [
    ok.cito ? "cita" : "SIN CITA",
    ok.viven ? "vive" : "RUTA INVENTADA",
    ok.dadas ? "se la dieron" : "NO SE LA DIERON",
    ok.acerto ? "acerto" : "otra nota",
  ].join(" · ");

  console.log(`  [${marca}]\n    ${item.question}`);
  if (!ok.viven || !ok.dadas) console.log(`    cito: ${rutas.join(", ") || "(nada)"}`);
}

console.log(`\n${sinRespuesta.length} preguntas sin respuesta en las notas:\n`);

for (const item of sinRespuesta) {
  const { answer } = await ask(item.question);
  const ok = sePlanto(answer);
  if (ok) plantado += 1;

  console.log(`  [${ok ? "se planto" : "INVENTO"}] ${item.question}`);
  if (!ok) console.log(`    respondio: ${answer.slice(0, 160).replaceAll("\n", " ")}`);
}

const pct = (n: number, total: number) => (total === 0 ? "-" : `${((n / total) * 100).toFixed(0)}%`);
const n = conRespuesta.length;

console.log(`\n-----`);
console.log(`cita alguna nota:        ${cito}/${n} (${pct(cito, n)})`);
console.log(`la nota citada existe:   ${rutasVivas}/${n} (${pct(rutasVivas, n)})`);
console.log(`se la habia mostrado:    ${rutasDadas}/${n} (${pct(rutasDadas, n)})`);
console.log(`cito la nota esperada:   ${acerto}/${n} (${pct(acerto, n)})`);
console.log(
  `se planto sin inventar:  ${plantado}/${sinRespuesta.length} (${pct(plantado, sinRespuesta.length)})`,
);

await pool.end();

// Las tres primeras son la regla del proyecto y no admiten excepcion: una ruta
// inventada o una respuesta sin fuente es el modo de falla que el sistema
// existe para evitar. "Cito la nota esperada" NO corta la corrida: ahi se
// mezcla la recuperacion, que ya tiene su propio eval, y una respuesta correcta
// sacada de otra nota no es una falla del agente.
const regla = cito === n && rutasVivas === n && rutasDadas === n && plantado === sinRespuesta.length;
if (!regla) process.exit(1);
