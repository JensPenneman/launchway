CREATE TYPE "public"."preview_status" AS ENUM('pending', 'deploying', 'running', 'failed', 'closing', 'closed');--> statement-breakpoint
ALTER TYPE "public"."deployment_trigger" ADD VALUE 'preview';--> statement-breakpoint
CREATE TABLE "previews" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_title" text NOT NULL,
	"head_sha" text NOT NULL,
	"branch" text NOT NULL,
	"hostname" text NOT NULL,
	"domain_id" text,
	"route_id" text,
	"status" "preview_status" DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"active_deployment_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "deployments_one_running_per_app";--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "auto_deploy_prereleases" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "auto_deploy_branch" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "github_deployments" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "previews" jsonb DEFAULT '{"enabled":false,"hostTemplate":"{slug}-pr-{number}.{base}","envOverrides":{},"composeFiles":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "preview_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "environment_name" text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "github_deployment_id" bigint;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "preview_base_domain" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "preview_max_per_app" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "preview_max_total" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "previews_app_id_pr_number_key" ON "previews" USING btree ("app_id","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "previews_route_id_key" ON "previews" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "previews_status_idx" ON "previews" USING btree ("status");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_preview_id_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployments_preview_id_idx" ON "deployments" USING btree ("preview_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_one_running_per_environment" ON "deployments" USING btree ("app_id","environment_name") WHERE "deployments"."status" = 'running';