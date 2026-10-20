/**
 * Codes de sortie (PLAN §6) : chaque famille d'échec a le sien, pour que la tâche planifiée
 * sache quoi faire (réparer, retenter demain, s'arrêter).
 */
export const CODES = {
  ok: 0,
  autre: 1,
  casse: 2,
  indisponible: 3,
  blocage: 4,
} as const;

/** Erreur de saisie ou de configuration : message lisible, code 1. */
export class UserError extends Error {
  readonly code: number = CODES.autre;
}

/** Le site a changé (élément introuvable, extraction invalide) : code 2, Claude répare. */
export class CasseError extends Error {
  readonly code: number = CODES.casse;
  readonly etape: string;
  /** Dossier du diagnostic sauvegardé (collecte), affiché avec le message. */
  diagnostic?: string;
  constructor(etape: string, message: string) {
    super(`[${etape}] ${message}`);
    this.etape = etape;
  }
}

/** Site ou réseau indisponible (timeout, 5xx) : code 3, on retente demain. */
export class IndisponibleError extends Error {
  readonly code: number = CODES.indisponible;
}

/** Captcha, 403, 429 : code 4, arrêt immédiat, aucun contournement. */
export class BlocageError extends Error {
  readonly code: number = CODES.blocage;
}

export function codeDeSortie(err: unknown): number {
  if (err instanceof UserError || err instanceof CasseError) return err.code;
  if (err instanceof IndisponibleError || err instanceof BlocageError) return err.code;
  return CODES.autre;
}
