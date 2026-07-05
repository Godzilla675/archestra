ALTER TABLE "kb_documents" ADD COLUMN "permission_sync_status" text;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "permission_sync_metadata" jsonb;