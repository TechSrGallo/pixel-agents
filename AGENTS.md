# AGENTS.md

> Instrucciones para agentes de IA que trabajen en este workspace.
> Lo leen tanto mi-cli-ia (vía `ProjectConventions`) como otros
> agentes externos que respeten la convención.

## Sobre este workspace

Este directorio está gestionado con **mi-cli-ia**: una TUI/CLI para
conversar con LLMs (OpenAI, Anthropic, Devin, OpenCode, …) con
tool-calling, MCP server embebido y memoria viva persistente.

## Memoria viva del agente

El estado del agente está repartido entre dos ficheros markdown:

- `SOUL.md` (en la raíz, **commiteable**): skills y lecciones del
  proyecto. Compartibles con el equipo si se commitea.
- `.mi-cli-ia/SOUL.local.md` (**gitignored, per-máquina**): identidad
  del usuario sentado delante (nombre, alias, tono, idioma) y diario
  cronológico privado del agente.

## Tool obligatoria: `soul_remember`

Cuando aprendas algo que merezca persistir, **usa la tool
`soul_remember`** (vía MCP o tool-calling nativo). No edites los
ficheros SOUL a mano: el tool garantiza idempotencia, audit trail
automático y orden canónico.

### Secciones disponibles

| `section`   | fichero         | qué apuntar                                       |
| ----------- | --------------- | ------------------------------------------------- |
| `usuario`   | `SOUL.local.md` | nombre/alias, tono preferido, idioma, formato     |
| `skills`    | `SOUL.md`       | capacidades reforzadas para este proyecto         |
| `lecciones` | `SOUL.md`       | patrones del codebase a NO repetir, gotchas       |
| `diario`    | `SOUL.local.md` | append-only, auto-gestionado (no escribas a mano) |

### Operaciones

- `add` — añade un bullet nuevo (idempotente: no duplica).
- `remove` — borra un bullet exacto (no aplica a `diario`).
- `replace` — sustituye un bullet por otro (no aplica a `diario`).

### Cuándo persistir

- **Proactivamente**: el usuario revela su nombre, alias, tono o
  idioma → `usuario`. Pide reforzar una skill o señala un dominio
  → `skills`. Aparece una gotcha del proyecto / patrón a evitar
  → `lecciones`.
- **No** anotes anécdotas de un único turno; eso pertenece al diario,
  que se gestiona automáticamente cuando hay mutaciones de `SOUL.md`.
- **Privacidad**: la identidad del usuario va SIEMPRE a `usuario`
  (que vive en el local gitignored), nunca a `skills` o `lecciones`
  del shared, donde otros miembros del equipo la verían.

## Convenciones del proyecto

Si el proyecto necesita reglas adicionales (estilo de código,
nomenclatura, frameworks, comandos build/test), añádelas debajo de
esta línea o crea un `CONVENTIONS.md` aparte. mi-cli-ia inyecta ambos
como system message al agente en cada turno.
