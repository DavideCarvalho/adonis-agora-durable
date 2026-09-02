---
'@adonis-agora/durable': patch
---

O link "abrir este run" do dashboard do telescope levava a um 404.

O default era `/durable/runs/{runId}`, errado em duas coisas: o console é um SPA roteado
por **hash** (`App.tsx` casa `window.location.hash` contra `#/run/<id>`), então um caminho
comum nunca chega nele — quem responde é o router do app, com 404 — e o segmento estava no
**plural** contra o singular que o SPA espera.

Agora o default é `/durable#/run/{runId}`. Quem monta o console em outro path continua
passando o seu via `runHref`, porque o template precisa carregar o mount path e este
módulo não tem como sabê-lo.
