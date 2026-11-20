# Protección de la cuenta frente a restricciones de Vinted

Este documento explica qué se sabe sobre cómo Vinted restringe cuentas que republican anuncios, qué hace la extensión para reducir ese riesgo y qué **no** puede hacer. Investigación de noviembre de 2026.

## 1. Lo que dicen las condiciones de Vinted

La sección 6 de las condiciones de uso de Vinted ("What you must and must not do") incluye, entre otras prohibiciones:

- Usar bots, programas de scraping, crawling o similares sin autorización de Vinted.
- Borrar y volver a publicar **el mismo artículo varias veces** o **varios artículos en bloque**.

La sección 7 dice que el uso de herramientas externas contrarias a las condiciones es un motivo de actuación sobre la cuenta **sin aviso previo**, y que Vinted puede usar sistemas automáticos para detectar infracciones.

Fuente: condiciones de Vinted UK (<https://www.vinted.co.uk/old-terms-and-conditions>). La versión vigente no se pudo descargar directamente; artículos recientes de terceros citan la misma cláusula, por lo que se asume que sigue en vigor. **Revísala tú mismo antes de publicar.**

**Conclusión:** la funcionalidad principal de esta extensión choca con las condiciones de Vinted. Ninguna medida técnica la hace "segura" o permitida; solo puede reducir la probabilidad de que el comportamiento parezca automático o abusivo.

## 2. Qué provoca restricciones (según fuentes públicas)

No hay umbrales oficiales. Lo siguiente sale de blogs de herramientas comerciales de Vinted (con interés en vender su producto), por lo que hay que tomarlo con cautela:

| Señal | Qué se describe |
|---|---|
| Ráfagas de actividad | Muchas publicaciones, borrados o republicaciones en poco tiempo disparan la "verificación de actividad". |
| Rotación rápida del mismo artículo | Republicar el mismo artículo más de una vez al día es la zona de mayor riesgo; se recomienda cada 3–4 días. |
| Intervalos fijos | Tiempos idénticos entre acciones parecen de bot; se recomiendan 3–10 min con variación aleatoria. |
| Actividad 24/7 | Se recomienda no actuar de noche ni sin pausas. |
| Volumen | Para armarios grandes, unas 5–10 republicaciones por hora; más de unas 10 publicaciones diarias sin cuenta Pro puede parecer actividad comercial. |
| Duplicados | Dejar el original y la copia en línea a la vez. |
| Denuncias de otros usuarios | Pueden activar una revisión manual. |

Consecuencias descritas: restricción temporal (a menudo ~24 h, a veces días o semanas) con los botones de publicar/editar desactivados, verificación de identidad, pérdida de visibilidad sin aviso ("shadowban") y, en casos graves o repetidos, cierre de la cuenta. Tras una restricción se recomienda esperar al menos 48 h antes de volver a republicar.

Fuentes consultadas:

- [Redrip — Vinted automation restriction (2026)](https://www.redrip.app/en/blog/vinted-automation-restriction-2026/)
- [Redrip — How to relist on Vinted safely](https://www.redrip.app/en/blog/how-to-relist-vinted-items/)
- [Fripio — Compte Vinted restreint temporairement (2026)](https://fripio.app/blog/compte-vinted-restreint-temporairement-2026)
- [StoFlow — Automating Vinted sales: risks and limits](https://stoflow.com/en/blog/automate-sales-without-getting-banned)
- [Vintz — Vinted automation checklist](https://vintz.ai/articles/vinted-automation-checklist)

## 3. Medidas que aplica la extensión

Todas viven en `src/coordinator.js` (service worker), salvo donde se indica. El coordinador es la única fuente de verdad: las pestañas no pueden saltárselo.

| Medida | Por defecto | Dónde | Por qué |
|---|---|---|---|
| Una sola republicación activa por sitio de Vinted | siempre | `acquire` / lease | Evita ráfagas desde varias pestañas. |
| Intervalo entre artículos aleatorio | 6 min ± 50 % (3–9 min) | `release`, `itemSpread` | Ritmo humano sin patrón fijo. |
| Pausa entre peticiones | 1,5 s ± 1 s | `request` | Evita picos de peticiones a la API. |
| Límite por hora / 24 h | 8 / 40 | `limited` | Volumen bajo; topes duros 20 / 150 (`CAPS`). |
| Enfriamiento por artículo | 72 h (mín. 24 h) | `item-check`, `backup`, `scan-page` | Las condiciones prohíben republicar el mismo artículo varias veces. Se sigue el linaje: el ID nuevo hereda el enfriamiento del original. |
| Pausa larga periódica | 20 min ± 50 % cada 4–7 republicaciones | `release` | Simula sesiones con descansos. |
| Horas de descanso | 01:00–08:00 hora local (+1–25 min aleatorios al salir) | `quietWaitMs` | Sin actividad nocturna ni a hora en punto. |
| `429` (rate limit) | ≥ 15 min, exponencial, respeta `Retry-After` | `refusal` | Nunca acorta una pausa pedida por Vinted. |
| Comprobación anti-bot (DataDome/Cloudflare) | ≥ 6 h, exponencial hasta 72 h | `refusal` | Señal fuerte de detección. |
| Cuenta restringida | ≥ 48 h, exponencial hasta 72 h | `refusal` | Recomendación de esperar 48 h tras una restricción. |
| "Reiniciar la espera" no borra pausas fuertes | requiere confirmación explícita en Ajustes | `reset-cooldown` (`force`) | Evita reanudar sin querer tras una restricción. |
| Sin duplicados | siempre | `republishEngine.js` | Verifica la copia y borra el original; si la verificación falla, borra la copia. |
| Un lote se detiene al primer error | siempre | `content.js` `performItem` | No insiste ante errores. |
| Escaneo de armario omite artículos en enfriamiento | siempre | `scan-page` | "Republicar todo" no los encola. |

## 4. Lo que la extensión no hace a propósito

- **No altera fotos** para esquivar la detección de imágenes duplicadas, no falsifica el user agent ni rota identidades. Eso sería evadir activamente los controles de Vinted, aumenta el riesgo de cierre definitivo y es mucho más difícil de defender en la revisión del Chrome Web Store.
- **No gestiona varias cuentas** a la vez. Tener varias cuentas es motivo de cierre según la ayuda de Vinted (la transferencia beta es solo entre dos cuentas tuyas y está oculta por defecto).
- **No republica sola.** Siempre empieza con un clic del usuario.

## 5. Recomendaciones de uso

1. Prueba con una cuenta secundaria antes que con la principal.
2. No subas los límites por encima de los valores por defecto.
3. Republica solo los artículos que llevan días sin vistas; no todo el armario.
4. Si Vinted muestra "Estamos verificando tu actividad" o desactiva el botón de publicar, deja de usar la extensión al menos 48 h y no fuerces la pausa.
5. Si vendes en volumen, valora la cuenta Pro de Vinted y sus opciones oficiales (como "Destacar").

## 6. Si cambias estos valores

- Los marcadores de `scripts/release-check.js` impiden borrar estas protecciones sin que falle el build.
- Los tests están en `tests/anti-ban.test.cjs`.
- Actualiza esta página, la tabla del `README.md` y los textos de `_locales/*/messages.json` (`uiSafetyGuardText`, `uiSettingsNotice`).
