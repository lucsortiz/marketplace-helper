# Vinted Republish FREE

Extension Chrome Manifest V3 pour republier des annonces Vinted depuis le dressing.

Elle ajoute des actions de republication, conserve une sauvegarde locale avant toute operation destructive et permet d'envoyer volontairement un rapport technique filtre en cas d'erreur.

Version courante : **0.11.13**.

## Fonctionnalites

- **Republier** une annonce individuellement.
- **Tout republier** les annonces d'un dressing avec file d'attente, pauses et limites locales.
- Conserver une sauvegarde locale avec photos avant la suppression de l'original.
- Reprendre ou inspecter les annonces en erreur depuis `pending.html`.
- Exporter les sauvegardes et journaux locaux.
- Preparer un transfert entre comptes via `transfert.html`.
- Envoyer manuellement un rapport d'erreur au Worker Cloudflare de reporting.

## Installation locale

```bash
npm ci
npm test
```

Pour charger l'extension en developpement :

1. Ouvrir `chrome://extensions`.
2. Activer le mode developpeur.
3. Cliquer sur **Load unpacked**.
4. Selectionner le dossier `chrome-extension`.

## Build Chrome Web Store

```bash
npm run build
```

Le build execute les controles de release et les tests hors ligne, puis genere :

```text
dist/vinted-republish-free-0.11.13.zip
```

C'est ce fichier ZIP qu'il faut envoyer au Chrome Web Store.

## Securite du flux

- L'original n'est supprime qu'apres creation et verification de la copie.
- Les photos et champs metier sont sauvegardes localement avant republication.
- Les reponses d'ecriture perdues ne sont pas rejouees aveuglement.
- Une seule republication active est autorisee par origine Vinted.
- Les limites horaires, journalieres, pauses `Retry-After` et refus `401/403/429` sont centralises dans le service worker.
- Les sauvegardes sont locales au profil Chrome ; elles ne remplacent pas une sauvegarde disque ou un export manuel.

## Reporting d'erreurs

Le reporting est volontaire et passe par `https://reporting.vinted-republish.workers.dev`.

Le Worker ne recoit pas :

- le titre de l'annonce ;
- la description ;
- l'identifiant de l'annonce ;
- les photos ;
- les sauvegardes ;
- les cookies ou jetons.

Il recoit uniquement un diagnostic borne et filtre, puis le groupe dans D1 et le synchronise avec une issue GitHub automatique.

`npm run build` fait un dry-run Wrangler. `npm run deploy` publie reellement le Worker.

## Structure utile

| Chemin | Role |
|---|---|
| `manifest.json` | Permissions, scripts et pages MV3 |
| `background.js` | Service worker, messages privilegies, reporting |
| `src/config.js` | Endpoints Vinted embarques |
| `src/content.js`, `src/dom.js` | Integration dans le dressing Vinted |
| `src/coordinator.js` | Verrous, pauses, limites et transitions durables |
| `src/republishEngine.js` | Ordre sauvegarde, creation, verification, suppression |
| `src/jobStore.js` | IndexedDB et sauvegardes locales |
| `src/pageFetch.js`, `src/bridge.js` | Transport reseau via la page Vinted |
| `src/reportingService.js` | Envoi volontaire et suivi des recus |
| `ui.js`, `ui.css` | Pages internes de l'extension |
| `tests/` | Tests hors ligne |

## Commandes

```bash
npm test
npm run build
```

## Limites

- L'API Vinted est interne et peut changer sans preavis.
- Les vues, favoris et statistiques Vinted ne sont pas transferes.
- Une taille obsolete doit etre corrigee sur Vinted avant republication.
- Les tests automatises ne doivent pas utiliser de compte Vinted reel.
