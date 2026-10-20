// Chargé avant chaque fichier de test : aucune requête ne sort de la machine (ni le site, ni IGN, ni Transitous,
// ni les API LLM). Un test qui oublie d'injecter un faux service échoue au lieu d'appeler le vrai.
const HOTES_LOCAUX = new Set(['localhost', '127.0.0.1', '[::1]']);
const fetchReel = globalThis.fetch;

globalThis.fetch = (entree, init) => {
  const url = new URL(entree instanceof Request ? entree.url : entree);
  if (!HOTES_LOCAUX.has(url.hostname)) {
    return Promise.reject(new Error(`Test : requête réseau vers ${url.origin} interdite (injecter un faux service)`));
  }
  return fetchReel(entree, init);
};
