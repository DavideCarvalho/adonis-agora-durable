---
'@adonis-agora/durable': patch
'@adonis-agora/durable-dashboard': patch
---

Add TanStack Intent AI-agent skills

Ships seven `SKILL.md` agent skills co-located with their packages and published in the npm tarballs via a new `"skills/"` entry in each package's `files` array:

- `packages/adonis/skills/` — durable-setup, durable-workflows, durable-determinism, durable-transports-stores, durable-reliability, durable-cluster
- `packages/dashboard/skills/` — durable-observability

Each package also gains the `tanstack-intent` keyword and a devDependency on `@tanstack/intent`. Discovery artifacts (`_artifacts/domain_map.yaml`, `skill_spec.md`, `skill_tree.yaml`) live at the repo root, and `.github/workflows/check-skills.yml` validates skills on PRs.
