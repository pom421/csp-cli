# Reconnaissance du site (phase 0)

Relevé du 19/10/2026 sur https://choisirleservicepublic.gouv.fr, une dizaine de requêtes espacées (curl + navigateur).
Fixtures correspondantes dans `src/test/fixtures/` (cases à cocher des organismes et lieux, scripts et styles retirés ; contacts recruteurs
pseudonymisés). Complété le 19/10/2026 au soir (phase 3) : segments d'URL, versant, géolocalisation, références.

## Constat principal : pages rendues côté serveur

- La liste et le détail sont du **HTML complet renvoyé par WordPress** (thème `biep`, DSFR). Aucun appel XHR n'est nécessaire pour lire les cartes.
- `curl` avec un user-agent simple obtient une réponse 200 complète : **pas d'anti-bot** constaté (ni captcha, ni défi JS, ni 403).
- Conséquence : **Playwright n'est pas nécessaire** pour la collecte. `fetch` + un parseur HTML suffit, ce qui est plus rapide, plus léger
  (pas de Chromium à installer) et plus simple à tester (fixtures sans navigateur). → décision à valider avant la phase 3.
- Un cookie `PHPSESSID` est posé à chaque réponse : on l'ignore (aucun cookie conservé).
- Un bandeau de cookies apparaît dans un navigateur ; sans effet sur le HTML servi.

## URL de recherche

Base : `/nos-offres/`. Le JS du site transforme le formulaire en **segments de chemin** :

```
/nos-offres/filtres/<segment>/<valeur>/<segment>/<valeur>/…/page/<n>/
```

Exemples vérifiés :

| Recherche                                       | URL                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Mot-clé                                         | `/nos-offres/filtres/mot-cles/chef%20de%20projet%20num%C3%A9rique/`     |
| Région Centre-Val de Loire, cat. A, télétravail | `/nos-offres/filtres/localisation/202/categorie/1805/teletravail/1814/` |
| Page 2 de la précédente                         | `…/teletravail/1814/page/2/`                                            |
| Domaine                                         | `/nos-offres/filtres/domaine/3503/`                                     |

- `GET /nos-offres?s=…` redirige (301) vers `/nos-offres/?s=…` mais **n'applique pas** le mot-clé : il faut le segment `mot-cles`.
- Table complète des segments, lue dans le JS du site (`window.ParamsDataSearch.url_keywords`), dans l'ordre d'écriture :
  `mot-cles`, `localisation`, `domaine`, `versant`, `categorie`, `organisme`, `type`, `management`, `teletravail`, `experience`,
  `geoloc`, `regions`, `date-de-publication`, puis `tri/<ordre>`. Valeurs multiples jointes par `-` ; dans le mot-clé, `/` devient `---`.
- **Versant** : le formulaire le traduit en liste d'organismes (`organisme/7060-10661-…`), et `versant/2458` saisi à la main renvoie
  des offres des trois versants. → **filtrage local** sur le libellé « Fonction publique : » de la carte. Certaines cartes affichent
  seulement « Fonction publique » (sans versant) : elles sont conservées.
- **Géolocalisation** (`geoloc/<lat>/<lon>/<rayon>`, points remplacés par `_`) : acceptée dans l'URL mais **non filtrée** côté serveur
  (résultats de toute la France). → départements/régions côté site, commune + rayon filtrés localement après géocodage (phase 5).
- Département ou région (`localisation/263-262`) : filtrage serveur vérifié (cartes toutes dans le Loiret et le Loir-et-Cher).

### Valeurs des filtres (identifiants internes du site)

