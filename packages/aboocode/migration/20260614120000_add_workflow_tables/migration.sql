CREATE TABLE `workflow_run` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`script_path` text NOT NULL,
	`status` text NOT NULL,
	`args_json` text,
	`model` text,
	`tokens_total` integer NOT NULL DEFAULT 0,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_agent_call` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`call_key` text NOT NULL,
	`label` text,
	`phase` text,
	`prompt` text NOT NULL,
	`opts_json` text,
	`result_json` text,
	`status` text NOT NULL,
	`tokens` integer NOT NULL DEFAULT 0,
	`time_started` integer NOT NULL,
	`time_ended` integer,
	CONSTRAINT `fk_workflow_call_run` FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workflow_run_session_idx` ON `workflow_run` (`session_id`);--> statement-breakpoint
CREATE INDEX `workflow_call_run_seq_idx` ON `workflow_agent_call` (`run_id`,`seq`);
