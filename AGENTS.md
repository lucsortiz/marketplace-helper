# AGENTS.md

Guía para agentes de código (Claude Code, Codex, Cursor…) que trabajen en este repositorio. Para personas: `README.md`.

## Qué es

Extensión de Chrome **Manifest V3**, JavaScript plano (sin bundler, sin TypeScript, sin framework). Añade botones «Republicar» / «Republicar todo» al armario de Vinted (`/member/<id>`) y republica los anuncios del usuario: copia local → crear anuncio nuevo → verificar → borrar original. No es oficial y Vinted lo desaconseja en sus condiciones: **la protección de la cuenta es un requisito, no un extra** (`docs/ANTI_BAN.md`).

## Comandos

```bash
npm ci                 # única dependencia: fake-indexeddb (solo tests)
npm test               # scripts/release-check.js + node --test tests/*.test.cjs
npm run build          # npm test + scripts/build-release.sh → dist/marketplace-helper-<versión>.zip
node --test tests/anti-ban.test.cjs   # un solo archivo
```

- Los tests no usan red ni cuentas reales. **Nunca** escribas un test o script que llame a Vinted.
- Si un test se queda colgado, casi siempre es un `acquire` que devuelve `waitMs` con el reloj falso parado: avanza el reloj (`e.advance(...)`) más allá del intervalo máximo (`ITEM_GAP`).
- `scripts/release-check.js` contiene reglas de producto (no solo de sintaxis). Si cambias algo que comprueba, actualiza la regla con el mismo cuidado; no la borres para que pase.

## Arquitectura

| Contexto | Archivos | Notas |
|---|---|---|
| Service worker | `background.js` → `importScripts` de `src/jobStore.js`, `src/coordinator.js`, `src/reporting*.js` | Captura cabeceras de Vinted (`webRequest`), enruta mensajes, aplica todos los límites. |
| Content script MAIN world | `src/bridge.js` | Único script en MAIN. Transporta `fetch` desde la página (protocolo `vinted-republish:page-fetch:v1`). |
| Content script aislado | `src/config.js` … `src/content.js` (orden en `manifest.json`) | Todo cuelga de `window.__VintedRelister` (`NS`). El orden importa. |
| Páginas de la extensión | `popup.html`, `options.html`, `pending.html`, `welcome.html`, `logs.html`, `transfert.html` + `ui.js`, `logs-ui.js`, `transfer-ui.js` | `ui.js` decide qué pintar con `document.body.dataset.page`. |

Flujo de una republicación (`src/republishEngine.js` → `NS.republish`):

1. `item-check` (enfriamiento por artículo) → `acquire` (lease único por sitio; puede devolver `waitMs`).
2. Copia local completa (`backup`) en IndexedDB, con fotos.
3. Subir fotos → `create-requested` → crear → `created`.
4. Verificar la copia contra lo esperado → `delete-requested` → borrar original → `deleted` → `finish`.
5. Si la verificación falla antes de borrar el original: `rollback-requested` → borrar **solo** la copia.

Cada etapa se persiste antes de la acción de red. Nunca repitas a ciegas una escritura cuya respuesta se perdió: se reconcilia leyendo (`reconcileCreated`, lecturas de `original`).

## Reglas que no se pueden romper

1. **No borrar el original sin copia local completa y copia nueva verificada.** Cualquier cambio en `republishEngine.js` debe mantener ese orden y los tests de `tests/recovery.test.cjs`.
2. **El coordinador es la única autoridad sobre ritmo y límites.** No añadas esperas, reintentos ni bucles en content scripts que se salten `acquire`/`request`/`refusal`.
3. **No relajar la protección anti-baneo** (`src/coordinator.js`: `DEFAULTS`, `CAPS`, `item-check`, `quietWaitMs`, `RESTRICTED_PAUSE_MS`, `ANTI_BOT_PAUSE_MS`, `itemSpread`) sin que el usuario lo pida explícitamente. Si lo pide, actualiza `docs/ANTI_BAN.md`, la tabla del `README.md` y `tests/anti-ban.test.cjs`.
4. **No evadir detección**: nada de alterar fotos para engañar al fingerprinting, falsificar user agent, rotar cuentas ni automatizar sin clic del usuario.
5. **Sin código remoto**: prohibido `eval`, `new Function`, scripts externos. Requisito del Chrome Web Store.
6. **Sin nuevos permisos** en `manifest.json` sin justificarlos en `docs/STORE_LISTING.md` y `privacy.html`.
7. **Privacidad**: nada sale del navegador salvo hacia dominios de Vinted. El envío remoto de informes está desactivado (`src/reportingConfig.js` vacío). No lo actives sin un servidor propio del usuario, permiso opcional en el manifest y cambios en la política de privacidad.
8. **Mensajes de `trusted`**: acciones como `settings`, `reset-cooldown`, `import` solo se aceptan desde páginas de la extensión. Mantén esas comprobaciones.

## Textos e idiomas

- Páginas de la extensión: `_locales/{en,fr,it,es}/messages.json` (claves `ui*`, cargadas por `src/locale.js`). Cualquier clave nueva va en los **cuatro** archivos.
- Content script: `src/i18n.js` (`UI_EN`, `UI_FR`, `UI_IT`, `UI_ES` y botones en 23 idiomas). Inglés es el respaldo.
- Idiomas seleccionables: `src/locale.js`, `src/coordinator.js` (`settings`) y los `<select data-language>` de los HTML.
- La descripción del manifest (`extensionDescription`) tiene un máximo de 132 caracteres.

## Versionado y publicación

- La versión vive en `manifest.json` y `package.json` (y `package-lock.json`). Súbela en los tres antes de cada build para la Store.
- Nombre público: **Marketplace Helper** (`PUBLIC_NAME` en `scripts/release-check.js`). No reintroduzcas el nombre ni el contacto del proyecto original.
- Ficha, permisos e imágenes: `docs/STORE_LISTING.md`.

## Estilo de código

- IIFE por archivo, `'use strict'` donde ya existe, sin dependencias en tiempo de ejecución.
- Hay comentarios en francés heredados del original; los nuevos pueden ir en inglés o español, breves y explicando el *porqué*.
- Mantén el formato compacto existente; no reformatees archivos enteros.
- Identificadores internos con prefijo `vinted-republish` (clases CSS, base de datos IndexedDB, formato de copia) se conservan por compatibilidad: cambiarlos rompería copias exportadas.
