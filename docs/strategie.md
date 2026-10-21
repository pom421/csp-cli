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

| Étape | Où       | Traitement                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | [Site]   | Départements 45, 75, 93, 94 ; catégories A et A+ ; nature : fonctionnaires, ou titulaires et contractuels (contractuels seuls exclus) ; télétravail oui ; management non ; date de publication (48 h chaque jour, 1 mois au premier import). Aucun mot-clé, aucun domaine.                                                                                                                             |
| 2     | [Détail] | Ouverture de chaque offre. Expérience : débutant exclu (confirmé, expert ou non renseignée gardés). Recherche des mots-clés en mots entiers (sans casse, accents ni ponctuation) dans le titre et le texte. Une offre écartée est mémorisée avec son motif (jamais rouverte) ; son texte est gardé pour rejouer le filtre si la liste de mots change. Le bilan indique quel mot a retenu chaque offre. |
| 3     | [LLM]    | Résumé des seules offres retenues. Note de pertinence : plus tard.                                                                                                                                                                                                                                                                                                                                     |
| 4     | code     | Trajets (Transitous) depuis le point de départ de la recherche : Gare d'Orléans (45), Gare d'Austerlitz (75, 93, 94).                                                                                                                                                                                                                                                                                  |

**Filtre par domaine, gardé sous la main** (pas appliqué) : [Carte], sans requête supplémentaire, 4 domaines « cadres
généralistes » (Numérique, Direction et pilotage des politiques publiques, Organisation, contrôle et évaluation,
Communication). Le bilan signale les offres retenues hors de ces domaines, pour juger de ce qu'il ferait perdre.

Les deux versants restent (État et territoriale).

### Mots-clés (étape 2)

- TypeScript / JavaScript : typescript, ts, javascript, js, node.js, nodejs, ecmascript
- Python : python, django
- Conteneurs : docker, conteneur, conteneurs, container, containers, kubernetes, k8s, openshift, helm
- Cloud : openstack, open stack, nubo
- Rôles : lead dev, lead developer, lead développeur, lead développeuse, dev lead, tech lead, techlead, technical lead,
  leader technique, référent technique, cto, directeur technique, directrice technique
- DevOps : devops, devsecops, sre, site reliability, ci/cd
- IA : ia, iag, ia générative, intelligence artificielle, genai, llm, grand modèle de langage, large language model,
  machine learning, apprentissage automatique
- Craftsmanship : craftsmanship, software craftsmanship, tdd, test driven development, développement piloté par les tests,
  bdd, behavior driven development, behaviour driven development, ddd, domain driven design, architecture hexagonale,
  hexagonal architecture, clean architecture, clean code, pair programming, programmation en binôme, mob programming,
  refactoring, extreme programming

Exclus car ambigus en français : « ai » (j'ai), « vue » (en vue de), « node » seul, « xp ». Gardés à l'essai, à surveiller dans le bilan : « ts », et « bdd » (souvent « base de
données » en français).

## Rythme

- **Premier import** : offres publiées depuis 1 mois.
- **Chaque jour** : offres publiées depuis 48 h (filtre du site ; 7 ou 14 jours si des jours ont été manqués, au-delà : liste
  complète triée par date, arrêt au-delà de la dernière collecte).
- **Offres retenues** : revérifiées une fois par semaine par roulement (retrait, modification → nouveau résumé) ; expirées à
  leur date limite de candidature ou 90 jours après publication.
- **Erreur 503** (site momentanément indisponible) : nouvelles tentatives après 10 s, 25 s puis 60 s ; si le 503 persiste,
  arrêt en code 3. Les offres déjà lues sont conservées, la suite est reprise au passage suivant.

## Estimations

Mesurées le 21/10/2026 par un test réel de la stratégie 2 sur 7 jours (publications du 14 au 21/10) : 236 offres au
périmètre de l'étape 1, toutes ouvertes en 16 min (~4 s par page, délai de politesse compris) ; 26 « débutant » ; **28
retenues** par les mots-clés (12 %). Une page de liste fait ~190 Ko transférés (4,5 Mo décompressés, presque tout le
formulaire de filtres) ; une page détail ~215 Ko décompressés (taille transférée non mesurée : volumes ci-dessous maximaux).

|                                                         | Premier import (1 mois)    | Chaque jour             |
| ------------------------------------------------------- | -------------------------- | ----------------------- |
| Offres du périmètre (étape 1)                           | ~1 000                     | ~34                     |
| Pages de liste                                          | ~50 (~10 Mo)               | 1 à 2 (< 0,4 Mo)        |
| Pages détail                                            | ~1 000, ~70 min (≤ 215 Mo) | ~34, ~2 min 30 (≤ 7 Mo) |
| Offres retenues → LLM                                   | ~120                       | ~4                      |
| Durée LLM (Albert, ~10 s par offre, **non mesuré**)     | ~20 min                    | < 1 min                 |
| Revérification hebdomadaire (1/7 des retenues par jour) | —                          | ~15 pages détail        |

Filtre par domaine (sous la main) : sur les 28 retenues du test, **1 seule** était hors des 4 domaines (et peu pertinente).
Il diviserait environ par deux les pages détail ouvertes.

Révisions : le 21/10, première estimation à ~26 offres par jour et ~50-70 retenues par mois (mesures partielles) ; revue
à la hausse par le test.

### Évolution du volume selon le périmètre (pour mémoire)

| Périmètre                                              | Offres nouvelles par jour |
| ------------------------------------------------------ | ------------------------- |
| Loiret + toute l'Île-de-France, toutes catégories      | ~230 (estimation)         |
| + catégorie A                                          | ~80                       |
| départements réduits à 45, 75, 93, 94                  | ~75 (1 043 en 14 jours)   |
| + télétravail oui + management non, catégories A et A+ | **~26** (370 en 14 jours) |
| + les 4 domaines                                       | ~14 (192 en 14 jours)     |

## Première itération

1. ~~Test sur les 7 derniers jours, sans filtre de domaine~~ : fait le 21/10/2026 (voir Estimations).
2. ~~Bilan par mot-clé et hors domaines~~ : fait.
3. Mesurer la durée réelle d'Albert sur quelques offres ; revoir les estimations ci-dessus et les signaler si elles changent.
