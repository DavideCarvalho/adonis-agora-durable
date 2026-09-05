---
'@adonis-agora/durable': patch
---

Salva timeout espúrio de step remoto cujo resultado já foi gravado: no vencimento da janela de liveness, o engine re-lê o checkpoint — concluído, resolve com o output gravado em vez de estourar `RemoteStepTimeout`. Cobre o caso de fila de resultados compartilhada (web+worker), onde outra instância consome o resultado e completa o checkpoint sem resolver o await in-memory de quem despachou.
