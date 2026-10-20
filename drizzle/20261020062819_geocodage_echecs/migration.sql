PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_geocodage_cache` (
	`cle_lieu` text PRIMARY KEY,
	`latitude` real,
	`longitude` real,
	`precision_geo` text,
	`source` text NOT NULL,
	`date` text NOT NULL,
	CONSTRAINT "geocodage_latitude" CHECK("latitude" BETWEEN -90 AND 90),
	CONSTRAINT "geocodage_longitude" CHECK("longitude" BETWEEN -180 AND 180),
	CONSTRAINT "geocodage_precision" CHECK("precision_geo" IN ('adresse', 'commune')),
	CONSTRAINT "geocodage_complet" CHECK(("latitude" IS NULL) = ("longitude" IS NULL) AND ("latitude" IS NULL) = ("precision_geo" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_geocodage_cache`(`cle_lieu`, `latitude`, `longitude`, `precision_geo`, `source`, `date`) SELECT `cle_lieu`, `latitude`, `longitude`, `precision_geo`, `source`, `date` FROM `geocodage_cache`;--> statement-breakpoint
DROP TABLE `geocodage_cache`;--> statement-breakpoint
ALTER TABLE `__new_geocodage_cache` RENAME TO `geocodage_cache`;--> statement-breakpoint
PRAGMA foreign_keys=ON;