CREATE TYPE "public"."assessment_kind" AS ENUM('scored', 'archetype');--> statement-breakpoint
ALTER TABLE "assessment_results" ADD COLUMN "archetype" text;--> statement-breakpoint
ALTER TABLE "assessment_results" ADD COLUMN "secondary_archetype" text;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "kind" "assessment_kind" DEFAULT 'scored' NOT NULL;--> statement-breakpoint
CREATE INDEX "assessment_results_archetype_idx" ON "assessment_results" USING btree ("archetype");