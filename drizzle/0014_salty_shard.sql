CREATE TABLE `video_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`account_id` integer NOT NULL,
	`account_label` text,
	`api_key_id` integer,
	`task_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`params` text NOT NULL,
	`file_path` text,
	`file_size` integer,
	`video_url` text,
	`credit_used` real,
	`dollar_cost` real,
	`error_message` text,
	`request_log_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_video_jobs_status_created` ON `video_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_video_jobs_task` ON `video_jobs` (`task_id`);