---
'@adonis-agora/durable': minor
---

Adiciona `namespace` em `ScheduledWorkflow`/`static schedule`: a janela disparada nasce carimbada com o pool nomeado, independentemente de qual `durable:work` ganhou a corrida do tick. Sem isto, uma schedule colocada é descoberta por TODOS os pools que carregam o workflow, e um pool sem a capacidade exigida pelos steps (ex.: o worker de chat, sem Chrome) pode criar o run no próprio namespace — onde ninguém serve as filas dos steps, e a janela morre em `RemoteStepTimeout`/erro de binário ausente. O pin não toca no run-id (ainda o bucket de tempo): a garantia exactly-once entre instâncias correndo o mesmo tick é preservada, e a verificação de namespace do `resume` já garante que só o pool-alvo pega o run. `namespace` ausente = comportamento histórico (herda o namespace do engine que dispara).

O pin também fica visível: a extensão de telescope agora reporta `namespace` como `pool` do schedule (mirror estrutural do `ScheduleContribution` do `@adonis-agora/telescope`), então a tela Live Schedules mostra para qual pool cada agenda manda seus runs.
