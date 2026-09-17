-- The optimizer's four tables, plus the project-wide deletion fence.
--
-- Additive, which is what blue/green needs: blue and green share one SQLite
-- file across a swap, and the outgoing release knows nothing about any of this,
-- so it keeps running against the migrated file untouched. One nullable column
-- on `project` and four new tables; nothing existing is altered or dropped.
--
-- Every stored enum carries its `CHECK` here rather than only in `schema.ts`,
-- because a constraint the database does not hold is a convention the next
-- writer can break. The cache's payload rule is the one worth reading twice: it
-- makes `status` the discriminant of `result_json`, so a reader that has
-- checked the status has already checked the payload.
ALTER TABLE `project` ADD `optimization_delete_pending_at` integer;--> statement-breakpoint
CREATE TABLE `optimized_schedule_cache` (
	`project_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`objective` text NOT NULL,
	`contract_version` text NOT NULL,
	`budget_ms` integer NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `input_hash`, `objective`, `contract_version`, `budget_ms`),
	CONSTRAINT `fk_optimized_schedule_cache_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `optimized_schedule_cache_status` CHECK (`status` IN ('ok', 'failed', 'plan-infeasible')),
	CONSTRAINT `optimized_schedule_cache_objective` CHECK (`objective` IN ('pri', 'time')),
	CONSTRAINT `optimized_schedule_cache_payload` CHECK ((`status` = 'ok' AND `result_json` IS NOT NULL AND `failure_reason` IS NULL) OR (`status` = 'failed' AND `result_json` IS NULL AND `failure_reason` IS NOT NULL) OR (`status` = 'plan-infeasible' AND `result_json` IS NOT NULL AND `failure_reason` IS NULL)),
	CONSTRAINT `optimized_schedule_cache_failure_reason` CHECK (`failure_reason` IS NULL OR `failure_reason` IN ('timeout', 'invalid-output', 'no-solution', 'internal-error', 'oom', 'horizon-overflow', 'objective-overflow'))
);
--> statement-breakpoint
CREATE TABLE `optimization_generation` (
	`project_id` text NOT NULL,
	`contract_version` text NOT NULL,
	`generation` integer NOT NULL,
	`input_hash` text,
	`cancel_epoch` integer DEFAULT 0 NOT NULL,
	`admission_state` text DEFAULT 'open' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `contract_version`),
	CONSTRAINT `fk_optimization_generation_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `optimization_generation_admission_state` CHECK (`admission_state` IN ('open', 'draining'))
);
--> statement-breakpoint
CREATE TABLE `solver_slot` (
	`project_id` text NOT NULL,
	`contract_version` text NOT NULL,
	`generation` integer NOT NULL,
	`objective` text NOT NULL,
	`budget_ms` integer NOT NULL,
	`owner_id` text NOT NULL,
	`attempt_token` text NOT NULL,
	`lifecycle` text NOT NULL,
	`pid` integer,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`cancel_requested_at` integer,
	`admitted_deadline_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `contract_version`, `generation`, `objective`, `budget_ms`),
	CONSTRAINT `fk_solver_slot_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `solver_slot_lifecycle` CHECK (`lifecycle` IN ('starting', 'running')),
	CONSTRAINT `solver_slot_objective` CHECK (`objective` IN ('pri', 'time'))
);
--> statement-breakpoint
CREATE TABLE `solver_queue` (
	`project_id` text NOT NULL,
	`contract_version` text NOT NULL,
	`objective` text NOT NULL,
	`budget_ms` integer NOT NULL,
	`generation` integer NOT NULL,
	`admitted_cancel_epoch` integer NOT NULL,
	`enqueued_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `contract_version`, `objective`, `budget_ms`),
	CONSTRAINT `fk_solver_queue_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `solver_queue_objective` CHECK (`objective` IN ('pri', 'time'))
);
--> statement-breakpoint
-- The dequeue's whole `ORDER BY`, in its order. It is total: `objective` breaks
-- the tie between a project's two runs enqueued in the same millisecond, and
-- `contract_version` breaks the tie between blue and green enqueuing the same
-- project and objective in that same millisecond.
CREATE INDEX `solver_queue_dequeue_order` ON `solver_queue` (`enqueued_at`, `project_id`, `contract_version`, `objective`, `budget_ms`);
