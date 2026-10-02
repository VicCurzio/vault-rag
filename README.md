# vault-rag

Busqueda semantica y agente de preguntas sobre una carpeta de notas en markdown.
Node, TypeScript y PostgreSQL con pgvector. Los embeddings se calculan en la
propia maquina: no hace falta API key ni tarjeta para indexar ni para buscar.

> **La regla del proyecto:** el agente nunca responde algo que no haya leido en
> las notas, y toda afirmacion viene con la nota de la que salio. Si no lo
> encuentra, dice que no sabe.

## Como corre

```bash
cp .env.example .env     # completar VAULT_PATH
npm install
npm run db:up            # Postgres con pgvector en Docker, puerto 55432
npm run migrate
npm run ingest           # la primera vez descarga el modelo (~120 MB)
npm run search -- "por que el build no corre en produccion"
npm run eval
```

Para que el agente genere respuestas hace falta `ANTHROPIC_API_KEY` en `.env`:

```bash
npm run ask -- "que decidimos sobre el ORM y por que"
```

`search` y `eval` corren sin esa clave. Es a proposito: la parte medible del
sistema no depende de un servicio pago.

## Que hace cada pieza

| Archivo | Que resuelve |
|---|---|
| `src/chunk.ts` | Parte cada nota por titulos, con un tope de tamano y solape entre pedazos |
| `src/embed.ts` | Convierte texto en vectores con un modelo local multilingue |
| `src/ingest.ts` | Recorre el vault y guarda pedazos y vectores; saltea lo que no cambio |
| `src/search.ts` | Busca por distancia coseno y devuelve los fragmentos mas cercanos |
| `src/agent.ts` | El loop de herramientas: el modelo busca, lee y vuelve a buscar |
| `evals/run.ts` | Mide recuperacion y rechazo; sale con error si bajan |

## Por que esta armado asi

- **Embeddings locales.** Indexar el vault entero no cuesta nada, asi que se
  puede reindexar cuantas veces haga falta mientras se afina el cortado en
  pedazos. Es la decision que hace barato equivocarse.
- **El modelo es multilingue.** Las notas estan en castellano; uno entrenado
  solo en ingles recupera bastante peor, y es un error que no se ve hasta
  medirlo.
- **La dimension del vector vive al lado del nombre del modelo** en
  `src/config.ts`. Cambiar el modelo cambia la dimension y obliga a una
  migracion nueva: un vector de 384 y uno de 768 no se comparan.
- **Primero la busqueda, despues el agente.** Si la busqueda no trae el pedazo
  correcto, ningun prompt lo arregla. Por eso `search` y `eval` existen y se
  pueden correr solos.
- **Los evals tienen casos que el sistema tiene que fallar**: preguntas cuya
  respuesta no esta en las notas. Una corrida verde donde nunca se le dio algo
  que rechazar no prueba que el control este encendido.

## Lo que midio, y lo que eso enseno

Primera corrida sobre 340 notas y 5338 pedazos:

| Cambio | recall@5 | rechazo |
|---|---|---|
| Version inicial | 29% | 0% |
| El pedazo se embebe con su titulo y encabezado adelante | **71%** | 0% |
| Umbral de rechazo medido en vez de estimado | 71% | **100%** |
| Busqueda hibrida (semantica + palabras exactas) | 71% | 100% |
| Set de evals de 9 a 34 preguntas | 79% | 100% |
| Tope de dos pedazos por nota | 79% | 100% |
| Menos peso a las notas de registro diario | **89%** | 100% |

Las tres primeras filas se midieron con nueve preguntas, que es muy poco: una
que entra o sale mueve el numero catorce puntos. De la cuarta en adelante son
treinta y cuatro. **El 79% y el 71% no se comparan**: cambio la vara.

Tres cosas que solo aparecieron por medir:

1. **El pedazo no sabia de que nota salia.** La seccion "Contexto" del documento
   que elige una herramienta no nombra esa herramienta en ningun lado, asi que
   su vector era indistinguible del "Contexto" de cualquier otro documento.
   Embeber el titulo junto al cuerpo subio el acierto de 29% a 71%, con un solo
   cambio.
