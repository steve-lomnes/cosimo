CREATE TABLE `reconciliation_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`reconciliation_id` text NOT NULL,
	`kind` text NOT NULL,
	`date` text,
	`amount` integer,
	`journal_line_id` text,
	`description` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text,
	`created_actor` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`resolved_by` text,
	`resolved_actor` text,
	`resolved_at` text,
	`resolution_note` text,
	FOREIGN KEY (`reconciliation_id`) REFERENCES `reconciliations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_line_id`) REFERENCES `journal_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reconciliation_flags_recon_idx` ON `reconciliation_flags` (`reconciliation_id`);