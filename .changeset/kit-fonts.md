---
'@adonis-agora/durable-dashboard': patch
'@adonis-agora/durable': patch
---

Console: the bundled Sora and JetBrains Mono fonts load again. The build dropped their `@font-face` rules (`sideEffects: false`), and their URLs inside the CSS kept the unmounted base path; the console fell back to system fonts.
