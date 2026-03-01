CREATE TABLE `memory` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`session_id` text,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`tags` text NOT NULL DEFAULT '[]',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_memory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `entity` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`observations` text NOT NULL DEFAULT '[]',
	`tags` text NOT NULL DEFAULT '[]',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_entity_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `relation` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`from_entity` text NOT NULL,
	`to_entity` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_relation_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `memory_project_idx` ON `memory` (`project_id`);--> statement-breakpoint
CREATE INDEX `entity_project_idx` ON `entity` (`project_id`);--> statement-breakpoint
CREATE INDEX `relation_project_idx` ON `relation` (`project_id`);
