// Convierte texto en vectores con un modelo que corre en esta maquina.
// Sin API key y sin costo por llamada: se puede reindexar el vault entero las
// veces que haga falta mientras se afina el cortado en pedazos.
//
// El modelo (multilingual-e5-small) se descarga la primera vez a node_modules
// y despues sale de cache. Entiende espanol, que es la mitad de la razon por la
// que esta elegido: un modelo entrenado solo en ingles encuentra mucho peor
// sobre notas en castellano.

import { pipeline } from "@huggingface/transformers";

import { config } from "./config.ts";

type Embedder = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;

let embedder: Embedder | null = null;

async function getEmbedder(): Promise<Embedder> {
  embedder ??= await pipeline("feature-extraction", config.embeddingModel);
  return embedder;
}

// La familia e5 se entreno con estos dos prefijos y los necesita: la pregunta
// y el documento no se codifican igual. Sin ellos la busqueda sigue andando,
// pero encuentra peor, y es el tipo de error que no se ve hasta medirlo.
const PREFIX = { query: "query: ", passage: "passage: " } as const;

export async function embed(
  texts: string[],
  kind: keyof typeof PREFIX,
): Promise<number[][]> {
  const model = await getEmbedder();
  const prefixed = texts.map((text) => PREFIX[kind] + text);

  // `mean` promedia los vectores de cada palabra en uno solo por texto.
  // `normalize` los deja de largo 1, que es lo que vuelve comparables las
  // distancias coseno entre dos textos de largo distinto.
  const output = await model(prefixed, { pooling: "mean", normalize: true });

  return output.tolist() as number[][];
}

export async function embedOne(text: string, kind: keyof typeof PREFIX): Promise<number[]> {
  const [vector] = await embed([text], kind);
  return vector;
}
