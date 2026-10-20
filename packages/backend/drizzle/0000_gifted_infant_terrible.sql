CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_name" varchar(80) NOT NULL,
	"dedupe_key" varchar(160),
	"session_id" uuid,
	"entity_type" varchar(80),
	"entity_id" varchar(160),
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"properties" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_partners_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "channel_qr_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"code" varchar(80) NOT NULL,
	"url" varchar(500) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_qr_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(200),
	"summary" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"prompt_snapshot" text,
	"prompt_snapshot_meta" jsonb,
	"summarized_up_to_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_in_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_message_id" uuid,
	"assistant_message_id" uuid,
	"tool_call_id" varchar(120) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"record_id" uuid,
	"schema_action_hint" varchar(20) NOT NULL,
	"existing_schema_id" uuid,
	"category_name" varchar(120) NOT NULL,
	"display_mode" varchar(20) DEFAULT 'calendar' NOT NULL,
	"schema_json" jsonb NOT NULL,
	"values_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attachments_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"recorded_at" timestamp with time zone,
	"source_evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_fields_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "check_in_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"schema_id" uuid NOT NULL,
	"category_key" varchar(80) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"title" varchar(160) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by_type" varchar(20) NOT NULL,
	"recorded_by_name" varchar(100) NOT NULL,
	"source_session_id" uuid,
	"source_message_id" uuid,
	"tool_call_id" varchar(120),
	"values_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attachments_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rendered_a2ui_schema" jsonb NOT NULL,
	"schema_snapshot" jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"dedupe_key" varchar(80) NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"card_date" date NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"source_session_id" uuid,
	"content_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctors" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"doctor_invite_code" varchar(120),
	"name" varchar(100) NOT NULL,
	"avatar_url" varchar(500),
	"hospital" varchar(200),
	"department" varchar(100),
	"title" varchar(100),
	"phone" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "efficacy_session_analysis_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"analyzed_up_to_created_at" timestamp with time zone,
	"last_analyzed_at" timestamp with time zone,
	"analysis_count" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(1000),
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_education_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" varchar(64) NOT NULL,
	"reaction" varchar(10),
	"is_favorited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_education_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" varchar(120) NOT NULL,
	"title" varchar(200) NOT NULL,
	"summary" varchar(500),
	"content" text NOT NULL,
	"image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'published' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_education_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" varchar(64) NOT NULL,
	"view_id" varchar(160) NOT NULL,
	"source" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" varchar(40) DEFAULT 'chat' NOT NULL,
	"original_key" varchar(500) NOT NULL,
	"model_key" varchar(500) NOT NULL,
	"thumb_key" varchar(500) NOT NULL,
	"display_key" varchar(500) NOT NULL,
	"mime_type" varchar(80) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_video_engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"tool_call_id" varchar(120) NOT NULL,
	"video_id" varchar(120) NOT NULL,
	"video_version" varchar(120) NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"total_watched_sec" integer DEFAULT 0 NOT NULL,
	"last_position_sec" integer DEFAULT 0 NOT NULL,
	"play_started_at" timestamp with time zone,
	"last_stopped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"stop_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_videos" (
	"video_id" varchar(120) PRIMARY KEY NOT NULL,
	"version" varchar(120) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_ref" varchar(500) DEFAULT '' NOT NULL,
	"tags" jsonb NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"video_key" varchar(300) NOT NULL,
	"poster_key" varchar(300) NOT NULL,
	"status" varchar(20) DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention_discomfort_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"resource_kind" varchar(40) NOT NULL,
	"resource_id" varchar(160) NOT NULL,
	"resource_title" varchar(240),
	"resource_context" varchar(160),
	"tool_call_id" varchar(120),
	"engagement_id" uuid,
	"timing" varchar(10) NOT NULL,
	"score" integer NOT NULL,
	"source" varchar(20) DEFAULT 'chat_inline' NOT NULL,
	"total_follow_sec" integer,
	"material_duration_sec" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention_efficacy_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"problem" text NOT NULL,
	"final_plan" text NOT NULL,
	"cadence" varchar(20) DEFAULT 'oneshot' NOT NULL,
	"expected_end_at" timestamp with time zone,
	"adoption_status" varchar(20) DEFAULT 'unknown' NOT NULL,
	"outcome" varchar(20) DEFAULT 'no_feedback' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" integer DEFAULT 70 NOT NULL,
	"source_session_ids" uuid[] DEFAULT '{}' NOT NULL,
	"first_source_message_id" uuid,
	"last_source_message_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention_followup_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"engagement_id" uuid,
	"kind" varchar(40) NOT NULL,
	"status" varchar(40) DEFAULT 'pending' NOT NULL,
	"claim_token" varchar(120),
	"generated_message_id" uuid,
	"metadata" jsonb,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention_material_engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"tool_call_id" varchar(120) NOT NULL,
	"material_id" varchar(120) NOT NULL,
	"material_version" varchar(120) NOT NULL,
	"material_code" varchar(20) NOT NULL,
	"material_duration_sec" integer DEFAULT 0 NOT NULL,
	"saved_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"follow_started_at" timestamp with time zone,
	"follow_completed_at" timestamp with time zone,
	"total_follow_sec" integer DEFAULT 0 NOT NULL,
	"completed_step_count" integer DEFAULT 0 NOT NULL,
	"total_step_count" integer DEFAULT 0 NOT NULL,
	"last_step_index" integer,
	"reminder_consumed_at" timestamp with time zone,
	"effect_followup_due_at" timestamp with time zone,
	"effect_followup_status" varchar(20) DEFAULT 'none' NOT NULL,
	"effect_followup_sent_at" timestamp with time zone,
	"effect_followup_message_id" uuid,
	"effect_followup_attempt_count" integer DEFAULT 0 NOT NULL,
	"effect_followup_last_error" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention_plan_demand_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"demand_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention_plan_demands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_query" text NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_date" date,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" varchar(200),
	"document_type" varchar(50),
	"hospital" varchar(200),
	"ocr_text" text NOT NULL,
	"image_urls" text NOT NULL,
	"base64_urls" text,
	"raw_text_url" varchar(500),
	"page_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"profile_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_message_id" uuid,
	"user_content_snapshot" text,
	"content_snapshot" text NOT NULL,
	"content_preview" varchar(240) NOT NULL,
	"session_title_snapshot" varchar(200),
	"message_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_image_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"thinking" text,
	"tool_calls" jsonb,
	"raw_response" jsonb,
	"token_count" integer,
	"llm_input_tokens" integer,
	"llm_cached_input_tokens" integer,
	"llm_cache_creation_input_tokens" integer,
	"process_duration_ms" integer,
	"output_tps" double precision,
	"interrupted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"install_id" varchar(120) NOT NULL,
	"user_id" uuid,
	"event_name" varchar(80) NOT NULL,
	"dedupe_key" varchar(180),
	"entity_type" varchar(80),
	"entity_id" varchar(160),
	"platform" varchar(20) NOT NULL,
	"app_version" varchar(80),
	"version_code" varchar(80),
	"build_number" varchar(80),
	"channel" varchar(80),
	"os_version" varchar(80),
	"sdk_int" integer,
	"manufacturer" varchar(120),
	"model" varchar(120),
	"webview_version" varchar(160),
	"bridge_version" varchar(40),
	"bridge_modules" jsonb,
	"geo_source" varchar(40),
	"geo_country" varchar(80),
	"geo_province" varchar(120),
	"geo_city" varchar(120),
	"geo_precision" varchar(40),
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"properties" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_doctor_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"doctor_id" varchar(120) NOT NULL,
	"status" varchar(30) DEFAULT 'pending_confirmation' NOT NULL,
	"unbind_requested_by" varchar(20),
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" varchar(20) NOT NULL,
	"provider" varchar(20) DEFAULT 'jpush' NOT NULL,
	"registration_id" varchar(512) NOT NULL,
	"device_id" varchar(256),
	"app_version" varchar(64),
	"apns_environment" varchar(20),
	"push_enabled" boolean DEFAULT true NOT NULL,
	"notification_permission" varchar(20) DEFAULT 'unknown' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"platform" varchar(20) NOT NULL,
	"provider" varchar(20) DEFAULT 'jpush' NOT NULL,
	"audience_type" varchar(40) NOT NULL,
	"audience_value" varchar(512),
	"title" varchar(120) NOT NULL,
	"alert" varchar(500) NOT NULL,
	"route" varchar(500),
	"dedupe_key" varchar(160),
	"payload" jsonb,
	"provider_response" jsonb,
	"provider_msg_id" varchar(120),
	"provider_sendno" varchar(120),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error_code" varchar(80),
	"error_message" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommended_question_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_date" varchar(10) NOT NULL,
	"trigger" varchar(40) DEFAULT 'profile_generation' NOT NULL,
	"source_profile_memory_id" uuid,
	"source_hash" varchar(80) NOT NULL,
	"status" varchar(24) DEFAULT 'failed' NOT NULL,
	"model" varchar(120),
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"selected_count" integer DEFAULT 0 NOT NULL,
	"fallback_count" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(80),
	"error_message" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommended_question_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_status" varchar(24) NOT NULL,
	"source" varchar(20) NOT NULL,
	"text" varchar(120) NOT NULL,
	"normalized_text" varchar(160) NOT NULL,
	"text_hash" varchar(80) NOT NULL,
	"semantic_key" varchar(240) NOT NULL,
	"topic" varchar(80) NOT NULL,
	"intent" varchar(80) NOT NULL,
	"keywords" jsonb,
	"reason" varchar(500),
	"raw_rank" integer,
	"rank" integer,
	"confidence" integer,
	"risk_level" varchar(20),
	"final_score" integer,
	"quality_score" integer,
	"risk_flags" jsonb,
	"filter_reason" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"device_name" varchar(100),
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scheduled_proactive_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"purpose" varchar(80) NOT NULL,
	"task_name" varchar(120) DEFAULT '提醒' NOT NULL,
	"time_source" varchar(40) NOT NULL,
	"schedule_type" varchar(20) DEFAULT 'once' NOT NULL,
	"cron_expression" varchar(160),
	"timezone" varchar(64) DEFAULT 'Asia/Shanghai' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"last_due_at" timestamp with time zone,
	"status" varchar(40) DEFAULT 'pending' NOT NULL,
	"message_content" text NOT NULL,
	"push_title" varchar(120) DEFAULT 'Health Agent Lab' NOT NULL,
	"push_alert" varchar(500) NOT NULL,
	"app_notify_enabled" boolean DEFAULT true NOT NULL,
	"calendar_sync_enabled" boolean DEFAULT true NOT NULL,
	"route" varchar(500),
	"entity_type" varchar(80),
	"entity_id" varchar(160),
	"dedupe_key" varchar(160),
	"metadata" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(1000),
	"sent_at" timestamp with time zone,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_task_calendar_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scheduled_task_id" uuid NOT NULL,
	"platform" varchar(20) NOT NULL,
	"device_key" varchar(256) NOT NULL,
	"external_ids" jsonb,
	"plan_hash" varchar(120),
	"sync_status" varchar(40) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(1000),
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"up_to_message_id" uuid NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"feedback_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "todo_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"schedule_id" uuid,
	"todo_date" date NOT NULL,
	"todo_time" varchar(5) NOT NULL,
	"show_prompt" varchar(500) NOT NULL,
	"prompt" text NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"feedback" varchar(20),
	"notified_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_reason" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"status" varchar(32) DEFAULT 'not_started' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Shanghai' NOT NULL,
	"source_type" varchar(32) DEFAULT 'custom' NOT NULL,
	"source_id" varchar(160),
	"resource_ref_id" varchar(80),
	"course_days" integer,
	"target_side_effect" varchar(120),
	"resource_snapshot" jsonb,
	"dedupe_key" varchar(160),
	"todos_md" text DEFAULT '' NOT NULL,
	"stopped_reason" varchar(500),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracking_events_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" varchar(120) NOT NULL,
	"event_name" varchar(120) NOT NULL,
	"event_version" varchar(40) NOT NULL,
	"source" varchar(40) NOT NULL,
	"platform" varchar(40),
	"install_id" varchar(120),
	"user_id" uuid,
	"app_session_id" varchar(120),
	"web_session_id" varchar(120),
	"trace_id" varchar(120),
	"request_id" varchar(120),
	"chat_session_id" uuid,
	"entity_type" varchar(80),
	"entity_id" varchar(160),
	"route" varchar(240),
	"app_version" varchar(80),
	"build_number" varchar(80),
	"channel" varchar(80),
	"event_time" timestamp with time zone NOT NULL,
	"receive_time" timestamp with time zone DEFAULT now() NOT NULL,
	"properties" jsonb,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_check_in_schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_key" varchar(80) NOT NULL,
	"category_name" varchar(120) NOT NULL,
	"display_mode" varchar(20) DEFAULT 'calendar' NOT NULL,
	"category_description" varchar(500),
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"schema_hash" varchar(80) NOT NULL,
	"a2ui_schema" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_from_session_id" uuid,
	"created_from_message_id" uuid,
	"created_from_tool_call_id" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"consent_type" varchar(32) NOT NULL,
	"version" varchar(16) NOT NULL,
	"agreed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" varchar(64),
	"user_agent" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "user_daily_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_date" date NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_daily_structured_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_date" date NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_fields" text[] DEFAULT '{}' NOT NULL,
	"model_used" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memory_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"embedding_model" varchar(120) NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_type" varchar(40) NOT NULL,
	"content" text NOT NULL,
	"source" varchar(40) DEFAULT 'reviewer' NOT NULL,
	"source_session_id" uuid,
	"source_message_id" uuid,
	"importance" integer DEFAULT 1 NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_profiles_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"user_md" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_memory_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" varchar(20) NOT NULL,
	"nickname" varchar(100),
	"avatar_url" varchar(500),
	"birthday" date,
	"gender" varchar(10),
	"current_concern" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"channel_partner_id" uuid,
	"channel_agent_id" uuid,
	"channel_qr_code_id" uuid,
	"channel_attributed_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_partner_id_channel_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."channel_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_qr_codes" ADD CONSTRAINT "channel_qr_codes_partner_id_channel_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."channel_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_qr_codes" ADD CONSTRAINT "channel_qr_codes_agent_id_channel_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."channel_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_cards" ADD CONSTRAINT "check_in_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_cards" ADD CONSTRAINT "check_in_cards_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_cards" ADD CONSTRAINT "check_in_cards_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_cards" ADD CONSTRAINT "check_in_cards_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_cards" ADD CONSTRAINT "check_in_cards_record_id_check_in_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."check_in_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_cards" ADD CONSTRAINT "check_in_cards_existing_schema_id_user_check_in_schemas_id_fk" FOREIGN KEY ("existing_schema_id") REFERENCES "public"."user_check_in_schemas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_records" ADD CONSTRAINT "check_in_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_records" ADD CONSTRAINT "check_in_records_schema_id_user_check_in_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."user_check_in_schemas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_records" ADD CONSTRAINT "check_in_records_source_session_id_chat_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_records" ADD CONSTRAINT "check_in_records_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_cards" ADD CONSTRAINT "communication_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "efficacy_session_analysis_state" ADD CONSTRAINT "efficacy_session_analysis_state_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "efficacy_session_analysis_state" ADD CONSTRAINT "efficacy_session_analysis_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_education_interactions" ADD CONSTRAINT "health_education_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_education_items" ADD CONSTRAINT "health_education_items_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_education_views" ADD CONSTRAINT "health_education_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_video_engagements" ADD CONSTRAINT "internal_video_engagements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_video_engagements" ADD CONSTRAINT "internal_video_engagements_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_discomfort_feedback" ADD CONSTRAINT "intervention_discomfort_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_discomfort_feedback" ADD CONSTRAINT "intervention_discomfort_feedback_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_discomfort_feedback" ADD CONSTRAINT "intervention_discomfort_feedback_engagement_id_intervention_material_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."intervention_material_engagements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_efficacy_records" ADD CONSTRAINT "intervention_efficacy_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_efficacy_records" ADD CONSTRAINT "intervention_efficacy_records_first_source_message_id_messages_id_fk" FOREIGN KEY ("first_source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_efficacy_records" ADD CONSTRAINT "intervention_efficacy_records_last_source_message_id_messages_id_fk" FOREIGN KEY ("last_source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_followup_intents" ADD CONSTRAINT "intervention_followup_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_followup_intents" ADD CONSTRAINT "intervention_followup_intents_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_followup_intents" ADD CONSTRAINT "intervention_followup_intents_engagement_id_intervention_material_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."intervention_material_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_followup_intents" ADD CONSTRAINT "intervention_followup_intents_generated_message_id_messages_id_fk" FOREIGN KEY ("generated_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_material_engagements" ADD CONSTRAINT "intervention_material_engagements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_material_engagements" ADD CONSTRAINT "intervention_material_engagements_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_material_engagements" ADD CONSTRAINT "intervention_material_engagements_effect_followup_message_id_messages_id_fk" FOREIGN KEY ("effect_followup_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_plan_demands" ADD CONSTRAINT "intervention_plan_demands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_plan_demands" ADD CONSTRAINT "intervention_plan_demands_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_plan_demands" ADD CONSTRAINT "intervention_plan_demands_merged_into_id_intervention_plan_demand_groups_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."intervention_plan_demand_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_documents" ADD CONSTRAINT "medical_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_favorites" ADD CONSTRAINT "message_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_favorites" ADD CONSTRAINT "message_favorites_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_favorites" ADD CONSTRAINT "message_favorites_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_favorites" ADD CONSTRAINT "message_favorites_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_image_attachments" ADD CONSTRAINT "message_image_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_image_attachments" ADD CONSTRAINT "message_image_attachments_asset_id_image_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."image_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_analytics_events" ADD CONSTRAINT "native_analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_doctor_bindings" ADD CONSTRAINT "patient_doctor_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_doctor_bindings" ADD CONSTRAINT "patient_doctor_bindings_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_logs" ADD CONSTRAINT "push_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommended_question_batches" ADD CONSTRAINT "recommended_question_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommended_question_batches" ADD CONSTRAINT "recommended_question_batches_source_profile_memory_id_user_profiles_memory_id_fk" FOREIGN KEY ("source_profile_memory_id") REFERENCES "public"."user_profiles_memory"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommended_question_items" ADD CONSTRAINT "recommended_question_items_batch_id_recommended_question_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."recommended_question_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommended_question_items" ADD CONSTRAINT "recommended_question_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_proactive_messages" ADD CONSTRAINT "scheduled_proactive_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_proactive_messages" ADD CONSTRAINT "scheduled_proactive_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_proactive_messages" ADD CONSTRAINT "scheduled_proactive_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_task_calendar_links" ADD CONSTRAINT "scheduled_task_calendar_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_task_calendar_links" ADD CONSTRAINT "scheduled_task_calendar_links_scheduled_task_id_scheduled_proactive_messages_id_fk" FOREIGN KEY ("scheduled_task_id") REFERENCES "public"."scheduled_proactive_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_up_to_message_id_messages_id_fk" FOREIGN KEY ("up_to_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_plan_id_todo_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."todo_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_schedule_id_scheduled_proactive_messages_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."scheduled_proactive_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_plans" ADD CONSTRAINT "todo_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_plans" ADD CONSTRAINT "todo_plans_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_check_in_schemas" ADD CONSTRAINT "user_check_in_schemas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_check_in_schemas" ADD CONSTRAINT "user_check_in_schemas_created_from_session_id_chat_sessions_id_fk" FOREIGN KEY ("created_from_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_check_in_schemas" ADD CONSTRAINT "user_check_in_schemas_created_from_message_id_messages_id_fk" FOREIGN KEY ("created_from_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_daily_memories" ADD CONSTRAINT "user_daily_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_daily_structured_profiles" ADD CONSTRAINT "user_daily_structured_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_embeddings" ADD CONSTRAINT "user_memory_embeddings_memory_item_id_user_memory_items_id_fk" FOREIGN KEY ("memory_item_id") REFERENCES "public"."user_memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_embeddings" ADD CONSTRAINT "user_memory_embeddings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_items" ADD CONSTRAINT "user_memory_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_items" ADD CONSTRAINT "user_memory_items_source_session_id_chat_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_items" ADD CONSTRAINT "user_memory_items_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles_memory" ADD CONSTRAINT "user_profiles_memory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_channel_partner_id_channel_partners_id_fk" FOREIGN KEY ("channel_partner_id") REFERENCES "public"."channel_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_channel_agent_id_channel_agents_id_fk" FOREIGN KEY ("channel_agent_id") REFERENCES "public"."channel_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_channel_qr_code_id_channel_qr_codes_id_fk" FOREIGN KEY ("channel_qr_code_id") REFERENCES "public"."channel_qr_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_analytics_events_user_name_dedupe" ON "analytics_events" USING btree ("user_id","event_name","dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_analytics_events_user_created" ON "analytics_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_analytics_events_name_created" ON "analytics_events" USING btree ("event_name","created_at");--> statement-breakpoint
CREATE INDEX "idx_analytics_events_session_created" ON "analytics_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_channel_agents_partner_code" ON "channel_agents" USING btree ("partner_id","code");--> statement-breakpoint
CREATE INDEX "idx_channel_agents_partner" ON "channel_agents" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_channel_agents_status" ON "channel_agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_channel_partners_status" ON "channel_partners" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_channel_qr_codes_partner" ON "channel_qr_codes" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_channel_qr_codes_agent" ON "channel_qr_codes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_channel_qr_codes_status" ON "channel_qr_codes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_user_updated" ON "chat_sessions" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_title_trgm" ON "chat_sessions" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_check_in_cards_session_tool" ON "check_in_cards" USING btree ("session_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "idx_check_in_cards_user_status_updated" ON "check_in_cards" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_check_in_cards_user_session_updated" ON "check_in_cards" USING btree ("user_id","session_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_check_in_cards_record" ON "check_in_cards" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_check_in_records_user_dedupe" ON "check_in_records" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_check_in_records_session_tool" ON "check_in_records" USING btree ("source_session_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "idx_check_in_records_user_recorded" ON "check_in_records" USING btree ("user_id","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_check_in_records_user_category_recorded" ON "check_in_records" USING btree ("user_id","category_key","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_communication_cards_user_date" ON "communication_cards" USING btree ("user_id","card_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_efficacy_analysis_state_session" ON "efficacy_session_analysis_state" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_health_education_interactions_user_item" ON "health_education_interactions" USING btree ("user_id","item_id");--> statement-breakpoint
CREATE INDEX "idx_health_education_interactions_item" ON "health_education_interactions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_health_education_interactions_user_favorite" ON "health_education_interactions" USING btree ("user_id","is_favorited");--> statement-breakpoint
CREATE INDEX "idx_health_education_items_doctor" ON "health_education_items" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "idx_health_education_items_status_published" ON "health_education_items" USING btree ("status","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_health_education_views_user_view" ON "health_education_views" USING btree ("user_id","view_id");--> statement-breakpoint
CREATE INDEX "idx_health_education_views_item" ON "health_education_views" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_health_education_views_item_user" ON "health_education_views" USING btree ("item_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_health_education_views_created" ON "health_education_views" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_image_assets_user_created" ON "image_assets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_image_assets_user_hash_purpose" ON "image_assets" USING btree ("user_id","sha256","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_internal_video_engagement_session_tool_video" ON "internal_video_engagements" USING btree ("session_id","tool_call_id","video_id");--> statement-breakpoint
CREATE INDEX "idx_internal_video_engagement_user_updated" ON "internal_video_engagements" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_internal_video_engagement_session_updated" ON "internal_video_engagements" USING btree ("session_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_intervention_discomfort_feedback_resource_timing" ON "intervention_discomfort_feedback" USING btree ("user_id","session_id","resource_kind","resource_id","timing");--> statement-breakpoint
CREATE INDEX "idx_intervention_discomfort_feedback_session_created" ON "intervention_discomfort_feedback" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_intervention_discomfort_feedback_user_created" ON "intervention_discomfort_feedback" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_efficacy_records_user_status_updated" ON "intervention_efficacy_records" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_efficacy_records_user_adoption" ON "intervention_efficacy_records" USING btree ("user_id","adoption_status");--> statement-breakpoint
CREATE INDEX "idx_efficacy_records_user_outcome" ON "intervention_efficacy_records" USING btree ("user_id","outcome");--> statement-breakpoint
CREATE INDEX "idx_intervention_followup_intents_session_status" ON "intervention_followup_intents" USING btree ("session_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_intervention_followup_intents_engagement_status" ON "intervention_followup_intents" USING btree ("engagement_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_intervention_engagement_session_tool" ON "intervention_material_engagements" USING btree ("session_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "idx_intervention_engagement_user_saved" ON "intervention_material_engagements" USING btree ("user_id","saved_at");--> statement-breakpoint
CREATE INDEX "idx_intervention_engagement_user_updated" ON "intervention_material_engagements" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_intervention_engagement_session_updated" ON "intervention_material_engagements" USING btree ("session_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_intervention_effect_followup_due" ON "intervention_material_engagements" USING btree ("effect_followup_status","effect_followup_due_at");--> statement-breakpoint
CREATE INDEX "idx_plan_demand_groups_status_count" ON "intervention_plan_demand_groups" USING btree ("status","demand_count");--> statement-breakpoint
CREATE INDEX "idx_plan_demands_status_created" ON "intervention_plan_demands" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_plan_demands_merged_into" ON "intervention_plan_demands" USING btree ("merged_into_id");--> statement-breakpoint
CREATE INDEX "idx_medical_documents_user_date" ON "medical_documents" USING btree ("user_id","document_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_message_favorites_user_message" ON "message_favorites" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_message_favorites_user_created" ON "message_favorites" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_message_favorites_session" ON "message_favorites" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_message_favorites_message" ON "message_favorites" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_message" ON "message_feedback" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_session" ON "message_feedback" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_user" ON "message_feedback" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_message_image_attachments_message_position" ON "message_image_attachments" USING btree ("message_id","position");--> statement-breakpoint
CREATE INDEX "idx_message_image_attachments_asset" ON "message_image_attachments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_messages_session_created" ON "messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_content_trgm" ON "messages" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_native_analytics_install_name_dedupe" ON "native_analytics_events" USING btree ("install_id","event_name","dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_native_analytics_install_created" ON "native_analytics_events" USING btree ("install_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_native_analytics_user_created" ON "native_analytics_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_native_analytics_name_created" ON "native_analytics_events" USING btree ("event_name","created_at");--> statement-breakpoint
CREATE INDEX "idx_native_analytics_platform_created" ON "native_analytics_events" USING btree ("platform","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_patient_doctor_bindings_user_doctor" ON "patient_doctor_bindings" USING btree ("user_id","doctor_id");--> statement-breakpoint
CREATE INDEX "idx_patient_doctor_bindings_user" ON "patient_doctor_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_patient_doctor_bindings_doctor" ON "patient_doctor_bindings" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "idx_patient_doctor_bindings_status" ON "patient_doctor_bindings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_push_devices_provider_platform_registration" ON "push_devices" USING btree ("provider","platform","registration_id");--> statement-breakpoint
CREATE INDEX "idx_push_devices_user_platform" ON "push_devices" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "idx_push_devices_user_active" ON "push_devices" USING btree ("user_id","push_enabled","unbound_at");--> statement-breakpoint
CREATE INDEX "idx_push_devices_last_seen" ON "push_devices" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_push_logs_user_created" ON "push_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_push_logs_status_created" ON "push_logs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_push_logs_dedupe" ON "push_logs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_recommended_question_batches_user_date_trigger" ON "recommended_question_batches" USING btree ("user_id","source_date","trigger");--> statement-breakpoint
CREATE INDEX "idx_recommended_question_batches_user_status_expires" ON "recommended_question_batches" USING btree ("user_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_recommended_question_batches_profile_memory" ON "recommended_question_batches" USING btree ("source_profile_memory_id");--> statement-breakpoint
CREATE INDEX "idx_recommended_question_items_batch_status_rank" ON "recommended_question_items" USING btree ("user_id","batch_id","item_status","rank");--> statement-breakpoint
CREATE INDEX "idx_recommended_question_items_text_hash" ON "recommended_question_items" USING btree ("user_id","text_hash","created_at");--> statement-breakpoint
CREATE INDEX "idx_recommended_question_items_semantic" ON "recommended_question_items" USING btree ("user_id","semantic_key","created_at");--> statement-breakpoint
CREATE INDEX "idx_recommended_question_items_topic" ON "recommended_question_items" USING btree ("user_id","topic","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_sessions_token_hash_uq" ON "refresh_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_refresh_sessions_user_expires" ON "refresh_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_proactive_due" ON "scheduled_proactive_messages" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_proactive_user_created" ON "scheduled_proactive_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_proactive_entity_status" ON "scheduled_proactive_messages" USING btree ("entity_type","entity_id","status");--> statement-breakpoint
CREATE INDEX "idx_scheduled_proactive_dedupe" ON "scheduled_proactive_messages" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_scheduled_task_calendar_device" ON "scheduled_task_calendar_links" USING btree ("scheduled_task_id","platform","device_key");--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_calendar_user_device" ON "scheduled_task_calendar_links" USING btree ("user_id","platform","device_key");--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_calendar_status" ON "scheduled_task_calendar_links" USING btree ("sync_status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_todo_items_plan_time" ON "todo_items" USING btree ("plan_id","todo_date","todo_time");--> statement-breakpoint
CREATE INDEX "idx_todo_items_user_status_time" ON "todo_items" USING btree ("user_id","status","todo_date","todo_time");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_todo_items_schedule" ON "todo_items" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "idx_todo_plans_user_status_updated" ON "todo_plans" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_todo_plans_session_updated" ON "todo_plans" USING btree ("session_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_todo_plans_source" ON "todo_plans" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "idx_todo_plans_dedupe" ON "todo_plans" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tracking_events_raw_event_id" ON "tracking_events_raw" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_tracking_events_raw_name_time" ON "tracking_events_raw" USING btree ("event_name","event_time");--> statement-breakpoint
CREATE INDEX "idx_tracking_events_raw_user_time" ON "tracking_events_raw" USING btree ("user_id","event_time");--> statement-breakpoint
CREATE INDEX "idx_tracking_events_raw_install_time" ON "tracking_events_raw" USING btree ("install_id","event_time");--> statement-breakpoint
CREATE INDEX "idx_tracking_events_raw_app_session_time" ON "tracking_events_raw" USING btree ("app_session_id","event_time");--> statement-breakpoint
CREATE INDEX "idx_tracking_events_raw_trace_time" ON "tracking_events_raw" USING btree ("trace_id","event_time");--> statement-breakpoint
CREATE INDEX "idx_tracking_events_raw_request_time" ON "tracking_events_raw" USING btree ("request_id","event_time");--> statement-breakpoint
CREATE INDEX "idx_tracking_events_raw_created_at" ON "tracking_events_raw" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_check_in_schemas_user_category" ON "user_check_in_schemas" USING btree ("user_id","category_key");--> statement-breakpoint
CREATE INDEX "idx_user_check_in_schemas_user_updated" ON "user_check_in_schemas" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_user_check_in_schemas_user_last_used" ON "user_check_in_schemas" USING btree ("user_id","last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_consent_type_version" ON "user_consents" USING btree ("user_id","consent_type","version");--> statement-breakpoint
CREATE INDEX "idx_user_consents_user_type" ON "user_consents" USING btree ("user_id","consent_type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_daily_memories_user_date" ON "user_daily_memories" USING btree ("user_id","memory_date");--> statement-breakpoint
CREATE INDEX "idx_daily_memories_date" ON "user_daily_memories" USING btree ("memory_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_daily_sp_user_date" ON "user_daily_structured_profiles" USING btree ("user_id","profile_date");--> statement-breakpoint
CREATE INDEX "idx_user_daily_sp_date" ON "user_daily_structured_profiles" USING btree ("profile_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_memory_embeddings_item_model" ON "user_memory_embeddings" USING btree ("memory_item_id","embedding_model");--> statement-breakpoint
CREATE INDEX "idx_user_memory_embeddings_user" ON "user_memory_embeddings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_memory_embeddings_vector" ON "user_memory_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists=100);--> statement-breakpoint
CREATE INDEX "idx_user_memory_items_user_status_updated" ON "user_memory_items" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_user_memory_items_user_type_status" ON "user_memory_items" USING btree ("user_id","memory_type","status");--> statement-breakpoint
CREATE INDEX "idx_user_memory_items_source_message" ON "user_memory_items" USING btree ("source_message_id");