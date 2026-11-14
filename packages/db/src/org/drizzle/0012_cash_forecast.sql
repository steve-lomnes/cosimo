CREATE TABLE `forecast_items` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`kind` text DEFAULT 'planned' NOT NULL,
	`name` text NOT NULL,
	`direction` text NOT NULL,
	`amount` integer NOT NULL,
	`unit` text,
	`interval` integer DEFAULT 1 NOT NULL,
	`anchor_day` integer,
	`start_date` text NOT NULL,
	`end_date` text,
	`max_occurrences` integer,
	`account_id` text,
	`contact_id` text,
	`bank_account_id` text,
	`notes` text,
	`source` text DEFAULT 'person' NOT NULL,
	`created_by` text,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`last_confirmed_at` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `forecast_scenarios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_items_kind_ck" CHECK("forecast_items"."kind" in ('planned','draw')),
	CONSTRAINT "forecast_items_direction_ck" CHECK("forecast_items"."direction" in ('in','out')),
	CONSTRAINT "forecast_items_amount_pos" CHECK("forecast_items"."amount" > 0),
	CONSTRAINT "forecast_items_draw_out" CHECK("forecast_items"."kind" <> 'draw' or "forecast_items"."direction" = 'out')
);
--> statement-breakpoint
CREATE INDEX `forecast_items_scenario_idx` ON `forecast_items` (`scenario_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `forecast_links` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`occurrence_date` text NOT NULL,
	`status` text NOT NULL,
	`target_type` text,
	`target_id` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `forecast_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_links_status_ck" CHECK("forecast_links"."status" in ('linked','rejected','skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_links_uq` ON `forecast_links` (`item_id`,`occurrence_date`,`status`,`target_id`);--> statement-breakpoint
CREATE INDEX `forecast_links_target_idx` ON `forecast_links` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `forecast_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`target_date` text DEFAULT '' NOT NULL,
	`action` text NOT NULL,
	`shift_days` integer,
	`created_by` text,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `forecast_scenarios`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_overrides_action_ck" CHECK("forecast_overrides"."action" in ('exclude','shift'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_overrides_uq` ON `forecast_overrides` (`scenario_id`,`target_type`,`target_id`,`target_date`);--> statement-breakpoint
CREATE TABLE `forecast_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_baseline` integer DEFAULT false NOT NULL,
	`description` text,
	`assumptions_json` text DEFAULT '{}' NOT NULL,
	`created_by` text,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_by_client` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_scenarios_baseline_uq` ON `forecast_scenarios` (`is_baseline`) WHERE "forecast_scenarios"."is_baseline" = 1;--> statement-breakpoint
CREATE TABLE `forecast_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`bucket` text NOT NULL,
	`periods` integer NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "forecast_windows_bucket_ck" CHECK("forecast_windows"."bucket" in ('week','month')),
	CONSTRAINT "forecast_windows_periods_ck" CHECK("forecast_windows"."periods" between 1 and 104)
);
