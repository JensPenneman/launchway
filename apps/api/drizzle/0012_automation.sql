CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"state" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "automation" jsonb DEFAULT '{"merge":"off","train":"off","paused":false,"trainSchedule":null,"verify":{"baseUrl":null},"holdPaths":[],"dependabotUserId":49699333,"allowedPaths":["package.json","apps/*/package.json","packages/*/package.json","package-lock.json","Dockerfile",".devcontainer/Dockerfile","scripts/mapdata/Dockerfile","compose.yaml","deploy/compose.yaml",".devcontainer/compose*.yaml","tools/load/compose.load.yaml"],"holdImages":["postgres","postgis","timescaledb","pgvector"]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_app_id_kind_key_key" ON "automation_runs" USING btree ("app_id","kind","key");--> statement-breakpoint
CREATE INDEX "automation_runs_app_id_updated_at_idx" ON "automation_runs" USING btree ("app_id","updated_at" DESC NULLS LAST);