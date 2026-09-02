---
'@adonis-agora/durable': minor
---

A extensão do telescope agora contribui os `@Scheduled` descobertos para a tela Live
Schedules.

Essa tela lista o que `registerSchedule()` foi informado que existe, e ninguém informava
— então ela vinha vazia. A alternativa era o app repetir a lista à mão, uma cópia dos
decorators que diverge na primeira mudança de cron, em silêncio.

O engine já tem a lista: `discoveredSchedules` **é** o que o `@Scheduled` declarou. A
extensão responde o novo hook `schedules()` do telescope com ela, então o console mostra
os decorators e não uma cópia deles. Segue sem importar `@adonis-agora/telescope`: é mais
um método do contrato que o `telescope-sdk.ts` já espelha estruturalmente.

Requer `@adonis-agora/telescope` com o hook `schedules()`.
