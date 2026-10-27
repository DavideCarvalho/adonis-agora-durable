---
"@adonis-agora/durable": patch
---

A result that lands right after the turn that sent its step suspended resumes the run once. The
instance that settles a step and resumes its run now remembers it for a lease, and the suspended
turn's re-check of that step, which found it settled and resumed the run again, leaves it to that
resume. A remote workflow's re-check, whose decision may postdate that resume, and a re-check on any
other instance still re-drive the run.
