-- Esquema inicial: notas, pedazos y sus vectores.
--
-- La dimension 384 la fija el modelo de embeddings (multilingual-e5-small).
-- Si se cambia el modelo, cambia la dimension y hay que escribir otra
-- migracion: un vector de 384 y uno de 768 no se pueden comparar.

create extension if not exists vector;

-- Catalogo: una fila por archivo del vault.
-- `hash` es lo que permite saltear una nota que no cambio desde la ultima
-- indexacion, que es lo caro (calcular embeddings).
create table notes (
  id          bigserial primary key,
  path        text        not null unique,
  title       text        not null,
  hash        text        not null,
  indexed_at  timestamptz not null default now()
);

-- Los pedazos en los que se parte cada nota. El embedding vive al lado del
-- texto a proposito: la busqueda devuelve el contenido en el mismo viaje y no
-- hay que ir a buscar el archivo al disco para citarlo.
create table chunks (
  id        bigserial     primary key,
  note_id   bigint        not null references notes(id) on delete cascade,
  ord       int           not null,
  heading   text,
  content   text          not null,
  embedding vector(384)   not null,
  unique (note_id, ord)
);

-- HNSW con distancia coseno: es la que corresponde a embeddings normalizados.
-- Sin este indice la busqueda funciona igual, pero recorre la tabla entera.
create index chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);