2. **El umbral de rechazo estaba puesto a ojo.** Se suponia que las distancias
   se repartian por todo el rango; este modelo las comprime entre 0.11 y 0.20,
   asi que el corte original no se disparaba nunca. El numero nuevo salio de
   imprimir las dos distribuciones y elegir el medio.
3. **La busqueda por palabras arrancó devolviendo cero.** `websearch_to_tsquery`
   une los terminos con AND: una pregunta de siete palabras exige que las siete
   esten en el mismo pedazo. Medido: 0 resultados con AND, 666 con OR.

Y dos que aparecieron al agrandar el set:

4. **Una sola nota se llevaba los cinco lugares**, con cinco pedazos suyos, y la
   nota que tenia la respuesta no entraba por falta de espacio. El tope por nota
   arreglo eso **sin mover el recall**: los lugares liberados se los llevaron
   otras notas equivocadas. Se mantiene igual, porque el agente recibia el mismo
   texto cinco veces, pero no hay que contarlo como una mejora de recuperacion.
5. **El registro diario se come todo.** Son el 41% de las notas, son largos y
   repiten el vocabulario del proyecto, asi que las notas cortas y al grano
   pierden siempre. Bajarles el peso subio el recall de 86% a 89%.

El factor de ese ultimo cambio se eligio midiendo, no a ojo: 1.0 da 86%, la
meseta entre 0.8 y 0.5 da 89%, y 0.3 cae a 82%. **Las dos preguntas que se
rompen en 0.3 son exactamente las dos cuya respuesta vive en un registro
diario**, que es lo que uno predeciria si el mecanismo hace lo que dice.

## La busqueda hibrida, aislada

`HYBRID=0` apaga la rama de palabras exactas y deja solo la semantica. Medido
sobre el mismo set:

| | recall@5 |
|---|---|
| Solo semantica | 82% |
| Hibrida | **89%** |

Arregla tres preguntas y rompe una. Las tres que arregla tienen la misma forma:
**dependen de un termino literal** — "accesibilidad", "CV", "semi senior". El
vector entiende el tema pero borronea las palabras; el indice de texto no
entiende nada, pero esas las encuentra siempre. Por eso van las dos y no una.

Vale la pena notar que con el set chico de nueve preguntas esta misma hibrida
parecia no aportar nada. No cambio el sistema: cambio la vara.

## Lo que se probo y no quedo: reordenar con un segundo modelo

`src/rerank.ts` existe y anda, pero **esta apagado** (`RERANK=1` lo enciende).
Es un modelo de otra clase: en vez de convertir pregunta y texto por separado y
comparar vectores, los lee juntos y dice que tan bien uno contesta al otro. Es
la mejora que recomienda todo el mundo para esta etapa.

| | recall@5 | costo |
|---|---|---|
| Sin reordenar | **89%** | nada |
| Reordenando 20 candidatos | 89% | 20 pasadas de modelo por pregunta |
| Reordenando 40 candidatos | 86% | 40 pasadas |

**No mejora: baraja.** Con 40 candidatos la pregunta sobre el ORM empieza a
aparecer, pero se rompen otras tres. Un modelo que cuesta veinte veces mas y
devuelve el mismo numero no entra encendido.

En el camino volvio a aparecer el mismo error de antes, mas adelante en la
cadena: la primera version le pasaba al reordenador **el cuerpo del pedazo sin
el titulo de la nota**, y eso solo bajo el recall de 89% a 68%. Un fragmento
suelto no dice de que nota salio, lo lea quien lo lea.

Lo que no se probo: el modelo corre cuantizado a 8 bits. Sin cuantizar seria
bastante mas lento y podria ordenar mejor; queda como pregunta abierta, no como
conclusion.

## Estado

Indexacion incremental, busqueda hibrida con tope por nota y menos peso al
registro diario, agente con una herramienta y evals de
recuperacion. Pendiente: evals sobre la respuesta generada (no solo sobre lo que
se recupera), reordenamiento de resultados, y mas preguntas antes de seguir
tocando perillas.

Las preguntas de evaluacion apuntan a notas privadas, asi que el repo lleva
`evals/questions.example.json` con el formato y no el set real.
