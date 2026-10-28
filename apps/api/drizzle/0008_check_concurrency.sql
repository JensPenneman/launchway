DROP INDEX "check_runs_one_running_per_node";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "check_concurrency" integer DEFAULT 1 NOT NULL;