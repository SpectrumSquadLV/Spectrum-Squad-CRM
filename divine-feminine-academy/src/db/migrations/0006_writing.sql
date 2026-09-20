CREATE TYPE "public"."article_kind" AS ENUM('article', 'episode');--> statement-breakpoint
CREATE TYPE "public"."article_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"kind" "article_kind" DEFAULT 'article' NOT NULL,
	"status" "article_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"dek" text,
	"body" text DEFAULT '' NOT NULL,
	"author_name" text,
	"hero_image_url" text,
	"hero_image_alt" text,
	"area" "area",
	"archetype" text,
	"audio_url" text,
	"audio_duration_seconds" integer,
	"audio_size_bytes" integer,
	"seo_title" text,
	"seo_description" text,
	"upgrade_headline" text,
	"upgrade_blurb" text,
	"upgrade_tag" text,
	"published_at" timestamp with time zone,
	"announced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "articles_slug_key" ON "articles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "articles_published_idx" ON "articles" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "articles_kind_idx" ON "articles" USING btree ("kind","published_at");