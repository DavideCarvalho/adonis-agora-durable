---
'@adonis-agora/durable': minor
---

O tick diz o que ele é: trabalho de scheduler, e sondagem que não vale entry

O worker dá um tick por segundo, e cada tick faz quatro leituras que só perguntam ao
store "tem trabalho?". Numa janela medida de 12h em produção elas viraram 182.868 das
320.754 entries do telescope daquele app — 57% de tudo, contra 6.363 queries do app
inteiro. O laço não estava caro no banco (4 queries/s a ~1,2ms), estava caro na atenção
de quem precisa ler o painel.

Duas marcações, e a diferença entre elas é o ponto:

- as quatro leituras de sondagem (`listPendingRuns`, `listIncompleteRuns`,
  `listDueTimers` e o `listRuns` dos `blocked`) rodam dentro de `asHeartbeat` — uma
  ferramenta de observabilidade pode descartá-las;
- o tick inteiro roda dentro de `withScheduleOrigin`, então o que ele ENCONTRA é gravado
  dizendo de onde veio, em vez do genérico "manual".

O limite é estreito de propósito: a sonda some, o trabalho que ela acha fica. Lease,
checkpoint e resultado da run continuam registrados — é isso que alguém abre o console
para ver quando um workflow trava.

Nada disso cria dependência: o driver é lido do slot global
`Symbol.for('@agora/telescope:origin-scope')` de forma estrutural, exatamente como o
`protocol.ts` já lê o `@adonis-agora/context`. Sem telescope instalado, tudo roda direto.
