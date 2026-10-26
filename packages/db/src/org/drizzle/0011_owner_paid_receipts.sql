-- A receipt holds several files (#95): its files are its `attachment_links` rows (target_type
-- 'receipt'), so `receipts.attachment_id` goes. Copy each receipt's file into the links first (the
-- receipt was already linked on upload; INSERT OR IGNORE keeps that row). Also adds
-- `paid_with_note`. Migrations run in a transaction with foreign keys on, where PRAGMA foreign_keys
-- can't change; no table references receipts, so the drop and rename need no FK juggling.
INSERT OR IGNORE INTO `attachment_links` (`attachment_id`, `target_type`, `target_id`) SELECT `attachment_id`, 'receipt', `id` FROM `receipts` WHERE `attachment_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'inbox' NOT NULL,
	`merchant` text,
	`receipt_date` text NOT NULL,
	`receipt_time` text,
	`amount` integer,
	`pre_tip_amount` integer,
	`tax_amount` integer,
	`tip_amount` integer,
	`bank_account_id` text,
	`account_id` text,
	`contact_id` text,
	`memo` text,
	`business_purpose` text,
	`attendees` text,
	`location` text,
	`paid_with_note` text,
	`extraction_source` text DEFAULT 'manual' NOT NULL,
	`matched_bank_txn_id` text,
	`match_method` text,
	`matched_at` text,
	`suggested_bank_txn_id` text,
	`rejected_txn_ids_json` text DEFAULT '[]' NOT NULL,
	`booked_target_type` text,
	`booked_target_id` text,
	`dismissed_reason` text,
	`created_by` text,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_bank_txn_id`) REFERENCES `bank_transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_bank_txn_id`) REFERENCES `bank_transactions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipts_status_ck" CHECK("__new_receipts"."status" in ('inbox','matched','booked','dismissed')),
	CONSTRAINT "receipts_extraction_source_ck" CHECK("__new_receipts"."extraction_source" in ('manual','assistant')),
	CONSTRAINT "receipts_match_method_ck" CHECK("__new_receipts"."match_method" is null or "__new_receipts"."match_method" in ('auto','manual','confirmed')),
	CONSTRAINT "receipts_amount_pos" CHECK("__new_receipts"."amount" is null or "__new_receipts"."amount" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_receipts`("id", "status", "merchant", "receipt_date", "receipt_time", "amount", "pre_tip_amount", "tax_amount", "tip_amount", "bank_account_id", "account_id", "contact_id", "memo", "business_purpose", "attendees", "location", "paid_with_note", "extraction_source", "matched_bank_txn_id", "match_method", "matched_at", "suggested_bank_txn_id", "rejected_txn_ids_json", "booked_target_type", "booked_target_id", "dismissed_reason", "created_by", "created_by_actor", "created_at", "updated_at") SELECT "id", "status", "merchant", "receipt_date", "receipt_time", "amount", "pre_tip_amount", "tax_amount", "tip_amount", "bank_account_id", "account_id", "contact_id", "memo", "business_purpose", "attendees", "location", NULL, "extraction_source", "matched_bank_txn_id", "match_method", "matched_at", "suggested_bank_txn_id", "rejected_txn_ids_json", "booked_target_type", "booked_target_id", "dismissed_reason", "created_by", "created_by_actor", "created_at", "updated_at" FROM `receipts`;--> statement-breakpoint
DROP TABLE `receipts`;--> statement-breakpoint
ALTER TABLE `__new_receipts` RENAME TO `receipts`;--> statement-breakpoint
CREATE INDEX `receipts_status_idx` ON `receipts` (`status`);--> statement-breakpoint
CREATE INDEX `receipts_amount_date_idx` ON `receipts` (`amount`,`receipt_date`);--> statement-breakpoint
CREATE INDEX `receipts_suggested_idx` ON `receipts` (`suggested_bank_txn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_matched_txn_uq` ON `receipts` (`matched_bank_txn_id`) WHERE "receipts"."matched_bank_txn_id" is not null;