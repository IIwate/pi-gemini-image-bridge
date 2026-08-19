# Repository instructions

This file is the repository-level execution guide and the single source of truth for agent instructions. It routes work to the documents that own product and architecture facts; it does not duplicate those facts.

## Read before changing code

- Before changing `src/`, read the [architecture map](docs/architecture/index.md) and the target module's source; the pipeline is small, so reading the two adjacent modules is sufficient context.
- Before changing product behavior (relay gate, relay ordering, scope), read [architecture decisions](docs/architecture/decisions.md) (D14, D16). Decision changes and implementation must move together.
- Before touching user-facing docs, read [README.md](README.md) — it owns background, usage, verification, and known limits.
- Read the defensive notes in [architecture map](docs/architecture/index.md) before lifecycle, event-loop, or Pi host interaction work.

## Repository map

```text
src/index.ts       Composition root: registers the request-scoped pi.on("context") relay
src/core/          Pure logic, zero Pi coupling
  tool-image-relay.ts  Moves toolResult images into a transient user attachment view
test/              node:test unit tests for the relay contract
docs/architecture/ System map, data flow, and module contracts
  decisions.md    Confirmed product decisions (D8, D14, D16; D1–D13/D15 retracted)
README.md         Background, usage, verification, known limits
CONTEXT.md        Domain vocabulary only; carries no architecture rationale
```

Each core module has a single job, a serializable contract, and no reverse dependency. `src/index.ts` is the only place that touches the Pi extension API; core modules are plain functions.

## Documentation ownership

- `README.md` owns background, usage, verification steps, and known limits.
- `docs/architecture/decisions.md` owns confirmed product decisions (active: D8, D14, D16).
- `docs/architecture/index.md` owns the system map, data-flow direction, and module contracts.
- `CONTEXT.md` owns domain vocabulary only; it does not own architecture rationale.
- `AGENTS.md` owns workflow, routing, and repository-wide engineering rules.
- Code comments and JSDoc own only local, non-obvious implementation obligations.

Keep one authoritative home for each fact. Other documents link to that authority instead of restating it. Update the owning document with every behavior or architecture change.

## Defensive change entry points

- Relay behavior (gate, batching, image-only placeholder text): read `src/core/tool-image-relay.ts` contract and [decisions.md](docs/architecture/decisions.md) D14 & D16.
- Pi host interaction (event registration, `ctx.model`): read `src/index.ts`; keep host knowledge out of `src/core/`.
- The extension must not grow an input handler again; input rewriting is retracted by D16.

# S.U.P.E.R Architecture Philosophy

> Write code like building with LEGO — each brick has a single job, a standard interface, a clear direction, runs anywhere, and can be swapped at will.

This document defines the architectural principles that guide all code written in this repository. Every agent executing tasks should internalize these principles.

---

## S — Single Purpose

From Unix philosophy.

- Each module, file, and function solves exactly one problem
- Prefer decomposition; power comes from composition
- One skill does one thing, one worker does one thing, one script does one thing

**Litmus test:** if you cannot describe a module's responsibility in a single sentence, it needs to be split.

**Anti-pattern:** a script that fetches data, computes metrics, renders charts, and sends notifications.

**Correct approach:**
```
fetch_data.py  -> data retrieval only, outputs JSON
compute.py     -> computation only, reads JSON writes JSON
render.py      -> rendering only, reads JSON generates HTML
notify.py      -> notification only, reads JSON calls webhook
```

---

## U — Unidirectional Flow

From Clean Architecture.

- Data always flows in one direction: input -> processing -> output
- Dependencies always point inward: outer layers depend on inner layers, inner layers know nothing about outer layers
- No reverse dependencies, no circular calls

**Layered model:**
```
+-------------------------------+
|  Infrastructure (API, DB, UI) |  <- outermost, replaceable at will
+-------------------------------+
|  Adapters (transform, format) |
+-------------------------------+
|  Core business (pure logic)   |  <- innermost, zero external deps
+-------------------------------+
```

**Litmus test:** can the core logic run unit tests with zero external services? If not, the dependency direction is wrong.

---

## P — Ports over Implementation

From Hexagonal Architecture.

