# csp-cli

Veille quotidienne des offres d'emploi de [Choisir le service public](https://choisirleservicepublic.gouv.fr/) : base SQLite
locale, résumés éditoriaux, temps de trajet en transports en commun. Usage personnel (voir [CONFORMITE.md](CONFORMITE.md)).

État : phases 0 à 7 du [plan](PLAN.md) (reconnaissance, socle, base, liste et détail des offres, géocodage et trajets,
résumés, gestion de casse), et l'application de consultation (`csp web`). Restent la planification et le rapport.

## Installation

Prérequis : [Vite+](https://viteplus.dev) (`vp`), [gitleaks](https://github.com/gitleaks/gitleaks) (hook de pré-commit).

```bash
vp install
```

L'installation active le hook `pre-commit` (gitleaks). npm et yarn sont refusés.

## Configuration

Les données restent hors du dépôt, dans `~/.config/csp-cli/` (variable `CSP_HOME` pour changer) :

```bash
mkdir -m 700 -p ~/.config/csp-cli
cp config/recherches.example.yaml ~/.config/csp-cli/recherches.yaml
cp .env.example ~/.config/csp-cli/.env
chmod 600 ~/.config/csp-cli/.env ~/.config/csp-cli/recherches.yaml
```

- `recherches.yaml` : recherches lancées chaque jour (mots-clés, localisation, catégories, versants…).
- `recherches.yaml` donne aussi, par recherche, le point de départ des trajets (`depart` : « Gare d'Austerlitz », adresse ou
  `lat,lon`) ; `csp doctor` affiche le lieu retenu.
- `.env` : heure de départ des trajets, et fournisseur des
  résumés : `CSP_LLM_FOURNISSEUR=anthropic` (Claude, `claude-opus-5-5` par défaut, clé dans `CSP_LLM_CLE` ou `ANTHROPIC_API_KEY`) ou `albert` (API Albert d'Etalab,
  `CSP_LLM_MODELE` obligatoire), avec la clé dans `CSP_LLM_CLE`. Voir `.env.example`.

## Commandes

`vp run csp …` (ou `pnpm csp …`) ; jamais mis en cache par Vite+, chaque appel s'exécute vraiment.

```bash
vp run csp doctor
vp run csp collecte [--dry-run] [--recherche <nom>] [--json]
vp run csp trajets [--recalculer] [--json]
vp run csp resumer [--limite <n>] [--json]
vp run csp a-resumer [--json]
vp run csp resume enregistrer <id> <fichier.json>
vp run csp purge [--dry-run] [--json]
vp run csp web [--port <n>]
```

`csp web` ouvre l'application de consultation sur http://127.0.0.1:4321 : cartes des offres, détail (résumé, points
d'attention, trajets), filtres (recherche, nouveautés, trajet maximum, rémunération, télétravail, catégorie, contrat,
management, département, statut) et tri. Les filtres sont rangés dans l'URL : un marque-page rouvre la même vue.
Lecture seule de la base, aucun appel réseau sortant, écoute locale seulement. L'application (React, Tailwind,
shadcn/ui, dossier `web/`) se compile une fois avec `vp run web:build` ; `vp run web:dev` pour la modifier à chaud
(avec `csp web` lancé à côté pour l'API).

En cas de casse du site (code 2), le diagnostic (étape, sélecteur, URL, HTML de la page) est sauvegardé dans
`~/.config/csp-cli/diagnostics/<jour>/` ; son chemin est affiché après le message d'erreur.

| Code de sortie | Signification                                            |
| -------------- | -------------------------------------------------------- |
| 0              | OK                                                       |
| 1              | Autre erreur                                             |
| 2              | Casse du site (structure modifiée)                       |
| 3              | Site indisponible / réseau                               |
| 4              | Blocage (captcha, 403, 429) : arrêt, aucun contournement |

## Développement

```bash
vp run ready         # vp check && vp test && vp build web
pnpm secrets:scan    # gitleaks sur l'historique et les fichiers non commités
```

## Sources

- Offres : Choisir le service public (DGAFP), Licence Etalab 2.0.
- Géocodage : [Géoplateforme IGN](https://geoservices.ign.fr/documentation/services/services-geoplateforme/geocodage)
  (Base Adresse Nationale, Licence Etalab 2.0).
- Trajets : [Transitous](https://transitous.org), service bénévole ; données de transport et OpenStreetMap :
  [sources et licences](https://transitous.org/sources/).
