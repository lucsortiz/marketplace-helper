// src/i18n.js — Détecte la langue de l'interface Vinted et fournit les
// libellés traduits pour les boutons Republier / Tout republier. Détection
// via document.documentElement.lang (reflète le réglage de langue réel du
// compte, plus fiable que le domaine seul pour les pays multilingues comme
// la Suisse ou la Belgique), avec repli sur le domaine (TLD) si l'attribut
// est absent ou non reconnu.
//
// Traductions "best effort" (pas de relecture native pour toutes les
// langues). Les contrôles principaux et le message de taille obsolète sont
// traduits dans 23 langues. Les autres messages ont une version française
// et anglaise, avec repli anglais pour les langues non encore relues.
(function () {
  const NS = (window.__VintedRelister = window.__VintedRelister || {});

  const STRINGS = {
    fr: { relistButton: 'Republier', relistAllButton: 'Tout republier', articles: 'articles', preparing: 'Préparation…', nothingToRelist: 'Aucun article actif à republier.', clickToCancel: 'Cliquer pour annuler' , staleSizeNotice: 'Taille non reconnue par Vinted (ancien identifiant, remplacé depuis). Resélectionne-la sur sa fiche, puis réessaie. Rien n\'a été modifié ni supprimé.', staleSizeViewButton: 'Voir l\'article', },
    en: { relistButton: 'Republish', relistAllButton: 'Republish all', articles: 'items', preparing: 'Preparing…', nothingToRelist: 'No active items to republish.', clickToCancel: 'Click to cancel' , staleSizeNotice: 'This size is no longer recognized by Vinted (old identifier, since replaced). Reselect it on the item\'s page, then try again. Nothing was changed or deleted.', staleSizeViewButton: 'View item', },
    de: { relistButton: 'Neu veröffentlichen', relistAllButton: 'Alle neu veröffentlichen', articles: 'Artikel', preparing: 'Vorbereitung…', nothingToRelist: 'Keine aktiven Artikel zum erneuten Veröffentlichen.', clickToCancel: 'Zum Abbrechen klicken' , staleSizeNotice: 'Diese Größe wird von Vinted nicht mehr erkannt (alte Kennung, seither ersetzt). Wähle sie auf der Artikelseite erneut aus und versuche es dann noch einmal. Es wurde nichts geändert oder gelöscht.', staleSizeViewButton: 'Artikel ansehen', },
    it: { relistButton: 'Ripubblica', relistAllButton: 'Ripubblica tutto', articles: 'articoli', preparing: 'Preparazione…', nothingToRelist: 'Nessun articolo attivo da ripubblicare.', clickToCancel: 'Clicca per annullare' , staleSizeNotice: 'Questa taglia non è più riconosciuta da Vinted (vecchio identificativo, sostituito nel frattempo). Riselezionala nella scheda dell\'articolo, poi riprova. Non è stato modificato né eliminato nulla.', staleSizeViewButton: 'Vedi articolo', },
    es: { relistButton: 'Republicar', relistAllButton: 'Republicar todo', articles: 'artículos', preparing: 'Preparando…', nothingToRelist: 'No hay artículos activos para republicar.', clickToCancel: 'Haz clic para cancelar' , staleSizeNotice: 'Esta talla ya no está reconocida por Vinted (identificador antiguo, sustituido desde entonces). Vuelve a seleccionarla en la ficha del artículo y vuelve a intentarlo. No se ha modificado ni eliminado nada.', staleSizeViewButton: 'Ver artículo', },
    pt: { relistButton: 'Republicar', relistAllButton: 'Republicar tudo', articles: 'artigos', preparing: 'A preparar…', nothingToRelist: 'Nenhum artigo ativo para republicar.', clickToCancel: 'Clique para cancelar' , staleSizeNotice: 'Este tamanho já não é reconhecido pela Vinted (identificador antigo, substituído entretanto). Volta a selecioná-lo na ficha do artigo e tenta novamente. Nada foi alterado nem eliminado.', staleSizeViewButton: 'Ver artigo', },
    nl: { relistButton: 'Opnieuw plaatsen', relistAllButton: 'Alles opnieuw plaatsen', articles: 'artikelen', preparing: 'Voorbereiden…', nothingToRelist: 'Geen actieve artikelen om opnieuw te plaatsen.', clickToCancel: 'Klik om te annuleren' , staleSizeNotice: 'Deze maat wordt niet meer herkend door Vinted (oude identificator, sindsdien vervangen). Selecteer de maat opnieuw op de artikelpagina en probeer het dan nogmaals. Er is niets gewijzigd of verwijderd.', staleSizeViewButton: 'Artikel bekijken', },
    pl: { relistButton: 'Opublikuj ponownie', relistAllButton: 'Opublikuj wszystko ponownie', articles: 'przedmiotów', preparing: 'Przygotowywanie…', nothingToRelist: 'Brak aktywnych przedmiotów do ponownej publikacji.', clickToCancel: 'Kliknij, aby anulować' , staleSizeNotice: 'Ten rozmiar nie jest już rozpoznawany przez Vinted (stary identyfikator, od tamtej pory zastąpiony). Wybierz go ponownie na stronie ogłoszenia, a następnie spróbuj jeszcze raz. Nic nie zostało zmienione ani usunięte.', staleSizeViewButton: 'Zobacz ogłoszenie', },
    cs: { relistButton: 'Znovu zveřejnit', relistAllButton: 'Znovu zveřejnit vše', articles: 'položek', preparing: 'Příprava…', nothingToRelist: 'Žádné aktivní položky k opětovnému zveřejnění.', clickToCancel: 'Kliknutím zrušíte' , staleSizeNotice: 'Tuto velikost už Vinted nerozpoznává (starý identifikátor, mezitím nahrazený). Vyber ji znovu na stránce inzerátu a zkus to znovu. Nic nebylo změněno ani smazáno.', staleSizeViewButton: 'Zobrazit inzerát', },
    sk: { relistButton: 'Znova zverejniť', relistAllButton: 'Znova zverejniť všetko', articles: 'položiek', preparing: 'Príprava…', nothingToRelist: 'Žiadne aktívne položky na opätovné zverejnenie.', clickToCancel: 'Kliknutím zrušíte' , staleSizeNotice: 'Túto veľkosť už Vinted nerozpoznáva (starý identifikátor, odvtedy nahradený). Vyber ju znova na stránke inzerátu a skús to znova. Nič nebolo zmenené ani vymazané.', staleSizeViewButton: 'Zobraziť inzerát', },
    hu: { relistButton: 'Újraközzététel', relistAllButton: 'Összes újraközzététele', articles: 'termék', preparing: 'Előkészítés…', nothingToRelist: 'Nincs újraközzétehető aktív termék.', clickToCancel: 'Kattintson a megszakításhoz' , staleSizeNotice: 'A Vinted már nem ismeri fel ezt a méretet (régi azonosító, azóta lecserélve). Válaszd ki újra a termék oldalán, majd próbáld újra. Semmi nem változott vagy törlődött.', staleSizeViewButton: 'Termék megtekintése', },
    ro: { relistButton: 'Republică', relistAllButton: 'Republică tot', articles: 'articole', preparing: 'Se pregătește…', nothingToRelist: 'Niciun articol activ de republicat.', clickToCancel: 'Clic pentru a anula' , staleSizeNotice: 'Vinted nu mai recunoaște această mărime (identificator vechi, înlocuit între timp). Reselecteaz-o pe pagina articolului, apoi încearcă din nou. Nimic nu a fost modificat sau șters.', staleSizeViewButton: 'Vezi articolul', },
    bg: { relistButton: 'Публикувай отново', relistAllButton: 'Публикувай всичко отново', articles: 'артикула', preparing: 'Подготовка…', nothingToRelist: 'Няма активни артикули за повторно публикуване.', clickToCancel: 'Кликнете за отказ' , staleSizeNotice: 'Vinted вече не разпознава този размер (стар идентификатор, оттогава заменен). Избери го отново на страницата на артикула, след което опитай пак. Нищо не е променено или изтрито.', staleSizeViewButton: 'Виж артикула', },
    lt: { relistButton: 'Paskelbti iš naujo', relistAllButton: 'Paskelbti viską iš naujo', articles: 'prekių', preparing: 'Ruošiama…', nothingToRelist: 'Nėra aktyvių prekių pakartotiniam skelbimui.', clickToCancel: 'Spustelėkite, kad atšauktumėte' , staleSizeNotice: '„Vinted“ nebeatpažįsta šio dydžio (senas identifikatorius, nuo tada pakeistas). Pasirink jį iš naujo skelbimo puslapyje ir bandyk dar kartą. Niekas nebuvo pakeista ar ištrinta.', staleSizeViewButton: 'Peržiūrėti skelbimą', },
    lv: { relistButton: 'Publicēt atkārtoti', relistAllButton: 'Publicēt visu atkārtoti', articles: 'preces', preparing: 'Sagatavo…', nothingToRelist: 'Nav aktīvu preču atkārtotai publicēšanai.', clickToCancel: 'Noklikšķiniet, lai atceltu' , staleSizeNotice: 'Vinted vairs neatpazīst šo izmēru (vecs identifikators, kopš tā laika aizstāts). Izvēlies to no jauna sludinājuma lapā un mēģini vēlreiz. Nekas netika mainīts vai dzēsts.', staleSizeViewButton: 'Skatīt sludinājumu', },
    et: { relistButton: 'Avalda uuesti', relistAllButton: 'Avalda kõik uuesti', articles: 'eset', preparing: 'Ettevalmistamine…', nothingToRelist: 'Uuesti avaldamiseks pole aktiivseid esemeid.', clickToCancel: 'Klõpsake tühistamiseks' , staleSizeNotice: 'Vinted ei tunne enam seda suurust (vana identifikaator, vahepeal asendatud). Vali see uuesti kuulutuse lehel ja proovi siis uuesti. Midagi ei muudetud ega kustutatud.', staleSizeViewButton: 'Vaata kuulutust', },
    el: { relistButton: 'Αναδημοσίευση', relistAllButton: 'Αναδημοσίευση όλων', articles: 'αντικείμενα', preparing: 'Προετοιμασία…', nothingToRelist: 'Δεν υπάρχουν ενεργά αντικείμενα για αναδημοσίευση.', clickToCancel: 'Κάντε κλικ για ακύρωση' , staleSizeNotice: 'Το Vinted δεν αναγνωρίζει πλέον αυτό το μέγεθος (παλιό αναγνωριστικό, έχει αντικατασταθεί έκτοτε). Επίλεξέ το ξανά στη σελίδα της αγγελίας και δοκίμασε ξανά. Δεν άλλαξε ούτε διαγράφηκε τίποτα.', staleSizeViewButton: 'Προβολή αγγελίας', },
    sl: { relistButton: 'Znova objavi', relistAllButton: 'Znova objavi vse', articles: 'izdelkov', preparing: 'Priprava…', nothingToRelist: 'Ni aktivnih izdelkov za ponovno objavo.', clickToCancel: 'Kliknite za preklic' , staleSizeNotice: 'Vinted te velikosti ne prepozna več (star identifikator, od takrat zamenjan). Znova jo izberi na strani izdelka in nato poskusi znova. Nič ni bilo spremenjeno ali izbrisano.', staleSizeViewButton: 'Ogled izdelka', },
    hr: { relistButton: 'Ponovno objavi', relistAllButton: 'Ponovno objavi sve', articles: 'artikala', preparing: 'Priprema…', nothingToRelist: 'Nema aktivnih artikala za ponovnu objavu.', clickToCancel: 'Kliknite za otkazivanje' , staleSizeNotice: 'Vinted više ne prepoznaje ovu veličinu (stari identifikator, otad zamijenjen). Ponovno je odaberi na stranici artikla, a zatim pokušaj ponovno. Ništa nije promijenjeno ni izbrisano.', staleSizeViewButton: 'Pogledaj artikl', },
    da: { relistButton: 'Genudgiv', relistAllButton: 'Genudgiv alt', articles: 'varer', preparing: 'Forbereder…', nothingToRelist: 'Ingen aktive varer at genudgive.', clickToCancel: 'Klik for at annullere' , staleSizeNotice: 'Vinted genkender ikke længere denne størrelse (gammelt id, siden erstattet). Vælg den igen på varens side, og prøv derefter igen. Intet er blevet ændret eller slettet.', staleSizeViewButton: 'Se vare', },
    sv: { relistButton: 'Publicera igen', relistAllButton: 'Publicera om allt', articles: 'artiklar', preparing: 'Förbereder…', nothingToRelist: 'Inga aktiva artiklar att publicera igen.', clickToCancel: 'Klicka för att avbryta' , staleSizeNotice: 'Vinted känner inte längre igen den här storleken (gammalt id, ersatt sedan dess). Välj den igen på artikelsidan och försök sedan igen. Inget har ändrats eller tagits bort.', staleSizeViewButton: 'Visa artikel', },
    nb: { relistButton: 'Publiser på nytt', relistAllButton: 'Publiser alt på nytt', articles: 'artikler', preparing: 'Forbereder…', nothingToRelist: 'Ingen aktive artikler å publisere på nytt.', clickToCancel: 'Klikk for å avbryte' , staleSizeNotice: 'Vinted gjenkjenner ikke lenger denne størrelsen (gammel id, erstattet siden). Velg den på nytt på annonsesiden, og prøv deretter igjen. Ingenting er endret eller slettet.', staleSizeViewButton: 'Se annonse', },
    fi: { relistButton: 'Julkaise uudelleen', relistAllButton: 'Julkaise kaikki uudelleen', articles: 'tuotetta', preparing: 'Valmistellaan…', nothingToRelist: 'Ei aktiivisia tuotteita uudelleenjulkaisuun.', clickToCancel: 'Peruuta napsauttamalla' , staleSizeNotice: 'Vinted ei enää tunnista tätä kokoa (vanha tunniste, sittemmin korvattu). Valitse se uudelleen ilmoituksen sivulla ja yritä sitten uudelleen. Mitään ei ole muutettu tai poistettu.', staleSizeViewButton: 'Näytä ilmoitus', },
  };

  const UI_EN = {
    closeButton: 'Close',
    missingItemIdNotice: 'The listing ID could not be determined.',
    collectingListings: 'Collecting listings…',
    confirmBulk: 'Republish all {count} active listings?',
    confirmBulkAdd: 'Add {count} listings to the queue?',
    confirmBulkResume: 'Resume preparation from page {page} of {pages}, then republish the listings?',
    bulkAlreadyQueued: 'Every active listing is already being republished.',
    bulkAllErrored: 'The remaining listings are all in error — check the errors page to resume them.',
    bulkDuration: 'Estimated republishing time: about {duration}, based on the delays and limits set in your',
    configurationLink: 'Configuration',
    manualQueueWait: 'Queue {position} — due at {time}',
    queueSummaryButton: 'Queue: {count} - Ends: {time}',
    bulkNext: '{progress} — next listing in {timer}',
    bulkFinished: '{count}/{total} listings republished.',
    confirmButton: 'Republish',
    cancelButton: 'Cancel',
    phaseCollect: 'Collecting…', phasePhotos: 'Processing photos...',
    phaseCreate: 'Creating…',
    phaseVerify: 'Verifying…',
    phaseDelete: 'Deleting original…',
    phaseCleanup: 'Deleting the unverified copy…',
    republishCopyRemovedNotice: 'Verification failed. The new listing was deleted; the original and local backup were kept.',
    republishCleanupPendingNotice: 'The new listing could not be confirmed deleted and may still be online. The original has not been deleted. Open the details to resume cleanup.',
  };

  const UI_FR = {
    closeButton: 'Fermer',
    missingItemIdNotice: 'Impossible de déterminer l’identifiant de l’article.',
    collectingListings: 'Collecte des annonces…',
    confirmBulk: 'Republier les {count} annonces actives ?',
    confirmBulkAdd: 'Ajouter {count} annonces à la file d\'attente ?',
    confirmBulkResume: 'Reprendre la préparation à la page {page} sur {pages}, puis republier les annonces ?',
    bulkAlreadyQueued: 'Toutes les annonces actives sont déjà en cours de republication.',
    bulkAllErrored: 'Les annonces restantes sont toutes en erreur — consulte la page des erreurs pour les reprendre.',
    bulkDuration: 'Durée estimée de republication : environ {duration}, selon vos délais et limites configurés dans votre',
    configurationLink: 'Configuration',
    manualQueueWait: 'En attente {position} · prévu à {time}',
    queueSummaryButton: 'Liste d\'attente : {count} - Fin : {time}',
    bulkNext: '{progress} — prochaine annonce dans {timer}',
    bulkFinished: '{count}/{total} annonces republiées.',
    confirmButton: 'Republier',
    cancelButton: 'Annuler',
    phaseCollect: 'Collecte…', phasePhotos: 'Traitement des photos...',
    phaseCreate: 'Création…',
    phaseVerify: 'Vérification…',
    phaseDelete: 'Suppression de l’original…',
    phaseCleanup: 'Suppression de la copie non validée…',
    republishCopyRemovedNotice: 'La vérification a échoué. La nouvelle annonce a été supprimée ; l’original et la sauvegarde locale sont conservés.',
    republishCleanupPendingNotice: 'La suppression de la nouvelle annonce n’a pas pu être confirmée : elle peut encore être en ligne. L’original n’a pas été supprimé. Ouvrez les détails pour reprendre le nettoyage.',
  };

  Object.assign(UI_EN, {
    phaseBackup: 'Saving the local backup…', phaseCooldown: 'Republishing in {seconds}s…',
    pendingButton: 'Listings to republish',
    transferAccountButton: 'Transfer to another account',
    publicPageIncomplete: 'The listing page is incomplete. Open the listing on Vinted, refresh the page and check that you are signed in. Complete any verification shown, then retry.',
    successButton: 'Republished', retryButton: 'Retry',
    bulkQueuedNotice: '{added} new listing(s) added locally out of {total}.',
    bulkCachedNotice: 'All {total} listings from the recent scan are already in the local queue.',
    bulkInterruptedNotice: 'The scan was interrupted after {count} listings. They remain saved locally; click Republish all to resume.',
    missingAccountNotice: 'The wardrobe account could not be identified.',
    preparingPage: 'Preparing {page}/{pages}…',
    errorDetailsButton: 'Error: view details', errorDetailsAction: 'View details',
    republishFailureNotice: 'Republishing failed: {error} The listing and error were saved locally in Listings to republish so you can try again later.',
    republishFailurePartialNotice: 'Republishing failed: {error} The error and the available listing information were saved locally in Listings to republish so you can try again later.',
    republishErrorRestricted: 'Vinted is refusing account operations because the account appears to be temporarily restricted.',
    republishErrorAuth: 'Vinted refused authentication. Reload the page and check the session before trying again.',
    republishErrorAccount: 'The connected Vinted account does not match this listing.',
    republishErrorRateLimit: 'Vinted temporarily limited the requests.', republishErrorAntiBot: 'Vinted blocked the request with an anti-bot check.',
    republishErrorLimit: 'Your configured hourly/daily republishing limit was reached. It will resume once the limit resets.',
    republishErrorBusy: 'A republication is already running in another tab.',
    republishErrorPhotos: 'The listing photos could not all be saved or transferred.', republishErrorStorage: 'The local backup could not be verified.',
    republishErrorMissing: 'The original listing could not be found.', republishErrorGeneric: 'An unexpected step failed.',
  });
  Object.assign(UI_FR, {
    phaseBackup: 'Sauvegarde locale…', phaseCooldown: 'Republication dans {seconds}s…',
    pendingButton: 'Annonces à republier',
    transferAccountButton: 'Transférer vers un autre compte',
    publicPageIncomplete: 'La page de l’annonce est incomplète. Ouvrez l’annonce sur Vinted, actualisez la page et vérifiez votre connexion. Terminez toute vérification affichée, puis réessayez.',
    successButton: 'Republié', retryButton: 'Réessayer',
    bulkQueuedNotice: '{added} nouvelle(s) annonce(s) ajoutée(s) localement sur {total}.',
    bulkCachedNotice: 'Les {total} annonces du scan récent sont déjà dans la file locale.',
    bulkInterruptedNotice: 'Le scan a été interrompu après {count} annonces. Elles restent sauvegardées localement ; cliquez sur Tout republier pour reprendre.',
    missingAccountNotice: 'Impossible d’identifier le compte propriétaire du dressing.',
    preparingPage: 'Préparation {page}/{pages}…',
    errorDetailsButton: 'Erreur : voir les détails', errorDetailsAction: 'Voir les détails',
    republishFailureNotice: 'La republication a échoué : l’annonce et le rapport d’erreur a été sauvegardées localement afin de réessayer plus tard.',
    republishFailurePartialNotice: 'La republication a échoué : l’annonce et le rapport d’erreur a été sauvegardées localement afin de réessayer plus tard.',
    republishErrorRestricted: 'Vinted refuse les opérations sur le compte, qui semble temporairement restreint.',
    republishErrorAuth: 'Vinted a refusé l’authentification. Rechargez la page et vérifiez la session avant de réessayer.',
    republishErrorAccount: 'Le compte Vinted connecté ne correspond pas à cette annonce.',
    republishErrorRateLimit: 'Vinted a temporairement limité les requêtes.', republishErrorAntiBot: 'Vinted a bloqué la requête avec un contrôle anti-robot.',
    republishErrorLimit: 'La limite horaire/journalière de republication configurée a été atteinte. La reprise se fera automatiquement une fois la limite réinitialisée.',
    republishErrorBusy: 'Une republication est déjà en cours sur un autre onglet.',
    republishErrorPhotos: 'Toutes les photos de l’annonce n’ont pas pu être sauvegardées ou transférées.', republishErrorStorage: 'La sauvegarde locale n’a pas pu être vérifiée.',
    republishErrorMissing: 'L’annonce originale est introuvable.', republishErrorGeneric: 'Une étape inattendue a échoué.',
  });
  const UI_IT = {
    closeButton: 'Chiudi',
    missingItemIdNotice: 'Identificativo dell’annuncio non trovato.',
    collectingListings: 'Raccolta degli annunci…',
    confirmBulk: 'Ripubblicare tutti i {count} annunci attivi?',
    confirmBulkAdd: 'Aggiungere {count} annunci alla coda?',
    confirmBulkResume: 'Riprendere la preparazione dalla pagina {page} di {pages}, poi ripubblicare gli annunci?',
    bulkAlreadyQueued: 'Tutti gli annunci attivi sono già in fase di ripubblicazione.',
    bulkAllErrored: 'Gli annunci rimanenti sono tutti in errore — controlla la pagina degli errori per riprenderli.',
    bulkDuration: 'Tempo stimato di ripubblicazione: circa {duration}, secondo i ritardi e i limiti impostati nella',
    configurationLink: 'Configurazione',
    manualQueueWait: 'In coda · {position} — previsto per le {time}',
    queueSummaryButton: 'Coda: {count} - Fine: {time}',
    bulkNext: '{progress} — prossimo annuncio tra {timer}',
    bulkFinished: '{count}/{total} annunci ripubblicati.',
    confirmButton: 'Ripubblica', cancelButton: 'Annulla',
    phaseCollect: 'Raccolta…', phasePhotos: 'Elaborazione delle foto...', phaseCreate: 'Creazione…', phaseVerify: 'Verifica…', phaseDelete: 'Eliminazione dell’originale…',
    phaseCleanup: 'Eliminazione della copia non verificata…',
    republishCopyRemovedNotice: 'La verifica non è riuscita. Il nuovo annuncio è stato eliminato; l’originale e il backup locale sono stati conservati.',
    republishCleanupPendingNotice: 'L’eliminazione del nuovo annuncio non è confermata: potrebbe essere ancora online. L’originale non è stato eliminato. Apri i dettagli per riprendere la pulizia.',
    phaseBackup: 'Salvataggio locale…', phaseCooldown: 'Ripubblicazione tra {seconds}s…',
    pendingButton: 'Annunci da ripubblicare',
    transferAccountButton: 'Trasferisci su un altro account',
    publicPageIncomplete: 'La pagina è incompleta. Apri l’annuncio su Vinted, aggiorna la pagina e controlla la connessione al tuo account. Completa eventuali verifiche, poi riprova.',
    successButton: 'Ripubblicato', retryButton: 'Riprova',
    bulkQueuedNotice: '{added} nuovo/i annuncio/i aggiunto/i localmente su {total}.',
    bulkCachedNotice: 'Tutti i {total} annunci della scansione recente sono già nella coda locale.',
    bulkInterruptedNotice: 'La scansione si è interrotta dopo {count} annunci. Restano salvati localmente; clicca Ripubblica tutto per riprendere.',
    missingAccountNotice: 'Impossibile identificare il proprietario del guardaroba.',
    preparingPage: 'Preparazione {page}/{pages}…',
    errorDetailsButton: 'Errore: vedi dettagli', errorDetailsAction: 'Vedi dettagli',
    republishFailureNotice: 'Ripubblicazione non riuscita: {error} L’annuncio e l’errore sono stati salvati localmente in Annunci da ripubblicare per riprovare più tardi.',
    republishFailurePartialNotice: 'Ripubblicazione non riuscita: {error} L’errore e le informazioni disponibili sono stati salvati localmente in Annunci da ripubblicare per riprovare più tardi.',
    republishErrorRestricted: 'Vinted rifiuta le operazioni perché l’account sembra temporaneamente limitato.',
    republishErrorAuth: 'Vinted ha rifiutato l’autenticazione. Ricarica la pagina e controlla la sessione prima di riprovare.',
    republishErrorAccount: 'L’account Vinted connesso non corrisponde a questo annuncio.',
    republishErrorRateLimit: 'Vinted ha temporaneamente limitato le richieste.', republishErrorAntiBot: 'Vinted ha bloccato la richiesta con un controllo anti-bot.',
    republishErrorLimit: 'Il limite orario/giornaliero di ripubblicazione configurato è stato raggiunto. La ripresa avverrà automaticamente al reset del limite.',
    republishErrorBusy: 'Una ripubblicazione è già in corso in un\'altra scheda.',
    republishErrorPhotos: 'Non è stato possibile salvare o trasferire tutte le foto.', republishErrorStorage: 'Non è stato possibile verificare il backup locale.',
    republishErrorMissing: 'L’annuncio originale non è stato trovato.', republishErrorGeneric: 'Si è verificato un errore imprevisto.',
  };
  Object.assign(STRINGS.en, UI_EN);
  Object.assign(STRINGS.fr, UI_EN, UI_FR);
  Object.assign(STRINGS.it, UI_EN, UI_IT);

  // Repli par domaine (TLD → langue) si document.documentElement.lang est
  // absent ou non reconnu. Approximatif pour les pays multilingues (ex.
  // Suisse, Belgique) — l'attribut lang réel de la page prime toujours.
  const TLD_TO_LANG = {
    fr: 'fr', de: 'de', it: 'it', es: 'es', pt: 'pt', nl: 'nl', be: 'nl',
    pl: 'pl', cz: 'cs', sk: 'sk', hu: 'hu', ro: 'ro', bg: 'bg', lt: 'lt',
    lv: 'lv', ee: 'et', gr: 'el', si: 'sl', hr: 'hr', ie: 'en', at: 'de',
    ch: 'de', dk: 'da', se: 'sv', no: 'nb', fi: 'fi', com: 'en', uk: 'en',
  };

  function detectLang() {
    if (NS.language) return NS.language;
    try {
      const htmlLang = (document.documentElement.lang || '').split('-')[0].toLowerCase();
      if (htmlLang && STRINGS[htmlLang]) return htmlLang;
    } catch (_) {}
    try {
      const parts = location.hostname.split('.');
      const tld = parts[parts.length - 1];
      if (TLD_TO_LANG[tld]) return TLD_TO_LANG[tld];
    } catch (_) {}
    return 'en';
  }

  // Le logo est ajouté comme image par src/dom.js afin de rester net et
  // identique dans toutes les langues. Les traductions ne contiennent donc
  // ici que le texte du bouton.
  let cached = null;
  NS.resetLanguage = () => { cached = null; };
  NS.i18n = function i18n() {
    if (!cached) {
      cached = Object.assign({}, UI_EN, STRINGS[detectLang()] || STRINGS.en);
    }
    return cached;
  };
})();
