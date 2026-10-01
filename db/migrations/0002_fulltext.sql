-- Busqueda por palabras exactas, al lado de la semantica.
--
-- Por que hace falta las dos: el vector entiende el tema pero borronea los
-- terminos. Una pregunta por "ORM" se parece igual a veinte notas que hablan
-- de bases de datos, y la que dice "ORM" literal no gana por decirlo. El
-- indice de texto es exactamente lo contrario: no entiende nada, pero las
-- siglas, los nombres propios y los codigos los encuentra siempre.
--
-- La columna es `generated`: Postgres la mantiene sola en cada insert y update,
-- asi que no hay forma de que quede desincronizada del contenido.
--
-- 'spanish' hace que "decisiones" y "decidio" caigan en la misma raiz. Si las
-- notas fueran en ingles, esta configuracion los dejaria como palabras
-- distintas y la busqueda empeoraria sin avisar.

alter table chunks
  add column content_tsv tsvector
  generated always as (
    to_tsvector('spanish', coalesce(heading, '') || ' ' || content)
  ) stored;

create index chunks_content_tsv_idx on chunks using gin (content_tsv);
