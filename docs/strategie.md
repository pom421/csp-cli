# Stratégie de collecte

Décidée le 21/10/2026 avec le propriétaire. Document de référence : toute demande qui s'en écarte est signalée avant d'être
faite, toute estimation revue est signalée (elle peut changer la stratégie).

## Stratégie retenue : « stratégie 2 — tout le périmètre, mots-clés en local »

On ne donne **aucun mot-clé au site**. On lui demande **toutes** les offres d'un périmètre structuré, on ouvre chacune, et
**nous** cherchons les mots-clés dans leur texte complet.

Pourquoi pas la stratégie 1 (une recherche du site par mot-clé) : le moteur du site est approximatif (« cto » ramène des
crèches, « react » ramène « réactivité ») et ne sait pas faire de OU (une requête à plusieurs termes se comporte comme un ET :
16 termes → 10 offres au lieu de 90 en recherches séparées). Il faudrait une requête par terme et par jour, et une offre que
le site ne trouve pas pour un terme serait perdue.

Limite assumée : une offre hors du périmètre structuré (télétravail ou catégorie non renseignés, par exemple) n'est jamais
vue, même si elle contient les bons mots.

## Où se fait chaque traitement

- **[Site]** : filtre mis dans l'URL de recherche, appliqué par le site.
- **[Carte]** : lu dans la liste de résultats (titre, domaine, versant, département, date), sans ouvrir l'offre.
- **[Détail]** : page de l'offre ouverte, texte complet lu.
- **[LLM]** : analyse (résumé) par le fournisseur du `.env`.

| Étape | Où       | Traitement                                                                                                                                                                                                                                                                                                                                     |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | [Site]   | Départements 45, 75, 93, 94 ; catégories A et A+ ; télétravail oui ; management non ; date de publication (48 h chaque jour, 1 mois au premier import). Aucun mot-clé.                                                                                                                                                                         |
| 2     | [Carte]  | Domaine : 4 domaines « cadres généralistes » (Numérique, Direction et pilotage des politiques publiques, Organisation, contrôle et évaluation, Communication) — **à trancher** après l'itération de comparaison avec / sans.                                                                                                                   |
| 3     | [Détail] | Ouverture de chaque offre restante ; recherche des mots-clés en mots entiers (sans casse, accents ni ponctuation) dans le titre et le texte. Une offre sans aucun mot-clé est écartée et mémorisée (jamais rouverte) ; son texte est gardé pour rejouer le filtre si la liste de mots change. Le bilan indique quel mot a retenu chaque offre. |
| 4     | [LLM]    | Résumé des seules offres retenues. Note de pertinence : plus tard.                                                                                                                                                                                                                                                                             |
| 5     | code     | Trajets (Transitous) depuis le point de départ de la recherche : Gare d'Orléans (45), Gare d'Austerlitz (75, 93, 94).                                                                                                                                                                                                                          |

Les deux versants restent (État et territoriale).

### Mots-clés (étape 3)

- TypeScript / JavaScript : typescript, ts, javascript, js, node.js, nodejs, ecmascript
- Python : python
- Conteneurs : docker, conteneur, conteneurs, container, containers, kubernetes, k8s, openshift, helm
- Cloud : openstack, open stack, nubo
- Rôles : lead dev, lead developer, lead développeur, lead développeuse, dev lead, tech lead, techlead, technical lead,
  leader technique, référent technique, cto, directeur technique, directrice technique
- DevOps : devops, devsecops, sre, site reliability, ci/cd
- IA : ia, iag, ia générative, intelligence artificielle, genai, llm, grand modèle de langage, large language model,
  machine learning, apprentissage automatique

Exclus car ambigus en français : « ai » (j'ai), « vue » (en vue de), « node » seul. « ts » est gardé à l'essai.

## Rythme

- **Premier import** : offres publiées depuis 1 mois.
- **Chaque jour** : offres publiées depuis 48 h (filtre du site ; 7 ou 14 jours si des jours ont été manqués, au-delà : liste
  complète triée par date, arrêt au-delà de la dernière collecte).
- **Offres retenues** : revérifiées une fois par semaine par roulement (retrait, modification → nouveau résumé) ; expirées à
  leur date limite de candidature ou 90 jours après publication.

## Estimations

Mesurées le 21/10/2026 sur le vrai site (périmètre de l'étape 1 : 370 offres en 14 jours). Une page de liste fait ~190 Ko
transférés (4,5 Mo décompressés, presque tout le formulaire de filtres) ; une page détail ~215 Ko décompressés (taille
transférée non mesurée : les volumes ci-dessous sont des maximums). Durées à une requête toutes les 2-3 s.

|                                                         | Premier import (1 mois)  | Chaque jour          |
| ------------------------------------------------------- | ------------------------ | -------------------- |
| Offres du périmètre (étape 1)                           | ~800                     | ~26                  |
| Avec le filtre de domaine (étape 2)                     | ~410                     | ~14                  |
| Pages de liste                                          | ~40 (~8 Mo)              | 1 à 2 (< 0,4 Mo)     |
| Pages détail (sans filtre de domaine)                   | ~800, ~35 min (≤ 170 Mo) | ~26, ~1 min (≤ 6 Mo) |
| Offres retenues → LLM                                   | ~50 à 70                 | 2 à 3                |
| Durée LLM (Albert, ~10 s par offre, **non mesuré**)     | ~10 min                  | < 1 min              |
| Revérification hebdomadaire (1/7 des retenues par jour) | —                        | ~10 pages détail     |

Les « offres retenues » viennent d'une mesure de la stratégie 1 (16 mots-clés, 1 mois, sans télétravail ni management :
90 offres remontées par le site, ~55 pertinentes au titre) : à confirmer par la première itération.

### Évolution du volume selon le périmètre (pour mémoire)

| Périmètre                                              | Offres nouvelles par jour |
| ------------------------------------------------------ | ------------------------- |
| Loiret + toute l'Île-de-France, toutes catégories      | ~230 (estimation)         |
| + catégorie A                                          | ~80                       |
| départements réduits à 45, 75, 93, 94                  | ~75 (1 043 en 14 jours)   |
| + télétravail oui + management non, catégories A et A+ | **~26** (370 en 14 jours) |
| + les 4 domaines                                       | ~14 (192 en 14 jours)     |

## Première itération (à faire)

1. Premier import sans filtre de domaine (étape 2 désactivée).
2. Bilan : offres retenues par mot-clé, et liste des offres retenues **hors des 4 domaines** → décider du filtre de domaine.
3. Mesurer la durée réelle d'Albert sur quelques offres ; revoir les estimations ci-dessus et les signaler si elles changent.

## Points ouverts

- **Nature de l'emploi** (fonctionnaires ou titulaires et contractuels) et **expérience** (confirmé, expert ou non renseigné) :
  demandés plus tôt, pas repris depuis → à confirmer (s'ils restent : [Site] pour la nature, liste d'exclusion « débutant »).
- Technologies voisines (React, Angular, Django…) : non incluses dans les mots-clés.
