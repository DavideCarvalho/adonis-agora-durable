---
'@adonis-agora/durable': minor
'@adonis-agora/durable-dashboard': minor
---

Console passa a filtrar por selects com autocomplete e texto: os filtros de tag, tenant e atributos do dashboard viram value pickers — listam o que os runs realmente contêm (contados no servidor, com busca e paginação), aceitam vários valores por eixo e aceitam valor digitado. Inclui o endpoint `GET /runs/values`, filtros multi-valor em `RunQuery` (`workflows`/`tags`/`namespaces`, operador `in` nos atributos) e a enumeração `runValueFacets` nos stores Lucid e in-memory — o mesmo comportamento do console do nestjs-durable.
