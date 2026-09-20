CREATE TYPE "public"."cohort_status" AS ENUM('draft', 'scheduled', 'cancelled');--> statement-breakpoint
CREATE TABLE "cohort_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"day_number" integer,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"join_url" text,
	"replay_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "promise" text;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "status" "cohort_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "timezone" text DEFAULT 'America/Los_Angeles' NOT NULL;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "enrollment_opens_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "enrollment_closes_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "announced_open_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "announced_closing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "announced_start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cohort_id" uuid;--> statement-breakpoint
ALTER TABLE "cohort_sessions" ADD CONSTRAINT "cohort_sessions_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_waitlist" ADD CONSTRAINT "cohort_waitlist_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_waitlist" ADD CONSTRAINT "cohort_waitlist_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cohort_sessions_idx" ON "cohort_sessions" USING btree ("cohort_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cohort_waitlist_key" ON "cohort_waitlist" USING btree ("cohort_id","contact_id");--> statement-breakpoint
CREATE INDEX "cohort_waitlist_pending_idx" ON "cohort_waitlist" USING btree ("cohort_id","notified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cohorts_slug_key" ON "cohorts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "cohorts_status_idx" ON "cohorts" USING btree ("status","starts_at");