- Define interface contracts (data structures, JSON Schema) before writing implementation
- Use intermediate formats (JSON files, standard data structures) to isolate upstream from downstream
- Swapping a data source, a rendering layer, or a notification channel requires zero changes to core logic

**Practices:**
1. Every module's input and output must be a serializable data structure
2. Module boundaries communicate via JSON files or standard data structures; in-process typed objects are fine, but cross-module interfaces must be serializable
3. Define explicit schemas — not "just read the code to figure out the format"

---

## E — Environment-Agnostic

From 12-Factor App.

- Configuration injected via environment variables or config files, never hardcoded
- All dependencies explicitly declared (requirements.txt / package.json), no implicit reliance on global system packages
- Processes are stateless; all persistence delegated to external storage
- Logs go to stdout, not to files
- Same codebase runs on local machine, Cloudflare Workers, VPS, Docker

**Configuration precedence (high to low):**
```
Environment variables > .env file > config.json > in-code defaults
```

**Checklist:**
- All API keys and webhook URLs read from environment variables?
- All dependencies explicitly declared in a dependency file?
- No hardcoded file path assumptions?
- Can a different machine run this code with zero modifications?

---

## R — Replaceable Parts

The natural consequence and ultimate goal of S + U + P + E.

- Any layer can be replaced without affecting others
- Replacement cost is the core metric of architecture quality
- If replacing one component triggers cascading changes in unrelated modules, the architecture is broken

**Replacement matrix:**
| Replacing          | Impact scope       | Correct approach                          |
|:-------------------|:-------------------|:------------------------------------------|
| Data source API    | Adapter layer only | Write new fetcher, output same JSON       |
| Frontend renderer  | Render layer only  | Read same JSON, swap render implementation|
| Notification channel| Notification layer | Swap webhook adapter                      |
| Deployment platform| Deploy config only | Change wrangler.toml or Dockerfile        |
| Programming language| Implementation only| JSON contracts unchanged, rewrite in any language |

---

## Quick Check Card

```
+------------------------------------------+
|         S.U.P.E.R Quick Check            |
|                                          |
|  S  Does this module do only one thing?  |
|  U  Is the data flow unidirectional?     |
|  P  Are inputs/outputs schema-defined?   |
|  E  Can it run in a different env?       |
|  R  Can you replace it without ripple?   |
|                                          |
|  All Yes -> Architecture healthy         |
|  1-2 No  -> Refactoring needed           |
|  3+ No   -> Technical debt alert         |
+------------------------------------------+
```

---

## S.U.P.E.R Code Review Checklist (10 checks)

Run this checklist after every task before marking it complete.

| Check | Principle |
|:------|:----------|
| Every new module/file has exactly one responsibility | S |
| No function does more than one conceptual thing | S |
| Data flows input → processing → output, no reverse deps | U |
| No circular imports introduced | U |
| Cross-module interfaces are schema-defined | P |
| Module I/O is serializable | P |
| No hardcoded paths, URLs, keys, or config values | E |
| All new dependencies explicitly declared | E |
| New modules can be replaced without changes to others | R |
| All tests pass after the change | — |

**Scoring rule:** All pass = proceed. 1-2 fail = fix before marking complete. 3+ fail = stop and refactor.

## Development and verification

**Package manager:** none required at runtime; no third-party dependencies. `package.json` declares only metadata and the `pi.extensions` entry.

**Typecheck:** `npx tsc --noEmit` (devDependency `typescript`, optional).

**Tests:** `node --test` runs the suite with Node's built-in test runner and native type stripping (Node >= 23.6). No test framework dependency.

During implementation, run the narrowest tests that cover the change. Before claiming checks pass, run the S.U.P.E.R. checklist above against the diff.

## Language, code, and Git

- Agent responses use Simplified Chinese.
- Code comments, JSDoc, test names, test descriptions, assertion messages, commits, and PR descriptions use English.
- Comments explain why, trade-offs, failure boundaries, and revisit conditions; they do not restate visible control flow.
- Follow KISS: no unrequested compatibility layer, migration shim, duplicate implementation, speculative fallback, or scope expansion.
- Match surrounding naming, comment density, and idiom.
- Commits use English Conventional Commits. Non-trivial commits add concise `- ` bullets and never include AI attribution.
