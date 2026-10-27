CREATE TYPE "public"."check_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'errored', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."check_run_trigger" AS ENUM('push', 'pull_request', 'manual');--> statement-breakpoint
CREATE TABLE "check_log_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "check_log_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"stream" "log_stream" NOT NULL,
	"line" text NOT NULL,
	"logged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"node_id" text NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"service" text NOT NULL,
	"compose_files" text[] NOT NULL,
	"timeout_minutes" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"ref" text,
	"pr_number" integer,
	"trigger" "check_run_trigger" NOT NULL,
	"status" "check_run_status" DEFAULT 'queued' NOT NULL,
	"reason" text,
	"exit_code" integer,
	"status_message" text,
	"github_state" text,
	"triggered_by_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "checks" jsonb DEFAULT '{"enabled":false,"composeFiles":[".devcontainer/compose.yaml"],"branches":null,"skipBots":false,"items":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "check_memory_mb" integer DEFAULT 2048 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "check_cpus" double precision DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "check_pids_limit" integer DEFAULT 4096 NOT NULL;--> statement-breakpoint
ALTER TABLE "check_log_lines" ADD CONSTRAINT "check_log_lines_run_id_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "check_log_lines_run_id_seq_key" ON "check_log_lines" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "check_log_lines_logged_at_idx" ON "check_log_lines" USING btree ("logged_at");--> statement-breakpoint
CREATE INDEX "check_runs_app_id_created_at_idx" ON "check_runs" USING btree ("app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "check_runs_node_id_status_idx" ON "check_runs" USING btree ("node_id","status");--> statement-breakpoint
CREATE INDEX "check_runs_app_id_commit_sha_idx" ON "check_runs" USING btree ("app_id","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "check_runs_one_running_per_node" ON "check_runs" USING btree ("node_id") WHERE "check_runs"."status" = 'running';