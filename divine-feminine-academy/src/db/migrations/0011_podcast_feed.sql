-- Podcast episodes, sourced from the show's own feed.
--
-- The first four columns are the feed's: RSS.com hosts Brown Girls Need
-- Healing Too and that feed is what Apple and Spotify already have, so a sync
-- writes what it carries and nothing else.
--
-- The rest are ours. A feed has no idea which challenge an episode should
-- point a listener at, what the transcript says, or which episode belongs at
-- the top of the page - and a sync must never overwrite them.
ALTER TABLE "articles" ADD COLUMN "feed_guid" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "feed_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "artwork_url" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "episode_number" integer;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "season_number" integer;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "transcript" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "cta_program_slug" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "featured_at" timestamp with time zone;--> statement-breakpoint
-- One row per episode in the feed. The guid is what the feed calls the
-- episode, so a re-sync updates rather than duplicates, and a title changed at
-- the host lands on the row it belongs to. Partial, because everything that is
-- not an imported episode has no guid at all.
CREATE UNIQUE INDEX "articles_feed_guid_key" ON "articles" USING btree ("feed_guid") WHERE "feed_guid" IS NOT NULL;
