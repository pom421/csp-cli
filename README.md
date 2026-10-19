# csp-veille

Veille quotidienne des offres d'emploi de [Choisir le service public](https://choisirleservicepublic.gouv.fr/) : base SQLite
locale, résumés éditoriaux, temps de trajet en transports en commun. Usage personnel (voir [CONFORMITE.md](CONFORMITE.md)).

État : phases 0 (reconnaissance) et 1 (socle) du [plan](PLAN.md). Seule la commande `csp doctor` est disponible.

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
- `.env` : adresse de départ des trajets (`CSP_ORIGINE_TRAJET`, donnée personnelle) et heure de départ.

## Commandes

```bash
pnpm csp doctor
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

Source des offres : Choisir le service public (DGAFP), Licence Etalab 2.0.
