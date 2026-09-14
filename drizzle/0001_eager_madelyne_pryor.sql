CREATE TABLE `request_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`account_id` integer,
	`account_label` text,
	`stream` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`outcome` text,
	`duration_ms` integer,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`error_message` text,
	`request_body` text,
	`response_body` text
);
--> statement-breakpoint
CREATE INDEX `idx_request_logs_created` ON `request_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_provider_created` ON `request_logs` (`provider`,`created_at`);