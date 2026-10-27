---
"@adonis-agora/durable": patch
---

A step fan's join barrier asks whether any step is still pending instead of counting them. Every
batch of results asked for a `COUNT(*)` over the fan's whole seq range, about 40 ms on a
40,000-step fan in MySQL, from every instance settling results. Stores get an optional
`hasCheckpoints` that reads from the top of the range down and stops at the first match (a fan's
highest seqs settle last): about 0.4 ms on the same fan. The Lucid and in-memory stores implement
it and `CodecStateStore` forwards it; a store without it is asked `countCheckpoints` as before.
