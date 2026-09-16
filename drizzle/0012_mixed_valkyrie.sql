CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`token_limit` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`max_concurrent` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`allowed_models` text,
	`allowed_providers` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_secret` ON `api_keys` (`secret`);