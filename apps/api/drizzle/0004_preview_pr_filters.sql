ALTER TABLE "apps" ALTER COLUMN "previews" SET DEFAULT '{"enabled":false,"skipBots":true,"requireLabel":null,"hostTemplate":"{slug}-pr-{number}.{base}","envOverrides":{},"composeFiles":null}'::jsonb;--> statement-breakpoint
-- Existing apps get the defaults of the new preview filters; keys already set win.
UPDATE "apps" SET "previews" = '{"skipBots":true,"requireLabel":null}'::jsonb || "previews";