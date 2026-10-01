// Busqueda semantica sobre los pedazos indexados.
//
//   npm run search -- "por que idempotencia en las escrituras"
//
// Esta es la pieza riesgosa del proyecto y por eso se puede correr sola, sin
// modelo que genere nada: si la busqueda no trae el pedazo correcto, ningun
// modelo va a poder contestar bien por mas buen prompt que tenga.

import { config } from "./config.ts";
import { pool, toVector } from "./db.ts";
import { embedOne } from "./embed.ts";

export type Hit = {
  path: string;
  title: string;
  heading: string | null;
  content: string;
  // 0 = identico, 2 = opuesto. Es distancia, no puntaje: mas chico es mejor.
  // Despues de fusionar sigue siendo la distancia del vector, no el orden
  // final: se conserva porque es lo que decide si hay respuesta o no.
  distance: number;
  // Puntaje de la fusion. Mas grande es mejor. Solo sirve para comparar
  // resultados de una misma consulta.
  score: number;
};

// Cuantos candidatos trae cada busqueda antes de fusionar. Mas alto da mejor
// chance de rescatar algo que una sola de las dos hundio, y cuesta poco: el
// trabajo caro (el embedding de la pregunta) ya se hizo.
const POOL_SIZE = 50;

// Cuantos pedazos de una misma nota pueden ocupar lugar en el resultado. Dos
// deja contexto suficiente de la nota que acerto sin tapar a las demas.
const MAX_PER_NOTE = 2;

// Busqueda hibrida: semantica y por palabras exactas, fusionadas por posicion.
//
// La fusion es RRF (reciprocal rank fusion): cada lista aporta 1/(60 + puesto)
// y se suman. Se fusiona por PUESTO y no por puntaje a proposito — una
// distancia coseno y un ts_rank no viven en la misma escala y no se pueden
// promediar; los puestos si. El 60 es el valor del paper original: amortigua
// los primeros puestos para que un resultado unico en la cima de una lista no
// le gane a uno que aparece bien arriba en las dos.
export async function search(question: string, limit = 5): Promise<Hit[]> {
  const vector = toVector(await embedOne(question, "query"));

  const result = await pool.query<Hit>(
    `with semantic as (
       select id, row_number() over (order by embedding <=> $1) as rank
         from chunks
        order by embedding <=> $1
        limit $3
     ),
     -- La consulta de texto pide CUALQUIERA de las palabras, no todas.
     --
     -- websearch_to_tsquery y plainto_tsquery las unen con AND, que sirve para
     -- filtrar y no para buscar: "que ORM se eligio para la API y por que" se
     -- convierte en 'orm' & 'eligi' & 'api' y no hay un solo pedazo que tenga
     -- las tres. Medido: 0 resultados con AND, 666 con OR.
     --
     -- Los lexemas salen de to_tsvector, asi que ya vienen normalizados con la
     -- misma configuracion que la columna indexada: lo que se busca y lo que se
     -- indexo se parten igual. ts_rank se encarga de que el que tenga mas
     -- palabras, y mas veces, quede arriba.
     terms as (
       select string_agg(quote_literal(lexeme), ' | ')::tsquery as q
         from unnest(to_tsvector('spanish', $2))
     ),
     keyword as (
       select c.id, row_number() over (order by ts_rank(c.content_tsv, t.q) desc) as rank
         from chunks c, terms t
        where c.content_tsv @@ t.q
        order by ts_rank(c.content_tsv, t.q) desc
        limit $3
     ),
     fused as (
       select coalesce(s.id, k.id) as id,
              coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as score
         from semantic s
         full outer join keyword k on k.id = s.id
     ),
     -- Tope de pedazos por nota.
     --
     -- Sin esto una nota larga se lleva los cinco lugares con cinco pedazos
     -- suyos, y la nota que tiene la respuesta no entra por falta de espacio.
     -- Medido: la pregunta por el hook de acentos devolvia cinco veces el mismo
     -- worklog. El problema no era encontrar, era mostrar.
     ranked as (
       select n.path, n.title, c.heading, c.content,
              c.embedding <=> $1 as distance,
              -- Las notas marcadas como historia valen menos. No se excluyen:
              -- una pregunta que de verdad es sobre lo que paso un dia sigue
              -- pudiendo traer su registro, solo que tiene que ganarlo.
              f.score * (case when n.demoted then $6::float else 1 end) as score,
              row_number() over (
                partition by c.note_id
                order by f.score desc, c.embedding <=> $1
              ) as per_note
         from fused f
         join chunks c on c.id = f.id
         join notes n on n.id = c.note_id
     )
     select path, title, heading, content, distance, score
       from ranked
      where per_note <= $5
      order by score desc, distance asc
      limit $4`,
    [vector, question, POOL_SIZE, limit, MAX_PER_NOTE, config.demoteFactor],
  );

  return result.rows.map((row) => ({
    ...row,
    distance: Number(row.distance),
    score: Number(row.score),
  }));
}

// Se ejecuta solo cuando se llama al archivo directamente, no cuando lo
// importa el agente.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);

  // --k para mirar mas abajo del corte. Sirve para la pregunta de diagnostico
  // que importa cuando algo no aparece: no esta en los primeros cinco, pero
  // esta en el puesto 6 o en el 400? Son dos problemas distintos.
  const kIndex = args.indexOf("--k");
  const k = kIndex === -1 ? 5 : Number(args[kIndex + 1]);
  const question = args.filter((_, i) => i !== kIndex && i !== kIndex + 1).join(" ");

  if (!question) {
    console.error('Uso: npm run search -- [--k 20] "tu pregunta"');
    process.exit(1);
  }

  for (const [i, hit] of (await search(question, k)).entries()) {
    const where = hit.heading ? `${hit.title} > ${hit.heading}` : hit.title;
    console.log(`\n${i + 1}. [${hit.distance.toFixed(3)}] ${where}  (${hit.path})`);
    console.log(`   ${hit.content.slice(0, 180).replaceAll("\n", " ")}`);
  }

  await pool.end();
}
