---
'@adonis-agora/durable': minor
---

Adiciona `consumers: 'never'`: o processo vira um produtor puro — despacha runs e lê o store, mas nunca inicia os consumer loops do broker, em qualquer ambiente. Para frotas web que dividem um Redis com o `durable:work`, eliminando a corrida por entregas ponto-a-ponto (tasks, resultados, heartbeats); o worker reabilita o consumo para si via `engine.startConsumers()`.
