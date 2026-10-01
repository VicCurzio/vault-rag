-- Marca las notas que son historia y no estado.
--
-- En un vault de notas conviven dos cosas distintas: las notas durables, que
-- dicen lo que es cierto hoy, y el registro diario, que dice lo que paso. Para
-- una pregunta del tipo "por que se decidio X", la respuesta vive en la nota
-- durable; el registro apenas la menciona de paso, pero es mucho mas largo,
-- repite el vocabulario del proyecto y hay uno por dia. Gana por volumen.
--
-- La marca no excluye: baja el puntaje. Una pregunta que de verdad es sobre lo
-- que paso un dia sigue pudiendo traer su registro.

alter table notes
  add column demoted boolean not null default false;
