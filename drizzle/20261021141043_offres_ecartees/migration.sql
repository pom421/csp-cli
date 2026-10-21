CREATE TABLE `offres_ecartees` (
	`id_offre` text PRIMARY KEY,
	`motif` text NOT NULL,
	`date` text NOT NULL,
	CONSTRAINT "offres_ecartees_motif" CHECK("motif" IN ('experience', 'mots_cles'))
);
