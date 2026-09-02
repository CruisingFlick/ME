ALTER TABLE "requests" ADD COLUMN "triage_summary" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "triage_priority" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "triaged_at" timestamp with time zone;