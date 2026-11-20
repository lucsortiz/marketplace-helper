# Marketplace Helper

Extensión de Chrome (Manifest V3) **no oficial** para republicar tus propios anuncios de Vinted desde tu armario, con copia de seguridad local y medidas para reducir el riesgo de restricción de la cuenta.

> **No está afiliada a Vinted.** Las condiciones de uso de Vinted prohíben usar herramientas externas no autorizadas y borrar y volver a publicar el mismo artículo varias veces o en bloque. Usar esta extensión puede provocar restricciones o el cierre de la cuenta. Lee [docs/ANTI_BAN.md](docs/ANTI_BAN.md) antes de usarla.

Versión actual: **1.0.0** · Repositorio: <https://github.com/lucsortiz/marketplace-helper>

## Origen

Este proyecto es un fork de una extensión existente de republicación para Vinted (el primer commit del repositorio contiene el código original). Se ha renombrado, se ha desactivado el envío remoto de informes de error (que iba a un servidor del autor original), se ha añadido el idioma español y se han reforzado los límites de ritmo.

**Licencia:** el código original no incluye archivo de licencia. Antes de publicar en el Chrome Web Store hay que confirmar con el autor original bajo qué condiciones se puede redistribuir. Hasta entonces, publica solo en visibilidad privada o para pruebas.

## Funciones

- **Republicar** un anuncio desde su botón en el armario.
- **Republicar todo**: cola con pausas aleatorias, límites por hora/día y pausas largas periódicas.
- Copia local (datos + fotos) verificada **antes** de borrar el original.
- Anuncios con error en `pending.html`: revisar, exportar, importar o reanudar.
- Diagnóstico local en `logs.html`.
- Transferencia entre cuentas (`transfert.html`, beta, oculta por defecto).
- Idiomas de la interfaz: español, inglés, francés e italiano.

## Protección de la cuenta (resumen)

| Medida | Valor por defecto |
|---|---|
| Intervalo entre republicaciones | 6 min ± 50 % (3–9 min, aleatorio) |
| Máximo por hora / por 24 h | 8 / 40 (topes duros: 20 / 150) |
| Mismo artículo otra vez | no antes de 72 h (mínimo 24 h) |
| Pausa larga | 20 min ± 50 % cada ~5 republicaciones |
| Horas de descanso | 01:00–08:00 hora local |
| Restricción de cuenta detectada | pausa ≥ 48 h |
| Comprobación anti-bot detectada | pausa ≥ 6 h |
| `429` de Vinted | pausa ≥ 15 min con crecimiento exponencial |

Detalle, fuentes y razonamiento: [docs/ANTI_BAN.md](docs/ANTI_BAN.md).

## Desarrollo

Requisitos: Node.js 20+ y Chrome 148+.

```bash
npm ci
npm test         # controles de release + tests sin red
npm run build    # tests + dist/marketplace-helper-<versión>.zip
```

Cargar en Chrome:

1. Abre `chrome://extensions` y activa el **Modo desarrollador**.
2. Pulsa **Cargar descomprimida** y selecciona **la raíz de este repositorio**.
3. Abre tu armario en Vinted (`/member/<tu-id>`): aparecerán los botones.

Prueba siempre con una cuenta de Vinted de pruebas, nunca con tu cuenta principal. Los tests automáticos no usan ninguna cuenta real.

## Publicar en Chrome Web Store

Guía, textos de la ficha, justificación de permisos y prompts de las imágenes: [docs/STORE_LISTING.md](docs/STORE_LISTING.md).

El ZIP que se sube es el que genera `npm run build` en `dist/`. La política de privacidad es `privacy.html`; debe estar publicada en una URL pública.

## Estructura

| Ruta | Función |
|---|---|
| `manifest.json` | Permisos, scripts y páginas MV3 |
| `background.js` | Service worker: mensajes, cabeceras de Vinted, coordinador |
| `src/coordinator.js` | Cola serial, bloqueos, **límites y protección anti-baneo** |
| `src/republishEngine.js` | Orden copia → crear → verificar → borrar original |
| `src/content.js`, `src/dom.js` | Botones y cola dentro del armario de Vinted |
| `src/vintedApi.js`, `src/pageFetch.js`, `src/bridge.js` | Llamadas a la API interna de Vinted vía la página |
| `src/jobStore.js` | IndexedDB con las copias locales |
| `src/i18n.js`, `src/locale.js`, `_locales/` | Textos (contenido y páginas internas) |
| `src/reporting*.js`, `src/errorReporter.js` | Informes de error locales; envío remoto desactivado |
| `ui.js`, `*.html`, `ui.css` | Popup, ajustes, pendientes, bienvenida |
| `scripts/release-check.js` | Reglas que el paquete debe cumplir |
| `tests/` | Tests sin red (`node --test`) |

## Limitaciones

- La API de Vinted es interna y puede cambiar sin aviso.
- Las visitas, favoritos y estadísticas no se conservan al republicar.
- Una talla obsoleta hay que corregirla en Vinted antes de republicar.
- Ninguna medida garantiza que Vinted no restrinja la cuenta.
