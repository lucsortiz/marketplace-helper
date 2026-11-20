# CLAUDE.md

Las instrucciones para agentes de este proyecto están en AGENTS.md:

@AGENTS.md

## Notas específicas para Claude

- Responde al usuario en español.
- Antes de dar por terminado un cambio, ejecuta `npm test` (incluye `scripts/release-check.js`). Para cambios de ritmo o límites, ejecuta también `node --test tests/anti-ban.test.cjs`.
- Ejecuta los tests con un timeout (`node --test --test-timeout=8000 …`): un `acquire` en espera con el reloj falso parado deja el test colgado en lugar de fallar.
- No pruebes contra Vinted real ni pidas credenciales de Vinted.
- Si una petición del usuario implica relajar la protección anti-baneo, explícale el riesgo con `docs/ANTI_BAN.md` y pide confirmación antes de cambiarlo.
