# Ficha del Chrome Web Store

Material para rellenar el panel de desarrollador. Mantenlo sincronizado con `manifest.json`, `_locales/` y `privacy.html`.

## Antes de enviar

- [ ] Licencia del código original confirmada (ver README, sección Origen). Si no, publicar solo en visibilidad **Privada**.
- [ ] `npm run build` en verde; subir `dist/marketplace-helper-<versión>.zip`.
- [ ] `privacy.html` publicado en una URL pública.
- [ ] Iconos e ilustraciones sustituidos por los nuevos (ver sección Imágenes): los actuales son del proyecto original.
- [ ] Capturas hechas con una cuenta de pruebas, sin datos personales visibles.

## Datos básicos

| Campo | Valor |
|---|---|
| Nombre | Marketplace Helper (sale de `_locales`) |
| Categoría | Productividad → Herramientas |
| Idioma principal | Español (añadir inglés, francés e italiano) |
| Sitio web | https://github.com/lucsortiz/marketplace-helper |
| Soporte | https://github.com/lucsortiz/marketplace-helper/issues |
| Política de privacidad | URL pública de `privacy.html` |

## Descripción (es)

> Marketplace Helper añade un botón «Republicar» a tu propio armario de Vinted para volver a publicar un artículo sin rellenar el formulario de nuevo.
>
> • Guarda una copia local de los datos y las fotos antes de tocar nada.
> • Crea el anuncio nuevo, lo verifica y solo entonces borra el original. Si algo no cuadra, conserva el original.
> • Ritmo prudente: intervalos aleatorios, límites por hora y por día, pausas largas, horas de descanso y un mínimo de 72 h antes de republicar el mismo artículo.
> • Se detiene automáticamente si Vinted limita las peticiones o restringe la cuenta.
> • Sin servidores propios: tus datos no salen de tu navegador salvo hacia Vinted.
>
> Herramienta no oficial, sin relación con Vinted. Las condiciones de Vinted limitan el uso de herramientas externas y la republicación repetida; úsala con moderación y bajo tu responsabilidad.

## Descripción (en)

> Marketplace Helper adds a “Republish” button to your own Vinted wardrobe so you can relist an item without filling in the form again.
>
> • Saves a local copy of the listing data and photos before changing anything.
> • Creates the new listing, verifies it, and only then deletes the original. If anything does not match, the original is kept.
> • Careful pace: random delays, hourly and daily limits, long breaks, quiet hours and at least 72 h before relisting the same item.
> • Stops automatically when Vinted rate-limits requests or restricts the account.
> • No servers of its own: your data never leaves your browser except to Vinted.
>
> Unofficial tool, not affiliated with Vinted. Vinted’s terms restrict external tools and repeated relisting; use it sparingly and at your own risk.

## Pestaña Privacy practices

**Propósito único:** republicar los anuncios propios del usuario en Vinted desde su armario, con copia local previa.

| Permiso | Justificación |
|---|---|
| `webRequest` | Lee (sin bloquear ni modificar) las cabeceras CSRF y de sesión anónima de las peticiones a `/api/*` de Vinted, necesarias para autenticar las peticiones que el usuario lanza al republicar. |
| `storage` | Guarda ajustes, límites, historial reciente de republicaciones (para aplicar límites) e identificadores de sesión en memoria. |
| `unlimitedStorage` | Guarda copias locales de los anuncios con sus fotos antes de borrar el original, para poder recuperarlos si algo falla. |
| `browsingData` | Solo para el botón opcional «cierre de sesión limpio» de la transferencia entre cuentas: borra cookies y almacenamiento del sitio de Vinted elegido. Si eliminas esa función, quita también el permiso. |
| Hosts `www.vinted.*` | Mostrar los botones en el armario del usuario y llamar a la API de Vinted en su nombre. |
| Hosts `images*.vinted.net` | Descargar las fotos del propio anuncio para la copia local y volver a subirlas. |

**¿Usa código remoto?** No.

**Datos recogidos (declarar):**

- *Información de autenticación* (tokens de sesión de Vinted): sí, solo en memoria y solo enviados a Vinted.
- *Contenido del sitio web* (datos y fotos de los anuncios del usuario): sí, guardados localmente.
- Resto de categorías: no.

**Certificaciones:** no se venden datos a terceros; no se usan para fines ajenos al propósito único; no se usan para solvencia ni préstamos.

## Imágenes

Requisitos del Chrome Web Store: icono 128×128 PNG (dibujo de 96×96 con 16 px de margen transparente), de 1 a 5 capturas de 1280×800 (o 640×400) con esquinas rectas y sin margen, mosaico promocional pequeño de 440×280 y, opcional, marquesina de 1400×560.

### Concepto visual: «Segunda vuelta»

Una **percha de ropa cuyo gancho se curva hasta formar una flecha circular**, como si la prenda diera una vuelta y regresara al escaparate. Un pequeño **reloj de arena** acompaña en las piezas grandes para transmitir el ritmo pausado.

Paleta propia, distinta del verde azulado de Vinted para no parecer oficial: terracota `#D9734E`, crema `#FFF6EC`, azul tinta `#1F2A44` y verde salvia `#8FB59A` como acento. Formas redondeadas, estilo ilustración plana con textura de papel muy sutil. **Nunca** usar el logotipo, la tipografía ni el color de Vinted.

