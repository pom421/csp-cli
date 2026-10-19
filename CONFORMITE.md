# Conformité — collecte sur Choisir le service public

Analyse factuelle du 19/10/2026, **pas un avis juridique**. À relire si le site publie des CGU ou modifie ses mentions légales.

## Sources examinées

- [Mentions légales](https://choisirleservicepublic.gouv.fr/mentions-legales/) (aucune page CGU trouvée)
- [robots.txt](https://choisirleservicepublic.gouv.fr/robots.txt)
- [Jeu de données open data](https://www.data.gouv.fr/datasets/les-offres-diffusees-sur-choisir-le-service-public) (data.gouv.fr)

## Ce que disent les textes

- **Responsable du site** : DGAFP
- **Licence** (pied de page) : textes du site sous **Licence Ouverte Etalab 2.0**, sauf mention contraire → réutilisation libre avec mention de la source
- **Scraping / extraction automatisée / robots** : aucune clause
- **Droit des bases de données** : non mentionné
- **Clause de finalité** (Engagements de l'Utilisateur) : site destiné à permettre de consulter les offres et déposer une candidature
- **RGPD** : concerne les données des candidats, pas les offres

## robots.txt

- Interdit : `/wp-admin/`, `/wp-content/uploads/pdf-offers/` (PDF des offres)
- Autorisé : le reste, dont les pages d'offres
- Sitemap déclaré : `/sitemapindex.xml`

## Interprétation

- **Usage personnel (veille pour candidater)** : conforme à la finalité du site → risque très faible
- **Republication publique (futur site web)** : zone grise
  - Pour : Etalab 2.0, données déjà publiées en open data
  - Contre : la clause de finalité vise l'accès au site ; un service tiers collectant pour d'autres s'en éloigne
  - Option sûre : alimenter la version publique avec le **CSV open data** (licence explicite, MAJ hebdomadaire), ou demander l'accord de la DGAFP (formulaire d'aide du site)

## Règles appliquées par le projet

1. **Scraping réservé à l'usage personnel** du propriétaire du dépôt
2. **Respect du robots.txt** : jamais de téléchargement sous `/wp-content/uploads/pdf-offers/` (bloqué dans le code)
3. **Politesse** : 1 collecte/jour, 1 requête toutes les 2-3 s, user-agent identifiant le projet
4. **Aucun contournement** : captcha, 403, 429 → arrêt immédiat
5. **Pas de données personnelles des recruteurs** en base (nom, email, téléphone) ; le résumé éditorial les exclut
6. **Texte brut non conservé** : supprimé après résumé
7. **Attribution** sur chaque fiche affichée : lien vers l'offre d'origine + « Source : Choisir le service public (DGAFP), Licence Etalab 2.0 »
8. **Adresse de départ** (donnée perso) : uniquement dans `.env` local, hors dépôt

## À revérifier si

- Publication de CGU ou modification des mentions légales
- Modification du robots.txt (contrôle possible dans `csp doctor`)
- Passage à un usage public ou partagé
