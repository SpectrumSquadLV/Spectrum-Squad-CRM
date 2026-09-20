ALTER TABLE "her_choices" ADD COLUMN "source_block_id" uuid;--> statement-breakpoint
ALTER TABLE "her_patterns" ADD COLUMN "source_block_id" uuid;--> statement-breakpoint
ALTER TABLE "her_choices" ADD CONSTRAINT "her_choices_source_block_id_lesson_blocks_id_fk" FOREIGN KEY ("source_block_id") REFERENCES "public"."lesson_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "her_patterns" ADD CONSTRAINT "her_patterns_source_block_id_lesson_blocks_id_fk" FOREIGN KEY ("source_block_id") REFERENCES "public"."lesson_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "her_choices_source_block_key" ON "her_choices" USING btree ("contact_id","source_block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "her_patterns_source_block_key" ON "her_patterns" USING btree ("source_enrollment_id","source_block_id");