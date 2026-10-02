// Reordena los candidatos con un segundo modelo, de otra clase que el primero.
//
// La diferencia es cual es la pregunta que contesta cada uno:
//
//   el de embeddings  convierte la pregunta y el texto por separado y compara
//                     los dos vectores. Rapido, porque los textos ya estaban
//                     convertidos de antes, pero el texto se codifico sin saber
//                     que le iban a preguntar.
//
//   el de reordenado  lee la pregunta Y el texto juntos, en una sola pasada, y
//                     dice que tan bien uno contesta al otro. Mucho mas caro:
//                     hay que correrlo una vez por candidato y no se puede
//                     precalcular. Por eso no reemplaza al primero, va despues:
//                     el primero baja de miles a veinte, el segundo ordena esos
//                     veinte.
//
// El puntaje que devuelve no tiene escala fija —son logits, salen negativos—
// y solo sirve para comparar candidatos de una misma pregunta.

import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";

import { config } from "./config.ts";

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

let loaded: { tokenizer: Tokenizer; model: Model } | null = null;

async function load() {
  loaded ??= {
    tokenizer: await AutoTokenizer.from_pretrained(config.rerankModel),
    model: await AutoModelForSequenceClassification.from_pretrained(config.rerankModel, {
      dtype: "q8",
    }),
  };
  return loaded;
}

const BATCH = 8;

// Devuelve un puntaje por pasaje, en el mismo orden en que entraron.
export async function rerank(question: string, passages: string[]): Promise<number[]> {
  if (passages.length === 0) return [];

  const { tokenizer, model } = await load();
  const scores: number[] = [];

  for (let i = 0; i < passages.length; i += BATCH) {
    const batch = passages.slice(i, i + BATCH);

    // `truncation` no es opcional: un pedazo largo pasa del limite del modelo y
    // la llamada falla en vez de recortar sola.
    const inputs = tokenizer(
      batch.map(() => question),
      { text_pair: batch, padding: true, truncation: true },
    );

    const { logits } = await model(inputs);
    scores.push(...(logits.tolist() as number[][]).map((row) => row[0]));
  }

  return scores;
}
