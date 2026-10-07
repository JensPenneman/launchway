ALTER TABLE "apps" ADD COLUMN "trusted_mounts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "proxy_services" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "allowed_bind_roots" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "extra_directives" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "forward_auth_target" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_one_forward_auth" CHECK ("settings"."forward_auth_url" IS NULL OR "settings"."forward_auth_target" IS NULL);