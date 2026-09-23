DROP INDEX "messages_message_id_header_unique";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "hop_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_inbox_message_id_header_unique" ON "messages" USING btree ("inbox_id","message_id_header");