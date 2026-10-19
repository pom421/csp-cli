CREATE TABLE `a_resumer` (
	`id_offre` text PRIMARY KEY,
	`raison` text NOT NULL,
	`chemin_brut` text NOT NULL,
	`date` text NOT NULL,
	CONSTRAINT `fk_a_resumer_id_offre_offres_id_offre_fk` FOREIGN KEY (`id_offre`) REFERENCES `offres`(`id_offre`) ON DELETE CASCADE,
	CONSTRAINT "a_resumer_raison" CHECK("raison" IN ('nouvelle', 'modifiee'))
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`id` integer PRIMARY KEY,
	`debut` text NOT NULL,
	`fin` text,
	`statut` text DEFAULT 'en_cours' NOT NULL,
	`code_sortie` integer,
	`nb_cartes` integer,
	`nb_nouvelles` integer,
	`nb_modifiees` integer,
	`nb_expirees` integer,
	`message` text,
	CONSTRAINT "executions_statut" CHECK("statut" IN ('en_cours', 'complete', 'incomplete', 'echec'))
);
--> statement-breakpoint
CREATE TABLE `geocodage_cache` (
	`cle_lieu` text PRIMARY KEY,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`precision_geo` text NOT NULL,
	`source` text NOT NULL,
	`date` text NOT NULL,
	CONSTRAINT "geocodage_latitude" CHECK("latitude" BETWEEN -90 AND 90),
	CONSTRAINT "geocodage_longitude" CHECK("longitude" BETWEEN -180 AND 180),
	CONSTRAINT "geocodage_precision" CHECK("precision_geo" IN ('adresse', 'commune'))
);
--> statement-breakpoint
CREATE TABLE `offres` (
	`id_offre` text PRIMARY KEY,
	`url` text NOT NULL,
	`titre` text NOT NULL,
	`employeur` text,
	`versant` text,
	`categorie` text,
	`type_contrat` text,
	`duree_contrat_mois` integer,
	`temps_travail` text,
	`metier` text,
	`domaine` text,
	`adresse` text,
	`commune` text,
	`code_postal` text,
	`departement` text,
	`latitude` real,
	`longitude` real,
	`precision_geo` text,
	`teletravail_jours_semaine` real,
	`remuneration_min` integer,
	`remuneration_max` integer,
	`remuneration_texte` text,
	`management` integer,
	`taille_equipe` integer,
	`experience_annees_min` integer,
	`niveau_diplome` text,
	`competences` text,
	`date_publication` text,
	`date_limite_candidature` text,
	`date_prise_poste` text,
	`resume` text,
	`points_attention` text,
	`empreinte_carte` text,
	`empreinte_detail` text,
	`empreinte_identite` text,
	`statut` text DEFAULT 'active' NOT NULL,
	`absences_consecutives` integer DEFAULT 0 NOT NULL,
	`republication_de` text,
	`date_premiere_vue` text NOT NULL,
	`date_derniere_vue` text NOT NULL,
	`date_maj_detail` text,
	`date_resume` text,
	CONSTRAINT `fk_offres_republication_de_offres_id_offre_fk` FOREIGN KEY (`republication_de`) REFERENCES `offres`(`id_offre`) ON DELETE SET NULL,
	CONSTRAINT "offres_versant" CHECK("versant" IN ('FPE', 'FPT', 'FPH')),
	CONSTRAINT "offres_categorie" CHECK("categorie" IN ('A+', 'A', 'B', 'C')),
	CONSTRAINT "offres_type_contrat" CHECK("type_contrat" IN ('titulaire', 'contractuel', 'titulaire_ou_contractuel')),
	CONSTRAINT "offres_temps_travail" CHECK("temps_travail" IN ('complet', 'partiel')),
	CONSTRAINT "offres_precision_geo" CHECK("precision_geo" IN ('adresse', 'commune')),
	CONSTRAINT "offres_statut" CHECK("statut" IN ('active', 'cloturee', 'expiree')),
	CONSTRAINT "offres_duree_contrat" CHECK("duree_contrat_mois" > 0),
	CONSTRAINT "offres_latitude" CHECK("latitude" BETWEEN -90 AND 90),
	CONSTRAINT "offres_longitude" CHECK("longitude" BETWEEN -180 AND 180),
	CONSTRAINT "offres_teletravail" CHECK("teletravail_jours_semaine" BETWEEN 0 AND 5),
	CONSTRAINT "offres_remuneration" CHECK("remuneration_min" >= 0 AND "remuneration_max" >= 0),
	CONSTRAINT "offres_management" CHECK("management" IN (0, 1)),
	CONSTRAINT "offres_effectifs" CHECK("taille_equipe" >= 0 AND "experience_annees_min" >= 0),
	CONSTRAINT "offres_json" CHECK(json_valid("competences") AND json_valid("points_attention")),
	CONSTRAINT "offres_absences" CHECK("absences_consecutives" >= 0)
);
--> statement-breakpoint
CREATE TABLE `recherches_offres` (
	`nom_recherche` text NOT NULL,
	`id_offre` text NOT NULL,
	CONSTRAINT `recherches_offres_pk` PRIMARY KEY(`nom_recherche`, `id_offre`),
	CONSTRAINT `fk_recherches_offres_id_offre_offres_id_offre_fk` FOREIGN KEY (`id_offre`) REFERENCES `offres`(`id_offre`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `trajets_cache` (
	`cle_origine` text NOT NULL,
	`cle_destination` text NOT NULL,
	`heure_ref` text NOT NULL,
	`duree_min` integer,
	`nb_correspondances` integer,
	`date` text NOT NULL,
	CONSTRAINT `trajets_cache_pk` PRIMARY KEY(`cle_origine`, `cle_destination`, `heure_ref`),
	CONSTRAINT "trajets_positifs" CHECK("duree_min" >= 0 AND "nb_correspondances" >= 0)
);
--> statement-breakpoint
CREATE INDEX `offres_empreinte_identite` ON `offres` (`empreinte_identite`);--> statement-breakpoint
CREATE INDEX `offres_statut` ON `offres` (`statut`);