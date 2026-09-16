DROP INDEX `idx_api_keys_secret`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_api_keys_secret` ON `api_keys` (`secret`);