-- One OAuth connection covers several orgs (#87). Each code and token moves its org_id and role
-- into a child row, and the old org becomes the default. Migrations run in a transaction with
-- foreign keys on, where PRAGMA foreign_keys can't change, so the child tables first reference the
-- rebuilt `__new_*` tables, and the rename then points them at the final names.
CREATE TABLE `__new_oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`default_org_id` text,
	`scope` text NOT NULL,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`resource` text,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_oauth_codes`("code_hash", "client_id", "user_id", "default_org_id", "scope", "code_challenge", "redirect_uri", "resource", "expires_at", "used_at") SELECT "code_hash", "client_id", "user_id", "org_id", "scope", "code_challenge", "redirect_uri", "resource", "expires_at", "used_at" FROM `oauth_codes`;--> statement-breakpoint
CREATE TABLE `oauth_code_orgs` (
	`code_hash` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`code_hash`, `org_id`),
	FOREIGN KEY (`code_hash`) REFERENCES `__new_oauth_codes`(`code_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `oauth_code_orgs`("code_hash", "org_id", "role") SELECT "code_hash", "org_id", "role" FROM `oauth_codes`;--> statement-breakpoint
DROP TABLE `oauth_codes`;--> statement-breakpoint
ALTER TABLE `__new_oauth_codes` RENAME TO `oauth_codes`;--> statement-breakpoint
CREATE TABLE `__new_oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`default_org_id` text,
	`scope` text NOT NULL,
	`access_token_hash` text NOT NULL,
	`refresh_token_hash` text,
	`access_expires_at` text NOT NULL,
	`refresh_expires_at` text,
	`last_used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_oauth_tokens`("id", "client_id", "user_id", "default_org_id", "scope", "access_token_hash", "refresh_token_hash", "access_expires_at", "refresh_expires_at", "last_used_at", "created_at", "revoked_at") SELECT "id", "client_id", "user_id", "org_id", "scope", "access_token_hash", "refresh_token_hash", "access_expires_at", "refresh_expires_at", "last_used_at", "created_at", "revoked_at" FROM `oauth_tokens`;--> statement-breakpoint
CREATE TABLE `oauth_token_orgs` (
	`token_id` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`revoked_at` text,
	PRIMARY KEY(`token_id`, `org_id`),
	FOREIGN KEY (`token_id`) REFERENCES `__new_oauth_tokens`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `oauth_token_orgs`("token_id", "org_id", "role", "created_at", "revoked_at") SELECT "id", "org_id", "role", "created_at", "revoked_at" FROM `oauth_tokens`;--> statement-breakpoint
DROP TABLE `oauth_tokens`;--> statement-breakpoint
ALTER TABLE `__new_oauth_tokens` RENAME TO `oauth_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_access_token_hash_unique` ON `oauth_tokens` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_refresh_token_hash_unique` ON `oauth_tokens` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_user_idx` ON `oauth_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_token_orgs_org_idx` ON `oauth_token_orgs` (`org_id`);
