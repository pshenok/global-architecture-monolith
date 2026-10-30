# gam-platform (Claude Code plugin)

Skills that teach Claude Code (and developers) how to build on the
global-architecture-monolith platform. They are the executable part of the platform
specification.

| Skill                      | Use it for                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| `gam-architecture`         | the map: layout, layers, conventions, which skill to use           |
| `gam-new-module`           | a new feature module from the template                             |
| `gam-module-api`           | a module's public API: `@ModuleApi` facades, event types, REST     |
| `gam-domain-logic`         | aggregates, invariants, use cases, ports, errors                   |
| `gam-database`             | schema per module, Drizzle, migrations, constraints, transactions  |
| `gam-module-communication` | calls between modules, no shared transactions, in-process events   |
| `gam-http-endpoint`        | REST routes in a module, `@Access`, OpenAPI, problem+json          |
| `gam-testing`              | unit, use-case, HTTP + Postgres, events, app, e2e                  |
| `gam-local-stack`          | run and debug everything locally, tokens, roles, events CLI        |
| `gam-code-review`          | review checklist                                                   |
| `gam-platform-maintenance` | dependency upgrades, kit/template changes, guardrails, sharp edges |

## Install

Inside this repository the skills load automatically (`.claude/skills` links to them).
To use them in another project (you need read access to this GitHub repository):

```text
/plugin marketplace add pshenok/global-architecture-monolith
/plugin install gam-platform@global-architecture-monolith
```

The skill files live only here (`plugins/gam-platform/skills`); `.claude/skills/*` are
symlinks, so there is one source of truth. Edit the files here, in the same PR as the
convention they document.