| Filtre (formulaire)            | Segment d'URL          | Valeurs relevées                                                                                                       |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `s` (mot-clé)                  | `mot-cles`             | texte, encodé en URL                                                                                                   |
| `regions[]` / départements     | `localisation`         | régions : Centre-Val de Loire `202`, Île-de-France `208`, … ; départements : Loiret `263`, Paris `284`, …              |
| `geolocation-range`            | `geoloc` (inopérant)   | 5, 10, 20, 30, 40, 50, 100 km (nécessite une géolocalisation)                                                          |
| `categories[]`                 | `categorie`            | A+ `4327-4328`, A `1805`, B `1806`, C `1807`                                                                           |
| `versants[]`                   | `versant` (peu fiable) | FPE `2456`, FPH `2457`, FPT `2458`                                                                                     |
| `jobs[]` (nature de l'emploi)  | `type`                 | titulaires et contractuels `2349`, fonctionnaires/lauréats concours territorial `4534`, contractuels uniquement `2267` |
| `experiences[]`                | `experience`           | débutant `1835`, confirmé `1834`, expert `1833`                                                                        |
| `date_de_publication[]`        | `date-de-publication`  | `dernieres_48_heures`, `7_derniers_jours`, `14_derniers_jours`                                                         |
| télétravail (interrupteur)     | `teletravail`          | `1814`                                                                                                                 |
| management (interrupteur)      | `management`           | `1814`                                                                                                                 |
| `domains[]`, `organisations[]` | `domaine`, `organisme` | listes longues, à extraire si besoin                                                                                   |

Ces identifiants viennent de la base du site et peuvent changer : `recherches.yaml` utilisera des noms lisibles (`categories: [A]`)
traduits par une table de correspondance unique dans le code, testée sur la fixture.

## Pagination

- **20 cartes par page**, liens `<a class="fr-pagination__link" href="…/page/N/" title="Page N">`, lien suivant `fr-pagination__link--next`, dernier `fr-pagination__link--last`.
- Titre de la page : `Offres d'emploi (page 1 sur 2135)` sans mot-clé ; sans « page X sur N » avec mot-clé.
- **Plafond probable de 200 pages** (le sélecteur de page et le lien « dernière page » s'arrêtent à 200, soit 4 000 offres) : une recherche
  doit rester assez étroite. `csp collecte` devra signaler une recherche qui atteint le plafond (résultat tronqué = collecte incomplète).
- La recherche par mot-clé semble large (« chef de projet numérique » → 200 pages) : à combiner avec des filtres.

## Carte (liste)

Sélecteur : `div.fr-card.fr-card--offer`. Contenu :

- Lien : `h3 a[href^="https://choisirleservicepublic.gouv.fr/offre-emploi/"]`, texte = titre.
- `ul.fr-tags-group p.fr-tag` : domaine (ex. « Enseignement et formation »).
- `ul.fr-card__desc li`, repérables par leur icône et leur `span.sr-only` :
  - `fr-icon-map-pin-2-line` « Localisation : » → département + `(72)`
  - `fr-icon-file-line` « Fonction publique : » → versant
  - `fr-icon-user-line` « Employeur : »
  - `fr-icon-calendar-line` → « En ligne depuis le 19 octobre 2026 » (date de publication, pas de date de mise à jour)

## Identifiant stable

- URL : `/offre-emploi/<slug-du-titre>-reference-<référence>/`
- Référence affichée sur la page détail (`Réf.` / « Référence : ») : ex. `2026-2445380`, `MENJ-12-2026-49359`, `O006260612001543`.
- **`id_offre` = référence**, extraite de la page détail et contrôlée contre la fin de l'URL. Le slug change si le titre change : ne pas l'utiliser comme clé.

## Page détail

Deux sources concordantes :

1. **JSON-LD `JobPosting`** (`<script type="application/ld+json">`) : `title`, `hiringOrganization`, `jobLocation.address`
   (`addressRegion`, `postalCode` = « Alpes Maritimes (06) »), `baseSalary`, `experienceRequirements`, `Description`, `skills`,
   `datePosted` (format `JJ/MM/AAAA`), `industry` (domaine), `educationRequirements`. Pas de `dateModified`, pas de `validThrough`.
2. **Zones structurées HTML** :
   - En-tête : référence (`p.number`), versant, employeur (`li.ic--user`), localisation (`li.ic--pin`), domaine.
   - « Date limite de candidature : 16/11/2026 » (paragraphe sous le bouton Postuler).
   - Tableau `ul.table > li.table-cell` : `<strong>Libellé</strong>` + valeur — Nature de l'emploi, Expérience souhaitée, Rémunération
     (fourchettes contractuels / fonctionnaires, `span.offer-result`), Catégorie, Management, Télétravail possible.
     Valeur « Non renseigné(e) » fréquente → `null`.
   - Texte libre (`div.col-left.rte`) : sections `h2` « Vos missions en quelques mots », « Profil recherché », puis compétences,
     conditions particulières, contacts.

### Parties volatiles (à exclure de `empreinte_detail`)

- Bloc « offres similaires » en bas de page (6 cartes `fr-card--offer` qui changent d'un jour à l'autre).
- Attributs `nonce` (CSP et WordPress), identifiants générés (`fav-6ad67a…`, `…-checkbox-6ad67a…`) qui changent à chaque requête.
- Aucune date relative (« il y a 3 jours ») ni compteur de vues relevé.
- → l'empreinte portera sur le **texte** du JSON-LD + du tableau + du bloc `rte`, après normalisation des espaces.

### Données personnelles

- Le texte libre contient souvent **noms et e-mails de contacts** (« Personnes à contacter : prenom.nom@… »). Ils ne vont jamais en base
  (CONFORMITE.md, règle 5) ; la fixture est pseudonymisée.
- Un lien PDF pointe vers `/wp-content/uploads/pdf-offers/…` : interdit par robots.txt, jamais suivi.

## Sitemap et flux

- `/sitemapindex.xml` : généré par Screaming Frog, tous les `lastmod` au **14/04/2023** → **inutilisable** pour détecter les mises à jour.
- Flux RSS : le lien de la page pointe vers un domaine tiers (`place-ep-recrute.talent-soft.com`), hors liste blanche → non utilisé.
- Pas de date de modification fiable : on re-télécharge le détail des offres actives (optimisation du PLAN §4 abandonnée), Claude ne
  re-résume que si `empreinte_detail` change.

## robots.txt (inchangé au 19/10/2026)

```
User-agent: *
Disallow: /wp-admin/
Disallow: /wp-content/uploads/pdf-offers/
Allow: /wp-admin/admin-ajax.php
Sitemap: https://choisirleservicepublic.gouv.fr/sitemapindex.xml
```

## Taille des pages

- Liste : **≈ 4,4 Mo** par page (le formulaire de filtres embarque toutes les cases à cocher). 1 recherche de 5 pages ≈ 22 Mo.
- Détail : ≈ 215 Ko.

## Vérifié en phase 3

- **Page au-delà de la dernière** : HTTP 200, compteur présent, 0 carte (pas de 404). La collecte s'arrête à la première page sans
  lien « suivante » ou sans carte.
- **Aucun résultat** : le titre du bloc de résultats (`.actions p[role="heading"]`) affiche « Aucun résultat ne correspond à votre
  recherche. » au lieu de `<span class="number">N</span> offres d'emploi trouvées` ; sans l'un ni l'autre → page cassée (code 2).
- **Références** : peuvent contenir `_` (`MAE_1aa0659e-d83c-…`, `DEF_18-00064959`, `AGRI_2026-16-A5D4100029-57900`).
- **HTML mal formé** : des `aria-label` contiennent des guillemets non échappés. Un parseur non conforme (node-html-parser) rattache
  alors le compteur au mauvais nœud ; on utilise **parse5** (arbre identique au navigateur) + css-select.
- Plafond de 200 pages : le lien « dernière page » plafonne bien à 200 ; non vérifié au-delà (une recherche ne doit pas l'atteindre).
- Une recherche par mot-clé reste large (le site semble chercher chaque mot) : combiner avec des filtres.

## Vérifié en phase 4 (page détail, 5 offres de versants et ministères différents)

- Structure identique sur toutes : référence (`p.number`), titre (`h1`), employeur (`li.ic--user`, service secondaire après `<br>`),
  lieu (`li.ic--pin`), tableau `ul.table > li.table-cell`, texte libre `div.col-left.rte`.
- **Lieu** très variable : adresse complète (« ROUTE DEPT 97 45400 FLEURY LES AUBRAIS »), commune (« Orléans »), service
  (« Rectorat de l'académie de Nice ») ou département (« Loiret (45), France »). Code postal et commune extraits seulement si
  « NNNNN Commune » ; sinon le texte brut sert au géocodage (phase 5).
- **« À propos de l'offre »** : accordéons DSFR (`section.fr-accordion`, libellé dans `.fr-accordion__btn`, contenu dans
  `.fr-collapse`) — Informations complémentaires, Conditions particulières d'exercice, Fondement juridique,
  **Statut du poste** (« Vacant à partir du 01/12/2026 » → `date_prise_poste`), **Métier de référence** (→ `metier`).
- Management et Télétravail possible : « Oui », « Non » ou « Non renseigné ».
- Contacts : dans « Éléments de candidature » ou au fil du texte (« Personnes à contacter : … ») → retirés du texte brut.
- Sections exclues de l'empreinte et du texte brut : « Qui sommes-nous ? » (présentation générique de l'employeur), offres
  recommandées, attributs générés (`fav-…`, `accordion-…`).
- Deux postes identiques (même titre, employeur, lieu) peuvent être en ligne en même temps sous deux références : une
  republication n'est signalée que si l'offre d'origine n'est plus en ligne.
- Deux collectes successives le même jour : 54 offres inchangées sur 54 (stabilité sur deux jours à confirmer au rodage).
