// Corta una nota en pedazos indexables.
//
// Por que no se indexa la nota entera: un embedding es un solo vector por
// texto. Si el texto es largo, ese vector termina siendo el promedio de todos
// los temas de la nota y no se parece de verdad a ninguno. Pedazos chicos
// buscan mejor. Demasiado chicos pierden el contexto y la respuesta queda
// cortada, asi que el tamano es la primera perilla a tocar cuando los evals
// den mal.

const MAX_CHARS = 1200;
const OVERLAP_CHARS = 150;

export type Chunk = {
  ord: number;
  heading: string | null;
  content: string;
};

export type ParsedNote = {
  title: string;
  chunks: Chunk[];
};

function stripFrontmatter(raw: string): string {
  return raw.startsWith("---") ? raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : raw;
}

// Corta un bloque largo en trozos con solape. El solape existe para que una
// idea que cae justo en el borde no quede partida en dos mitades que por
// separado no significan nada.
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + MAX_CHARS, text.length);

    // Preferimos cortar en un fin de parrafo antes que en medio de una frase.
    if (end < text.length) {
      const breakAt = text.lastIndexOf("\n\n", end);
      if (breakAt > start + MAX_CHARS / 2) end = breakAt;
    }

    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }

  return parts.filter((part) => part.length > 0);
}

export function parseNote(raw: string, fallbackTitle: string): ParsedNote {
  const body = stripFrontmatter(raw);
  const lines = body.split(/\r?\n/);

  let title = fallbackTitle;
  let heading: string | null = null;
  let buffer: string[] = [];
  const sections: { heading: string | null; text: string }[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) sections.push({ heading, text });
    buffer = [];
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const [, hashes, text] = match;
      // El `# titulo` de arriba de todo es el nombre de la nota, no una
      // seccion: se usa como titulo y no abre un pedazo propio.
      if (hashes.length === 1 && title === fallbackTitle) title = text.trim();
      heading = text.trim();
      continue;
    }
    buffer.push(line);
  }

  flush();

  const chunks: Chunk[] = [];

  for (const section of sections) {
    for (const part of splitLong(section.text)) {
      chunks.push({ ord: chunks.length, heading: section.heading, content: part });
    }
  }

  return { title, chunks };
}
