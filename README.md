# csp-veille

Veille quotidienne des offres d'emploi de [Choisir le service public](https://choisirleservicepublic.gouv.fr/) : base SQLite
locale, résumés éditoriaux, temps de trajet en transports en commun. Usage personnel (voir [CONFORMITE.md](CONFORMITE.md)).

État : phases 0 à 6 du [plan](PLAN.md) (reconnaissance, socle, base, liste et détail des offres, géocodage et trajets,
résumés). Restent la gestion de casse et la planification.

## Installation

Prérequis : [Vite+](https://viteplus.dev) (`vp`), [gitleaks](https://github.com/gitleaks/gitleaks) (hook de pré-commit).

```bash
vp install
```

L'installation active le hook `pre-commit` (gitleaks). npm et yarn sont refusés.

## Configuration

Les données restent hors du dépôt, dans `~/.config/csp-veille/` (variable `CSP_HOME` pour changer) :

```bash
mkdir -m 700 -p ~/.config/csp-veille
cp config/recherches.example.yaml ~/.config/csp-veille/recherches.yaml
cp .env.example ~/.config/csp-veille/.env
chmod 600 ~/.config/csp-veille/*
```

- `recherches.yaml` : recherches lancées chaque jour (mots-clés, localisation, catégories, versants…).
- `.env` : adresse de départ des trajets (`CSP_ORIGINE_TRAJET`, donnée personnelle, adresse ou `lat,lon`), heure de départ, et fournisseur des
  résumés : `CSP_LLM_FOURNISSEUR=anthropic` (Claude, `claude-opus-5-5` par défaut, clé dans `CSP_LLM_CLE` ou `ANTHROPIC_API_KEY`) ou `albert` (API Albert d'Etalab,
  `CSP_LLM_MODELE` obligatoire), avec la clé dans `CSP_LLM_CLE`. Voir `.env.example`.

## Commandes

```bash
pnpm csp doctor
pnpm csp collecte [--dry-run] [--recherche <nom>] [--json]
pnpm csp trajets [--recalculer] [--json]
pnpm csp resumer [--limite <n>] [--json]
pnpm csp a-resumer [--json]
pnpm csp resume enregistrer <id> <fichier.json>
```

| Code de sortie | Signification                                            |
| -------------- | -------------------------------------------------------- |
| 0              | OK                                                       |
| 1              | Autre erreur                                             |
| 2              | Casse du site (structure modifiée)                       |
| 3              | Site indisponible / réseau                               |
| 4              | Blocage (captcha, 403, 429) : arrêt, aucun contournement |

## Développement

```bash
vp run ready         # vp check && vp test
pnpm secrets:scan    # gitleaks sur l'historique et les fichiers non commités
```

## Sources

- Offres : Choisir le service public (DGAFP), Licence Etalab 2.0.
- Géocodage : [Géoplateforme IGN](https://geoservices.ign.fr/documentation/services/services-geoplateforme/geocodage)
  (Base Adresse Nationale, Licence Etalab 2.0).
- Trajets : [Transitous](https://transitous.org), service bénévole ; données de transport et OpenStreetMap :
  [sources et licences](https://transitous.org/sources/).
