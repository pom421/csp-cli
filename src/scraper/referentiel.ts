// Identifiants internes du site pour les filtres (relevés le 19/10/2026, docs/reconnaissance.md).
// Ils viennent de la base WordPress du site et peuvent changer : un seul endroit à corriger.

/**
 * Segments d'URL utilisés, dans l'ordre où le JS du site les écrit (`window.ParamsDataSearch.url_keywords`). Mot-clé,
 * domaine et expérience existent mais ne sont pas envoyés (stratégie 2 : filtrés localement, docs/strategie.md).
 */
export const SEGMENTS = [
  'localisation',
  'categorie',
  'type',
  'management',
  'teletravail',
  'date-de-publication',
] as const;

export type Segment = (typeof SEGMENTS)[number];

export const CATEGORIES = { 'A+': '4327-4328', A: '1805', B: '1806', C: '1807' } as const;

/** Nature de l'emploi (segment `type`). « titulaire » couvre aussi les postes réservés aux fonctionnaires. */
export const NATURES = {
  titulaire_ou_contractuel: '2349',
  fonctionnaires_seulement: '4534',
  contractuels_seulement: '2267',
} as const;

/** Télétravail et management : « oui » et « non » (relevé du 21/10/2026, la valeur non renseignée n'a pas de filtre). */
export const OUI_NON = { oui: '1814', non: '1815' } as const;

/** Fenêtres du filtre « date de publication » proposées par le site, de la plus courte à la plus longue. */
export const FENETRES_PUBLICATION = [
  { jours: 2, valeur: 'dernieres_48_heures' },
  { jours: 7, valeur: '7_derniers_jours' },
  { jours: 14, valeur: '14_derniers_jours' },
] as const;

/** Code INSEE du département → identifiant du site (segment `localisation`). */
export const DEPARTEMENTS: Record<string, string> = {
  '01': '330',
  '02': '317',
  '03': '243',
  '04': '324',
  '05': '327',
  '06': '325',
  '07': '331',
  '08': '264',
  '09': '302',
  '10': '265',
  '11': '290',
  '12': '303',
  '13': '326',
  '14': '247',
  '15': '244',
  '16': '320',
  '17': '321',
  '18': '258',
  '19': '295',
  '21': '250',
  '22': '254',
  '23': '296',
  '24': '238',
  '25': '277',
  '26': '332',
  '27': '280',
  '28': '259',
  '29': '255',
  '2A': '268',
  '2B': '269',
  '30': '291',
  '31': '305',
  '32': '304',
  '33': '239',
  '34': '292',
  '35': '256',
  '36': '260',
  '37': '261',
  '38': '334',
  '39': '279',
  '40': '240',
  '41': '262',
  '42': '335',
  '43': '245',
  '44': '312',
  '45': '263',
  '46': '307',
  '47': '241',
  '48': '293',
  '49': '313',
  '50': '248',
  '51': '267',
  '52': '266',
  '53': '314',
  '54': '298',
  '55': '299',
  '56': '257',
  '57': '300',
  '58': '251',
  '59': '310',
  '60': '318',
  '61': '249',
  '62': '311',
  '63': '246',
  '64': '242',
  '65': '306',
  '66': '294',
  '67': '236',
  '68': '237',
  '69': '336',
  '70': '278',
  '71': '252',
  '72': '315',
  '73': '337',
  '74': '333',
  '75': '284',
  '76': '281',
  '77': '285',
  '78': '289',
  '79': '322',
  '80': '319',
  '81': '308',
  '82': '309',
  '83': '328',
  '84': '329',
  '85': '316',
  '86': '323',
  '87': '297',
  '88': '301',
  '89': '253',
  '90': '276',
  '91': '282',
  '92': '283',
  '93': '286',
  '94': '287',
  '95': '288',
  '971': '270',
  '972': '272',
  '973': '271',
  '974': '274',
  '976': '273',
};

/** Région (nom officiel) → identifiant du site (segment `localisation`). Outre-mer : par département (971…976). */
export const REGIONS: Record<string, string> = {
  'Île-de-France': '208',
  'Centre-Val de Loire': '202',
  'Bourgogne-Franche-Comté': '200',
  Normandie: '199',
  'Hauts-de-France': '213',
  'Grand Est': '196',
  'Pays de la Loire': '214',
  Bretagne: '201',
  'Nouvelle-Aquitaine': '197',
  Occitanie: '209',
  'Auvergne-Rhône-Alpes': '198',
  "Provence-Alpes-Côte d'Azur": '217',
  Corse: '204',
};

/** Libellé « Fonction publique : » des cartes → versant. Le filtre `versant` du site n'est pas fiable : filtrage local. */
export const VERSANTS_CARTE: Record<string, 'FPE' | 'FPT' | 'FPH'> = {
  "fonction publique de l'état": 'FPE',
  'fonction publique territoriale': 'FPT',
  'fonction publique hospitalière': 'FPH',
};
