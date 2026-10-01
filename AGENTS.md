# vault-rag — notas para quien trabaje en este repo

Búsqueda semántica y agente de preguntas sobre una carpeta de notas en markdown.
TypeScript sobre Node 22 sin paso de compilación: los scripts corren con
`--experimental-strip-types`, así que **los imports llevan la extensión `.ts`** y
no se puede usar nada que TypeScript no borre (enums, namespaces, propiedades de
parámetro). `erasableSyntaxOnly` está encendido para que eso falle en el chequeo
de tipos y no en ejecución.

## Cómo se corre

```bash
npm run db:up        # Postgres con pgvector en Docker
npm run migrate
npm run ingest       # incremental; --all fuerza todo, --limit N acota
npm run search -- [--k 20] "una pregunta"
npm run eval
npm run ask -- "una pregunta"    # el único que necesita ANTHROPIC_API_KEY
```

## Cómo se verifica

```bash
npx tsc --noEmit     # no hay paso de build: esto es el único chequeo estático
npm run eval         # sale con código de error si baja la recuperación o el rechazo
```

No hay suite de tests ni linter. El eval cumple ese papel: es la única medida de
si un cambio mejoró o empeoró el sistema.

## La regla que no se rompe

**El agente no responde nada que no haya leído en un resultado de búsqueda, y
toda afirmación lleva al lado la nota de la que salió. Si no la encuentra, dice
que no sabe.** Vive en el prompt de `src/agent.ts` y en el corte por distancia de
`runTool`. Un cambio que la afloje deja el sistema peor que no tenerlo: un RAG
que inventa suena igual de seguro cuando acierta y cuando no.

## Qué no romper sin entender por qué está así

- **El modelo de embeddings y la dimensión del vector viajan juntos** en
  `src/config.ts`. Cambiar el modelo cambia la dimensión y obliga a una migración
  nueva y a reindexar: un vector de 384 y uno de 768 no se comparan.
- **Lo que se embebe no es lo que se guarda.** En `src/ingest.ts` el vector se
  calcula sobre `título + encabezado + cuerpo`, y se guarda el cuerpo limpio para
  poder citarlo. Sacar el título hunde la recuperación: medido, 71% a 29%.
- **Los prefijos `query:` y `passage:`** de `src/embed.ts` los pide la familia e5.
  Sin ellos la búsqueda anda igual pero encuentra peor, que es la clase de error
  que no se ve sin evals.
- **La consulta de texto pide cualquiera de las palabras, no todas.**
  `websearch_to_tsquery` y `plainto_tsquery` las unen con AND y eso filtra en vez
  de buscar: medido, 0 resultados con AND contra 666 con OR.
- **El umbral de rechazo está medido, no elegido.** Si se cambia el modelo o el
  cortado en pedazos, hay que volver a mirar las dos distribuciones que imprime
  el eval y recalcularlo. Un umbral heredado de otro modelo no significa nada.
- **`EXCLUDE_PATHS` también borra lo ya indexado.** Dejar de agregar una carpeta
  no la saca de las búsquedas.

## Sobre los evals

- `evals/questions.json` **no se versiona**: apunta a notas privadas. El repo
  lleva `evals/questions.example.json` con el formato.
- El set tiene que conservar **preguntas cuya respuesta no está en las notas**.
  Una corrida en verde a la que nunca se le dio algo que rechazar no prueba que
  el control esté encendido: prueba que no saltó, que es lo que se ve cuando está
  apagado.
- Relajar una expectativa para que el eval dé verde es hacer trampa. Corregir una
  pregunta mal formulada no lo es, y la diferencia se escribe en el commit.
- **El set actual es chico.** Con pocas preguntas, una que entra o sale mueve el
  porcentaje más que cualquier mejora: antes de afinar perillas, agregar casos.

## Qué no aplica acá y por qué

No hay servidor HTTP, ni autenticación, ni usuarios, ni integración continua. Es
una herramienta de línea de comandos de un solo usuario que corre contra una base
local. Meter capas, contratos o control de acceso sin el problema que los
justifique solo agrega código que mantener.
