---
'@adonis-agora/durable': patch
---

O tick do agendador para de perguntar ao banco o que já sabe.

O run id de um schedule é derivado da **janela** de disparo, então ele é constante
durante toda ela. Mesmo assim, cada tick fazia `getRun` naquele id — uma consulta cuja
resposta não podia ter mudado desde o tick anterior.

Numa instalação real isso deu **~28 `select … where id = ?` por segundo** (14 schedules
× 2 lookups × 2 pods), todos devolvendo a linha que o processo já tinha buscado. Um cron
horário não está vencido em 3.599 dos 3.600 segundos, e o antigo perguntava em todos.

Agora cada processo memoiza os ids que já observou existir, e o tick não faz I/O nenhum
quando não há janela nova. A checagem de `overlap: 'skip'` também saiu do caminho quente:
ela só importava quando havia algo a iniciar, e rodava a cada tick.

**A idempotência entre workers não muda.** A memoização só pula trabalho que aquele
processo viu acontecer; ela nunca é consultada para um id que ele não observou. Processo
novo, e o primeiro tick de cada janela nova, continuam indo ao store — que é onde a
corrida entre workers concorrentes é decidida. Há teste para isso.
