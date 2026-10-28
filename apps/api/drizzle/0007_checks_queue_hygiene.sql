ALTER TYPE "public"."check_run_trigger" ADD VALUE 'schedule';--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "checks" SET DEFAULT '{"enabled":false,"composeFiles":[".devcontainer/compose.yaml"],"branches":null,"skipBots":false,"items":[],"schedule":null}'::jsonb;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "checks_last_slot" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "checks_schedule_note" text;--> statement-breakpoint
ALTER TABLE "check_runs" ADD COLUMN "tree_sha" text;--> statement-breakpoint
ALTER TABLE "check_runs" ADD COLUMN "copied_from_id" text;--> statement-breakpoint
ALTER TABLE "check_runs" ADD COLUMN "also_ref" text;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_copied_from_id_check_runs_id_fk" FOREIGN KEY ("copied_from_id") REFERENCES "public"."check_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_runs_app_id_tree_sha_idx" ON "check_runs" USING btree ("app_id","tree_sha") WHERE "check_runs"."tree_sha" IS NOT NULL;