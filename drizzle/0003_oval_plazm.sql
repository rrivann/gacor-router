CREATE TABLE `chat_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text DEFAULT 'New chat' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`messages` text DEFAULT '[]' NOT NULL,
	`msg_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
