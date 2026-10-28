-- Every statement may run again: a development database that applied an earlier draft of this
-- migration (before checks_schedule_note) applies it once more. Released databases (0.5.0)
-- never had the draft.
ALTER TYPE "public"."check_run_trigger" ADD VALUE IF NOT EXISTS 'schedule';--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "checks" SET DEFAULT '{"enabled":false,"composeFiles":[".devcontainer/compose.yaml"],"branches":null,"skipBots":false,"items":[],"schedule":null}'::jsonb;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "checks_last_slot" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "checks_schedule_note" text;--> statement-breakpoint
ALTER TABLE "check_runs" ADD COLUMN IF NOT EXISTS "tree_sha" text;--> statement-breakpoint
ALTER TABLE "check_runs" ADD COLUMN IF NOT EXISTS "copied_from_id" text;--> statement-breakpoint
ALTER TABLE "check_runs" ADD COLUMN IF NOT EXISTS "also_ref" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_copied_from_id_check_runs_id_fk" FOREIGN KEY ("copied_from_id") REFERENCES "public"."check_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "check_runs_app_id_tree_sha_idx" ON "check_runs" USING btree ("app_id","tree_sha") WHERE "check_runs"."tree_sha" IS NOT NULL;