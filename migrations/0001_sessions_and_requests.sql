ALTER TABLE `device_codes` ADD `requested_at` integer;--> statement-breakpoint
ALTER TABLE `device_codes` ADD `requested_from` text;--> statement-breakpoint
ALTER TABLE `users` ADD `session_version` integer DEFAULT 0 NOT NULL;