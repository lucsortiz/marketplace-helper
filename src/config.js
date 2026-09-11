// src/config.js
// Configuration livrée avec l'extension. Aucun comportement distant.
(function () {
  const NS = (window.__VintedRelister = window.__VintedRelister || {});

  const DEFAULT_CONFIG = {
    schemaVersion: 3,

    selectors: {
      // Plusieurs candidats testés dans l'ordre ; le premier qui matche gagne.
      itemCard: ['[data-testid^="product-item-id-"]'],
      bumpButton: [
        'button[data-testid="bump-button"]',
        'button[data-testid="vas-bump"]'
      ]
    },

    endpoints: {
      wardrobeItems: '/api/v2/wardrobe/{memberId}/items',
      itemUploadDetails: '/api/v2/item_upload/items/{itemId}',
      itemDetailsFallback: '/api/v2/items/{itemId}',
      photos: '/api/v2/photos',
      createItem: '/api/v2/item_upload/items',
      deleteItem: '/api/v2/items/{itemId}/delete',
      newItemPage: '/items/new'
    },

    headers: {
      csrf: 'x-csrf-token',
      anonId: 'x-anon-id'
    },

    csrf: {
      // Motifs essayés dans l'ordre contre le HTML de la page. Conservés
      // même si aucun ne matche plus la page live actuelle (SPA), pour que
      // l'extension se répare gratuitement si Vinted réintroduit un jour un
      // token inline.
      htmlPatterns: [
        '"CSRF_TOKEN"\\s*:\\s*"([^"]+)"',
        '<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"',
        '"csrfToken"\\s*:\\s*"([^"]+)"',
        '"csrf_token"\\s*:\\s*"([^"]+)"'
      ],
      // Combien de temps attendre que background.js capture passivement un
      // token émis par les propres requêtes de l'app Vinted, avant d'abandonner.
      waitForBackgroundMs: 3000,
      pollIntervalMs: 250
    }
  };

  NS.DEFAULT_CONFIG = DEFAULT_CONFIG;
})();