### Lista de imágenes y prompts

| # | Archivo | Tamaño | Uso |
|---|---|---|---|
| 1 | `icons/icon128.png` (+ 48, 32, 24, 16) | 128×128 y reducciones | Icono de la extensión, barra de herramientas y botones |
| 2 | `store/screenshot-1-boton.png` | 1280×800 | Captura 1: el botón en el armario |
| 3 | `store/screenshot-2-ajustes.png` | 1280×800 | Captura 2: protección de la cuenta |
| 4 | `store/screenshot-3-copia.png` | 1280×800 | Captura 3: copia local y anuncios con error |
| 5 | `store/screenshot-4-popup.png` | 1280×800 | Captura 4: popup con volumen y cola |
| 6 | `store/promo-small.png` | 440×280 | Mosaico promocional pequeño |
| 7 | `store/marquee.png` | 1400×560 | Marquesina (opcional) |
| 8 | `media/illustration-pin.jpg` | 1282×816 | Bienvenida, paso 1 |
| 9 | `media/illustration-wardrobe.jpg` | 1294×832 | Bienvenida, paso 2 |
| 10 | `media/account-placeholder.png` | 256×256 | Avatar por defecto en transferencias |

**1. Icono**

> Flat vector app icon, 128×128, transparent background, artwork centered in a 96×96 safe area. A single thick rounded clothes hanger in terracotta (#D9734E) whose hook curls into a smooth circular arrow pointing clockwise, closing the loop around the hanger. Tiny sage-green (#8FB59A) sparkle at the arrow tip. Ink-blue (#1F2A44) 4 px outline. No text, no letters, no shadows, crisp edges, legible at 16 px.

Genera la versión de 128 px y reduce a 48, 32, 24 y 16 comprobando que la flecha sigue leyéndose; en 16 px puedes quitar el destello.

**2–5. Capturas (fondo para montar la captura real)**

Las capturas deben mostrar la extensión real. Haz la captura de pantalla con una cuenta de pruebas y colócala sobre este fondo, con un titular a la izquierda.

> Wide 1280×800 marketing background, cream (#FFF6EC) with soft paper texture. Left third: empty space for a bold ink-blue (#1F2A44) headline. Right two thirds: a rounded white browser-window frame with a subtle shadow, empty inside (to paste a screenshot). Small decorative terracotta hanger-with-circular-arrow motif and a sage-green hourglass in the bottom-left corner. Flat, calm, airy, no text, no logos.

Titulares sugeridos:

1. «Republica con un clic, desde tu propio armario»
2. «Un ritmo prudente: pausas, límites y horas de descanso»
3. «Nada se borra sin una copia verificada»
4. «Sabes qué se republica y cuándo»

**6. Mosaico promocional pequeño (440×280)**

> Promotional tile 440×280, terracotta (#D9734E) background with a faint cream circular-arrow pattern. Center-left: large cream hanger whose hook curls into a circular arrow, with a small folded sweater hanging from it. Right side: empty area reserved for the product name in ink-blue. Flat illustration, high contrast, readable when small, no text, no third-party logos.

Añade después el texto «Marketplace Helper» en la zona derecha con una tipografía redondeada (por ejemplo Nunito o Poppins, negrita).

**7. Marquesina (1400×560)**

> Panoramic banner 1400×560 in flat editorial illustration style. A cozy cream (#FFF6EC) wardrobe opens like a stage; garments on terracotta hangers leave the wardrobe in a gentle arc, travel along a looping dotted path shaped like a circular arrow, and return refreshed with small sage-green sparkles. A calm hourglass sits on a shelf, suggesting a relaxed pace. Ink-blue (#1F2A44) outlines, lots of breathing room on the left for a title. No text, no logos, no real brands.

**8. Ilustración «Fija la extensión» (bienvenida, paso 1)**

> Flat UI illustration 1282×816, light cream background. Close-up of a generic browser toolbar (no real browser branding) with a puzzle-piece extensions button opened as a small menu; one row shows a terracotta hanger-with-circular-arrow icon and a pin button highlighted with a sage-green glow. A friendly hand cursor is about to click the pin. Rounded shapes, soft shadows, no readable text except placeholder lines.

**9. Ilustración «Ve a tu armario» (bienvenida, paso 2)**

> Flat UI illustration 1294×832, light cream background. A generic product card of a second-hand garment (a folded knit sweater illustration, not a photo) with placeholder grey text lines for price and stats. Under it, a rounded outlined button with a terracotta hanger-with-circular-arrow icon and placeholder label. A small sage-green check mark floats beside the button. No real marketplace branding or colors, no readable words.

La ilustración actual tiene textos en francés («Republier», «Booster») y el icono original: la nueva no debe llevar texto legible, así sirve para todos los idiomas.

**10. Avatar por defecto (256×256)**

> Simple avatar placeholder 256×256, circle filled with sage green (#8FB59A), a minimal cream silhouette of a person's head and shoulders, and a tiny terracotta hanger badge at the bottom right. Flat, no text.
