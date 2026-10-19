-- Migration réécrite à la main : drizzle-kit recréait la table `offres` (DROP TABLE), ce qui, clés étrangères actives
-- dans la transaction du migrateur, aurait vidé `recherches_offres` et `a_resumer` (ON DELETE CASCADE).
-- SQLite accepte une contrainte CHECK dans ADD COLUMN : même résultat que le schéma, sans recréer la table.
ALTER TABLE `offres` ADD `teletravail_possible` integer CONSTRAINT "offres_teletravail_possible" CHECK("teletravail_possible" IN (0, 1));
