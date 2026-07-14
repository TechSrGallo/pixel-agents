# SOUL.md — Memoria del proyecto

> Este fichero contiene lo que el agente ha aprendido del
> **proyecto/equipo** y que tiene sentido compartir. Lo escribe
> principalmente el propio agente vía el tool `soul_remember`, pero
> puedes editarlo a mano. La identidad de cada usuario, su tono
> preferido y el diario personal viven en `.mi-cli-ia/SOUL.local.md`
> (privado, gitignored).

## Skills

<!-- Capacidades reforzadas para este workspace: especialidades
     técnicas, estilos de revisión, dominios que el agente debe
     dominar más que otros. Una skill por bullet. -->

- Patrón "Handle" para mutar controles de SwiftTUI desde fuera del árbol de vistas (sin @Binding nativo): clase `@MainActor public final class XxxHandle` con `weak var control: XxxControl?`. La view recibe un `handle:` opcional en el init y lo conecta en `buildNode`/`updateNode` vía `MainActor.assumeIsolated`. Métodos públicos del handle (e.g. `setText`, `insertAtCursor`) delegan al control. Backwards-compat: parámetro opcional con default `nil`. Usado en `TextFieldHandle` (SwiftTUI v1.2.5) para inyectar transcripciones de voz al input. Aplicable a otros controles que necesiten mutación externa (TextEditor, Picker, etc.).

## Lecciones aprendidas

<!-- Patrones que NO se deben repetir, gotchas del codebase,
     decisiones que ya se descartaron y por qué. Es el "saber del
     proyecto" que evita errores recurrentes. Append discreto:
     conviene apuntar lecciones generales, no anécdotas de un solo
     turno (esas van al Diario en `SOUL.local.md`). -->

- En pixel-agents, el dispatcher de AgentRuntime NO crea el agente al recibir `sessionStart` de una sesión externa: la deja como "pending external session" y exige un evento posterior que la confirme. El bridge SSE (sseBridge.ts) emite un `pixel-agents.session.confirm` sintético justo después de cada sessionStart para que el personaje aparezca al instante; cualquier integración que haga POST a /api/hooks/sse a mano debe replicar ese patrón o el agente nunca se materializa.
