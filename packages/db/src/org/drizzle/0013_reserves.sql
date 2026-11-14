CREATE TABLE `reserve_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`reserve_id` text NOT NULL,
	`label` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`due_dates_json` text DEFAULT '[]' NOT NULL,
	`liability_account_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`reserve_id`) REFERENCES `reserves`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`liability_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reserve_parts_rate_ck" CHECK("reserve_parts"."rate_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE INDEX `reserve_parts_reserve_idx` ON `reserve_parts` (`reserve_id`);--> statement-breakpoint
CREATE TABLE `reserve_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`part_id` text NOT NULL,
	`tax_year` integer NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`entry_id` text,
	`note` text,
	`created_by` text,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `reserve_parts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reserve_payments_amount_pos" CHECK("reserve_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE INDEX `reserve_payments_part_idx` ON `reserve_payments` (`part_id`,`tax_year`);--> statement-breakpoint
CREATE INDEX `reserve_payments_entry_idx` ON `reserve_payments` (`entry_id`);--> statement-breakpoint
CREATE TABLE `reserves` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'track' NOT NULL,
	`base` text DEFAULT 'net_income' NOT NULL,
	`tax_year_start_month` integer DEFAULT 1 NOT NULL,
	`charge_account_id` text,
	`true_up_schedule` text DEFAULT 'manual' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`charge_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reserves_mode_ck" CHECK("reserves"."mode" in ('track','book')),
	CONSTRAINT "reserves_base_ck" CHECK("reserves"."base" in ('net_income')),
	CONSTRAINT "reserves_month_ck" CHECK("reserves"."tax_year_start_month" between 1 and 12),
	CONSTRAINT "reserves_schedule_ck" CHECK("reserves"."true_up_schedule" in ('manual','monthly'))
);
