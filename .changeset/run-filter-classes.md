---
'@adonis-agora/durable': minor
'@adonis-agora/durable-dashboard': minor
---

Filtros do console sobre o `@adonis-agora/filter` no estilo unificado: a listagem, os pickers e o bulk falam o envelope `filter[...]` construído com as classes do `filter-client` (`new FilterQueryBuilder()`, pickers via `.groupByCount()`), e o servidor os serve com a classe `RunFilter` (`BaseFilter<RunQueryDraft>`, um método por chave) — listagem via `applyCustomFilter`, valores via `groupByCountFromRequest` com o adapter do console. A grafia plana (`?tag=&attr=key:op:value`) continua valendo pelo mesmo pipeline; atributos viajam opacos (`filter[attr]=key:op:value`) porque as chaves são dinâmicas. Filtro estruturado recusado responde `400` em vez de alargar em silêncio. Requer `@adonis-agora/filter@0.9.0` e `@adonis-agora/filter-client@0.3.0`.
