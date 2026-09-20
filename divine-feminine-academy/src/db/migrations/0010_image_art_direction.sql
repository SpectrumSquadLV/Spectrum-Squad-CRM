-- Art direction: a desktop crop and a mobile crop per slot.
--
-- Resizing one photograph for both never worked for the compositions this
-- site is built on. A frame with the subject to one side and the headline in
-- the empty half beside her loses the empty half on a phone, and the words
-- land on her face.
--
-- Everything already stored is a desktop crop, which is what the default says.
-- The unique key moves from the slot to the pair, so a slot can hold both.
ALTER TABLE "site_images" ADD COLUMN "variant" text DEFAULT 'desktop' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "site_images_slot_key";--> statement-breakpoint
CREATE UNIQUE INDEX "site_images_slot_key" ON "site_images" USING btree ("slot","variant");
