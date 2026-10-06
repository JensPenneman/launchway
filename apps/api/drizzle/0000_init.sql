CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'token', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."passkey_device_type" AS ENUM('singleDevice', 'multiDevice');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'cloning', 'building', 'starting', 'running', 'superseded', 'stopped', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."deployment_trigger" AS ENUM('manual', 'auto');--> statement-breakpoint
CREATE TYPE "public"."log_stream" AS ENUM('stdout', 'stderr', 'system');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified', 'misconfigured');--> statement-breakpoint
CREATE TYPE "public"."github_connection_kind" AS ENUM('app', 'pat');--> statement-breakpoint
CREATE TYPE "public"."node_status" AS ENUM('pending', 'online', 'offline');--> statement-breakpoint
CREATE TYPE "public"."route_target_kind" AS ENUM('app', 'external', 'redirect');--> statement-breakpoint
CREATE TYPE "public"."token_scope" AS ENUM('read', 'write', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"connection_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"compose_files" text[],
	"dockerfile" text,
	"context" text,
	"node_id" text NOT NULL,
	"auto_deploy_releases" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_source_xor" CHECK (("apps"."compose_files" IS NULL) <> ("apps"."dockerfile" IS NULL)),
	CONSTRAINT "apps_context_requires_dockerfile" CHECK ("apps"."context" IS NULL OR "apps"."dockerfile" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "env_vars" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"key" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"target_type" text,
	"target_id" text,
	"ip_address" "inet",
	"user_agent" text,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_type" "passkey_device_type" NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"aaguid" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_log_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deployment_log_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"deployment_id" text NOT NULL,
	"seq" integer NOT NULL,
	"stream" "log_stream" NOT NULL,
	"line" text NOT NULL,
	"logged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"node_id" text NOT NULL,
	"ref" text NOT NULL,
	"commit_sha" text NOT NULL,
	"trigger" "deployment_trigger" DEFAULT 'manual' NOT NULL,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"status_message" text,
	"triggered_by_id" text,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_provider_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_zones" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"zone_id" text,
	"proxied" boolean DEFAULT false NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"dns_record_external_id" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "github_connection_kind" NOT NULL,
	"name" text NOT NULL,
	"account_login" text,
	"account_type" text,
	"app_id" bigint,
	"app_slug" text,
	"app_html_url" text,
	"client_id" text,
	"client_secret_encrypted" text,
	"private_key_encrypted" text,
	"webhook_secret_encrypted" text,
	"installation_id" bigint,
	"token_encrypted" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_connections_credentials_present" CHECK (("github_connections"."kind" = 'app' AND "github_connections"."app_id" IS NOT NULL AND "github_connections"."private_key_encrypted" IS NOT NULL AND "github_connections"."webhook_secret_encrypted" IS NOT NULL) OR ("github_connections"."kind" = 'pat' AND "github_connections"."token_encrypted" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "github_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"connection_id" text,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"role" "user_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_id" text,
	"accepted_by_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_role_not_owner" CHECK ("invitations"."role" <> 'owner')
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "node_status" DEFAULT 'pending' NOT NULL,
	"lan_ip" "inet",
	"hostname" text,
	"arch" text,
	"agent_version" text,
	"protocol_version" integer,
	"docker_info" jsonb,
	"credential_hash" text,
	"credential_issued_at" timestamp with time zone,
	"join_token_hash" text,
	"join_token_expires_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"target_kind" "route_target_kind" NOT NULL,
	"app_id" text,
	"app_service" text,
	"app_port" integer,
	"external_scheme" text,
	"external_host" text,
	"external_port" integer,
	"redirect_to" text,
	"redirect_permanent" boolean,
	"protected" boolean DEFAULT false NOT NULL,
	"compress" boolean DEFAULT true NOT NULL,
	"hsts" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routes_target_complete" CHECK (("routes"."target_kind" = 'app' AND "routes"."app_id" IS NOT NULL AND "routes"."app_service" IS NOT NULL AND "routes"."app_port" IS NOT NULL) OR ("routes"."target_kind" = 'external' AND "routes"."external_scheme" IS NOT NULL AND "routes"."external_host" IS NOT NULL AND "routes"."external_port" IS NOT NULL) OR ("routes"."target_kind" = 'redirect' AND "routes"."redirect_to" IS NOT NULL AND "routes"."redirect_permanent" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"public_url" text,
	"acme_email" text,
	"anchor_hostname" text,
	"dynamic_dns_enabled" boolean DEFAULT false NOT NULL,
	"public_ipv4" "inet",
	"public_ipv4_checked_at" timestamp with time zone,
	"forward_auth_url" text,
	"edge_node_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"scopes" "token_scope"[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"password_hash" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_log_lines" ADD CONSTRAINT "deployment_log_lines_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_account_id_dns_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."dns_provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_zone_id_dns_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."dns_zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_id_users_id_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_edge_node_id_nodes_id_fk" FOREIGN KEY ("edge_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apps_slug_key" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "apps_node_id_idx" ON "apps" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "apps_connection_id_idx" ON "apps" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "env_vars_app_id_key_key" ON "env_vars" USING btree ("app_id","key");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkeys_credential_id_key" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_id_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_log_lines_deployment_id_seq_key" ON "deployment_log_lines" USING btree ("deployment_id","seq");--> statement-breakpoint
CREATE INDEX "deployments_app_id_created_at_idx" ON "deployments" USING btree ("app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deployments_node_id_idx" ON "deployments" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_one_running_per_app" ON "deployments" USING btree ("app_id") WHERE "deployments"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "dns_zones_account_id_external_id_key" ON "dns_zones" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "dns_zones_name_idx" ON "dns_zones" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_hostname_key" ON "domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "domains_zone_id_idx" ON "domains" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_connections_app_id_key" ON "github_connections" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_received_at_idx" ON "github_webhook_deliveries" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_expires_at_idx" ON "invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_name_key" ON "nodes" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_credential_hash_key" ON "nodes" USING btree ("credential_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_join_token_hash_key" ON "nodes" USING btree ("join_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "routes_domain_id_key" ON "routes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "routes_app_id_idx" ON "routes" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_owner_key" ON "users" USING btree ("role") WHERE "users"."role" = 'owner';