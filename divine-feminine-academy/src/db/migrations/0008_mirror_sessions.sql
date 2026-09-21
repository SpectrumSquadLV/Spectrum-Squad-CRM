CREATE TABLE "mirror_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"source_block_id" uuid,
	"day_number" integer,
	"intention" text,
	"seconds_asked" integer DEFAULT 60 NOT NULL,
	"seconds_completed" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mirror_sessions" ADD CONSTRAINT "mirror_sessions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_sessions" ADD CONSTRAINT "mirror_sessions_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_sessions" ADD CONSTRAINT "mirror_sessions_source_block_id_lesson_blocks_id_fk" FOREIGN KEY ("source_block_id") REFERENCES "public"."lesson_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mirror_sessions_contact_idx" ON "mirror_sessions" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mirror_sessions_source_block_key" ON "mirror_sessions" USING btree ("enrollment_id","source_block_id");