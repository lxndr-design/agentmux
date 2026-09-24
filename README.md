# agentmux

A multiplexer for AI coding agents: one IDE shell hosting many live agent sessions side by side, with every risky action routed through a single pinned approval column.

The full design lives in the architecture blueprint (Obvious project `prj_qiLzs4mP`, artifact `art_63DAJXgz`).

## Layout

npm workspaces:

| Path                | Package             | Purpose                                                        |
| ------------------- | ------------------- | -------------------------------------------------------------- |
| `packages/protocol` | `@agentmux/protocol`| Normalized agent-event envelope and types (shared, dependency-free) |
| `packages/daemon`   | `@agentmux/daemon`  | Host daemon: agent supervision, approval policy, event journal |
| `apps/web`          | `@agentmux/web`     | React + Vite UI shell                                          |

## Development

```sh
npm install
npm run build   # builds all workspaces (protocol first, in dependency order)
npm test        # runs vitest in all workspaces
npm run lint    # ESLint
npm run format:check
```

Note: build once before running tests — workspace packages resolve each other from their built `dist/` output.
