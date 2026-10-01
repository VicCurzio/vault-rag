// El agente: el loop completo, sin framework.
//
// Son pocas lineas a proposito. Un agente es esto y nada mas:
//
//   1. se le manda la pregunta y la lista de herramientas que puede usar
//   2. el modelo contesta "usa esta herramienta con estos argumentos"
//   3. nosotros la ejecutamos y le devolvemos el resultado
//   4. vuelve al paso 2 hasta que contesta con texto en vez de pedir otra
//
// La diferencia entre esto y pegarle los documentos a la pregunta es que acá
// decide el modelo: puede buscar, leer lo que vino, y volver a buscar con
// otras palabras si lo que trajo no alcanza.

import Anthropic from "@anthropic-ai/sdk";

import { config } from "./config.ts";
import { search } from "./search.ts";

// La regla central del proyecto, escrita donde se aplica. Si esto se afloja,
// el sistema deja de servir: un RAG que inventa es peor que no tener nada,
// porque suena igual de seguro cuando acierta y cuando no.
const SYSTEM = `Respondes preguntas sobre las notas personales de alguien, usando unicamente la herramienta search_vault.

Reglas que no se rompen:
- Nunca respondes algo que no hayas leido en un resultado de search_vault.
- Toda afirmacion lleva al lado la nota de la que salio, entre parentesis, con su ruta.
- Si lo que buscaste no alcanza, buscas otra vez con otras palabras (hasta 4 busquedas).
- Si despues de buscar no esta la respuesta, decis exactamente: "No encontre eso en las notas." y nada mas. No completas con lo que sabes del mundo.
- No inventas rutas de notas.

Respondes corto y directo, en español.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_vault",
    description:
      "Busca por significado en las notas y devuelve los fragmentos mas parecidos a la consulta. " +
      "Funciona mejor con una frase que describa la idea buscada que con una sola palabra suelta.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Lo que se quiere encontrar, en lenguaje natural." },
        limit: { type: "number", description: "Cuantos fragmentos traer. Por defecto 5." },
      },
      required: ["query"],
    },
  },
];

async function runTool(input: { query: string; limit?: number }): Promise<string> {
  const all = await search(input.query, input.limit ?? 5);

  // El corte por distancia se aplica aca y no en search(): la busqueda cruda
  // sirve para medir y para explorar, y queremos verla sin filtrar. Lo que no
  // puede pasar es que un fragmento lejano llegue al modelo pareciendo una
  // fuente, porque entonces contesta con eso.
  const hits = all.filter((hit) => hit.distance <= config.absentThreshold);

  if (hits.length === 0) {
    return all.length === 0
      ? "Sin resultados."
      : `Sin resultados suficientemente cercanos (el mas parecido quedo a ${all[0].distance.toFixed(3)}, y el corte es ${config.absentThreshold}). No hay respuesta a esto en las notas.`;
  }

  return hits
    .map((hit, i) => {
      const where = hit.heading ? `${hit.title} > ${hit.heading}` : hit.title;
      return `[${i + 1}] ${where}\nruta: ${hit.path}\ndistancia: ${hit.distance.toFixed(3)}\n${hit.content}`;
    })
    .join("\n\n---\n\n");
}

export type AgentResult = {
  answer: string;
  searches: string[];
};

export async function ask(question: string, maxTurns = 6): Promise<AgentResult> {
  if (!config.anthropicApiKey) {
    throw new Error("Falta ANTHROPIC_API_KEY en .env (la busqueda y los evals no la necesitan).");
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const searches: string[] = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await client.messages.create({
      model: config.answerModel,
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((block) => block.type === "tool_use");

    // Sin pedidos de herramienta, el modelo ya contesto: el loop termina.
    if (toolUses.length === 0) {
      const answer = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { answer, searches };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      const input = use.input as { query: string; limit?: number };
      searches.push(input.query);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: await runTool(input),
      });
    }

    messages.push({ role: "user", content: results });
  }

  // Un tope de vueltas no es decoracion: sin el, un modelo que se traba
  // buscando lo mismo gasta hasta que alguien lo corta a mano.
  return { answer: "Me quede sin vueltas de busqueda sin llegar a una respuesta.", searches };
}
