CREATE TABLE "site_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" text NOT NULL,
	"alt" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"focal_x" integer DEFAULT 50 NOT NULL,
	"focal_y" integer DEFAULT 50 NOT NULL,
	"version" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "site_images_slot_key" ON "site_images" USING btree ("slot");--> statement-breakpoint
-- These are the public face of the site, so anyone may read them. Only an
-- admin may put one there, which is the part that actually matters: an upload
-- endpoint that writes bytes served back to every visitor is worth a second
-- lock behind the one in the route handler.
ALTER TABLE "site_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "site_images_read" ON "site_images" FOR SELECT USING (true);--> statement-breakpoint
CREATE POLICY "site_images_write" ON "site_images" FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
