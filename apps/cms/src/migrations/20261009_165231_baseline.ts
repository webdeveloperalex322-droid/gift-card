import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_cards_meta_conflict_conflicts_field" AS ENUM('title', 'metaDescription');
  CREATE TYPE "public"."enum_cards_meta_conflict_conflicts_document_collection" AS ENUM('cards', 'collections');
  CREATE TYPE "public"."enum_cards_derivative_variants_format" AS ENUM('avif', 'webp', 'jpeg');
  CREATE TYPE "public"."enum_cards_status" AS ENUM('draft', 'review', 'published');
  CREATE TYPE "public"."enum_cards_robots" AS ENUM('index,follow', 'noindex,follow', 'noindex,nofollow');
  CREATE TYPE "public"."enum_cards_withdrawal_mode" AS ENUM('301', '410', '404');
  CREATE TYPE "public"."enum_cards_visual_duplicate_decision" AS ENUM('unique', 'duplicate');
  CREATE TYPE "public"."enum_collections_meta_conflict_conflicts_field" AS ENUM('title', 'metaDescription');
  CREATE TYPE "public"."enum_collections_meta_conflict_conflicts_document_collection" AS ENUM('cards', 'collections');
  CREATE TYPE "public"."enum_collections_node_kind" AS ENUM('group', 'occasion', 'recipient');
  CREATE TYPE "public"."enum_collections_status" AS ENUM('draft', 'review', 'published');
  CREATE TYPE "public"."enum_collections_robots" AS ENUM('index,follow', 'noindex,follow', 'noindex,nofollow');
  CREATE TYPE "public"."enum_collections_withdrawal_mode" AS ENUM('301', '410', '404');
  CREATE TYPE "public"."enum_card_images_variants_format" AS ENUM('avif', 'webp', 'jpeg');
  CREATE TYPE "public"."enum_redirects_code" AS ENUM('301', '410');
  CREATE TYPE "public"."enum_seo_history_document_collection" AS ENUM('cards', 'collections');
  CREATE TYPE "public"."enum_seo_history_field" AS ENUM('title', 'h1', 'metaDescription', 'slug', 'path', 'canonical', 'robots', 'status');
  CREATE TYPE "public"."enum_seo_history_operation" AS ENUM('create', 'update');
  CREATE TYPE "public"."enum_seo_history_author_role" AS ENUM('admin', 'ai-editor', 'system', 'unknown');
  CREATE TYPE "public"."enum_content_path_claims_owner_collection" AS ENUM('cards', 'collections');
  CREATE TYPE "public"."enum_users_role" AS ENUM('admin', 'ai-editor');
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'seo-link-audit');
  CREATE TYPE "public"."enum_payload_jobs_log_state" AS ENUM('failed', 'succeeded');
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'seo-link-audit');
  CREATE TYPE "public"."enum_site_settings_ad_slots_position" AS ENUM('under-h1', 'after-pagination');
  CREATE TYPE "public"."enum_site_settings_image_license_creator_kind" AS ENUM('Organization', 'Person');
  CREATE TYPE "public"."enum_site_settings_audit_author_role" AS ENUM('admin', 'ai-editor', 'system', 'unknown');
  CREATE TYPE "public"."enum__site_settings_v_version_ad_slots_position" AS ENUM('under-h1', 'after-pagination');
  CREATE TYPE "public"."enum__site_settings_v_version_image_license_creator_kind" AS ENUM('Organization', 'Person');
  CREATE TYPE "public"."enum__site_settings_v_version_audit_author_role" AS ENUM('admin', 'ai-editor', 'system', 'unknown');
  CREATE TYPE "public"."enum_seo_link_audit_records_reason" AS ENUM('not-linked', 'too-deep', 'not-200', 'no-response', 'not-measured');
  CREATE TYPE "public"."enum_seo_link_audit_records_document_collection" AS ENUM('cards', 'collections');
  CREATE TYPE "public"."enum_seo_link_audit_links_kind" AS ENUM('broken', 'redirected');
  CREATE TYPE "public"."enum__seo_link_audit_v_version_records_reason" AS ENUM('not-linked', 'too-deep', 'not-200', 'no-response', 'not-measured');
  CREATE TYPE "public"."enum__seo_link_audit_v_version_records_document_collection" AS ENUM('cards', 'collections');
  CREATE TYPE "public"."enum__seo_link_audit_v_version_links_kind" AS ENUM('broken', 'redirected');
  CREATE TABLE "cards_meta_conflict_conflicts" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"field" "enum_cards_meta_conflict_conflicts_field",
  	"document_collection" "enum_cards_meta_conflict_conflicts_document_collection",
  	"document_id" varchar,
  	"path" varchar,
  	"status" varchar,
  	"title" varchar
  );
  
  CREATE TABLE "cards_visual_duplicate_similar" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"card_id" integer,
  	"distance" numeric
  );
  
  CREATE TABLE "cards_derivative_variants" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"format" "enum_cards_derivative_variants_format" NOT NULL,
  	"width" numeric NOT NULL,
  	"height" numeric NOT NULL
  );
  
  CREATE TABLE "cards" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"pilot_import_key" varchar,
  	"source_import_key" varchar,
  	"title" varchar NOT NULL,
  	"h1" varchar,
  	"slug" varchar NOT NULL,
  	"path_claim_key" varchar,
  	"image_id" integer,
  	"alt" varchar,
  	"caption" varchar,
  	"description" varchar,
  	"meta_description" varchar,
  	"usage_terms" varchar,
  	"status" "enum_cards_status" DEFAULT 'draft' NOT NULL,
  	"robots" "enum_cards_robots" DEFAULT 'noindex,follow' NOT NULL,
  	"canonical" varchar,
  	"published_at" timestamp(3) with time zone,
  	"updated_content_at" timestamp(3) with time zone,
  	"withdrawal_mode" "enum_cards_withdrawal_mode",
  	"withdrawal_redirect_to" varchar,
  	"url_change_confirm" boolean DEFAULT false,
  	"url_change_reason" varchar,
  	"title_key" varchar,
  	"meta_description_key" varchar,
  	"meta_conflict_total" numeric,
  	"meta_conflict_truncated" boolean DEFAULT false,
  	"meta_conflict_checked_at" timestamp(3) with time zone,
  	"meta_conflict_confirm" boolean DEFAULT false,
  	"meta_conflict_confirmed_for" varchar,
  	"meta_conflict_confirmed_at" timestamp(3) with time zone,
  	"meta_conflict_confirmed_by_id" integer,
  	"visual_duplicate_decision" "enum_cards_visual_duplicate_decision",
  	"visual_duplicate_confirm" boolean DEFAULT false,
  	"visual_duplicate_decision_for" varchar,
  	"visual_duplicate_decided_at" timestamp(3) with time zone,
  	"visual_duplicate_decided_by_id" integer,
  	"visual_duplicate_scanned" numeric,
  	"visual_duplicate_scan_truncated" boolean DEFAULT false,
  	"p_hash" varchar,
  	"derivative_key_base" varchar,
  	"derivative_name_stem" varchar,
  	"derivative_name_suffix" numeric,
  	"derivative_revision" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "cards_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"collections_id" integer
  );
  
  CREATE TABLE "collections_meta_conflict_conflicts" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"field" "enum_collections_meta_conflict_conflicts_field",
  	"document_collection" "enum_collections_meta_conflict_conflicts_document_collection",
  	"document_id" varchar,
  	"path" varchar,
  	"status" varchar,
  	"title" varchar
  );
  
  CREATE TABLE "collections" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"pilot_import_key" varchar,
  	"source_import_key" varchar,
  	"title" varchar NOT NULL,
  	"h1" varchar,
  	"slug" varchar NOT NULL,
  	"path" varchar,
  	"path_claim_key" varchar,
  	"node_kind" "enum_collections_node_kind" NOT NULL,
  	"parent_id" integer,
  	"description" varchar,
  	"intro" jsonb,
  	"meta_description" varchar,
  	"status" "enum_collections_status" DEFAULT 'draft' NOT NULL,
  	"robots" "enum_collections_robots" DEFAULT 'noindex,follow' NOT NULL,
  	"canonical" varchar,
  	"published_at" timestamp(3) with time zone,
  	"updated_content_at" timestamp(3) with time zone,
  	"withdrawal_mode" "enum_collections_withdrawal_mode",
  	"withdrawal_redirect_to" varchar,
  	"url_change_confirm" boolean DEFAULT false,
  	"url_change_reason" varchar,
  	"title_key" varchar,
  	"meta_description_key" varchar,
  	"meta_conflict_total" numeric,
  	"meta_conflict_truncated" boolean DEFAULT false,
  	"meta_conflict_checked_at" timestamp(3) with time zone,
  	"meta_conflict_confirm" boolean DEFAULT false,
  	"meta_conflict_confirmed_for" varchar,
  	"meta_conflict_confirmed_at" timestamp(3) with time zone,
  	"meta_conflict_confirmed_by_id" integer,
  	"responsible_editor_id" integer,
  	"seasonal_holiday_date" timestamp(3) with time zone,
  	"seasonal_ready_by" timestamp(3) with time zone,
  	"seasonal_show_from" timestamp(3) with time zone,
  	"seasonal_show_until" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "collections_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"collections_id" integer
  );
  
  CREATE TABLE "card_images_variants" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"format" "enum_card_images_variants_format" NOT NULL,
  	"width" numeric NOT NULL,
  	"height" numeric NOT NULL,
  	"byte_size" numeric NOT NULL
  );
  
  CREATE TABLE "card_images" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"pilot_import_key" varchar,
  	"source_import_key" varchar,
  	"title" varchar NOT NULL,
  	"p_hash" varchar,
  	"name_stem" varchar,
  	"name_suffix" numeric,
  	"revision" varchar,
  	"key_base" varchar,
  	"storage_id" varchar,
  	"original_key" varchar,
  	"source_width" numeric,
  	"source_height" numeric,
  	"source_format" varchar,
  	"source_exif_orientation" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric
  );
  
  CREATE TABLE "redirects" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"from" varchar NOT NULL,
  	"to" varchar,
  	"code" "enum_redirects_code" DEFAULT '301' NOT NULL,
  	"created_by_id" integer,
  	"comment" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "seo_history" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"document_collection" "enum_seo_history_document_collection" NOT NULL,
  	"document_id" varchar NOT NULL,
  	"document_path" varchar,
  	"field" "enum_seo_history_field" NOT NULL,
  	"previous_value" varchar,
  	"next_value" varchar,
  	"operation" "enum_seo_history_operation" NOT NULL,
  	"author_role" "enum_seo_history_author_role" NOT NULL,
  	"changed_by_id" integer,
  	"via_api_key" boolean DEFAULT false,
  	"changed_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "content_path_claims" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"path" varchar NOT NULL,
  	"owner_collection" "enum_content_path_claims_owner_collection" NOT NULL,
  	"owner_key" varchar NOT NULL,
  	"claimed_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "image_name_claims" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"stem" varchar NOT NULL,
  	"suffix" numeric,
  	"description" varchar,
  	"claimed_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "users_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "users" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"role" "enum_users_role" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"enable_a_p_i_key" boolean,
  	"api_key" varchar,
  	"api_key_index" varchar,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "payload_kv" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload_jobs_log" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"executed_at" timestamp(3) with time zone NOT NULL,
  	"completed_at" timestamp(3) with time zone NOT NULL,
  	"task_slug" "enum_payload_jobs_log_task_slug" NOT NULL,
  	"task_i_d" varchar NOT NULL,
  	"input" jsonb,
  	"output" jsonb,
  	"state" "enum_payload_jobs_log_state" NOT NULL,
  	"error" jsonb
  );
  
  CREATE TABLE "payload_jobs" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"input" jsonb,
  	"completed_at" timestamp(3) with time zone,
  	"total_tried" numeric DEFAULT 0,
  	"has_error" boolean DEFAULT false,
  	"error" jsonb,
  	"task_slug" "enum_payload_jobs_task_slug",
  	"queue" varchar DEFAULT 'default',
  	"wait_until" timestamp(3) with time zone,
  	"processing" boolean DEFAULT false,
  	"meta" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"cards_id" integer,
  	"collections_id" integer,
  	"card_images_id" integer,
  	"redirects_id" integer,
  	"seo_history_id" integer,
  	"content_path_claims_id" integer,
  	"image_name_claims_id" integer,
  	"users_id" integer
  );
  
  CREATE TABLE "payload_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "payload_migrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_settings_organization_same_as" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"url" varchar NOT NULL
  );
  
  CREATE TABLE "site_settings_ad_slots" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"position" "enum_site_settings_ad_slots_position" NOT NULL,
  	"width" numeric,
  	"height" numeric,
  	"enabled" boolean DEFAULT false
  );
  
  CREATE TABLE "site_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_name" varchar,
  	"organization_legal_name" varchar,
  	"organization_logo" varchar,
  	"organization_email" varchar,
  	"organization_telephone" varchar,
  	"image_license_creator" varchar,
  	"image_license_creator_kind" "enum_site_settings_image_license_creator_kind",
  	"image_license_credit_text" varchar,
  	"image_license_copyright_notice" varchar,
  	"image_license_license" varchar,
  	"image_license_acquire_license_page" varchar,
  	"image_license_ai_disclosure" varchar,
  	"info_pages_about_allow_indexing" boolean DEFAULT false,
  	"info_pages_about_title" varchar,
  	"info_pages_about_h1" varchar,
  	"info_pages_about_meta_description" varchar,
  	"info_pages_about_body" jsonb,
  	"info_pages_terms_allow_indexing" boolean DEFAULT false,
  	"info_pages_terms_title" varchar,
  	"info_pages_terms_h1" varchar,
  	"info_pages_terms_meta_description" varchar,
  	"info_pages_terms_body" jsonb,
  	"info_pages_contacts_allow_indexing" boolean DEFAULT false,
  	"info_pages_contacts_title" varchar,
  	"info_pages_contacts_h1" varchar,
  	"info_pages_contacts_meta_description" varchar,
  	"info_pages_contacts_body" jsonb,
  	"counters_enabled" boolean DEFAULT false,
  	"counters_code" varchar,
  	"audit_changed_at" timestamp(3) with time zone,
  	"audit_author_role" "enum_site_settings_audit_author_role",
  	"audit_changed_by_id" integer,
  	"audit_via_api_key" boolean,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "_site_settings_v_version_organization_same_as" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"url" varchar NOT NULL,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_site_settings_v_version_ad_slots" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"position" "enum__site_settings_v_version_ad_slots_position" NOT NULL,
  	"width" numeric,
  	"height" numeric,
  	"enabled" boolean DEFAULT false,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_site_settings_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"version_organization_name" varchar,
  	"version_organization_legal_name" varchar,
  	"version_organization_logo" varchar,
  	"version_organization_email" varchar,
  	"version_organization_telephone" varchar,
  	"version_image_license_creator" varchar,
  	"version_image_license_creator_kind" "enum__site_settings_v_version_image_license_creator_kind",
  	"version_image_license_credit_text" varchar,
  	"version_image_license_copyright_notice" varchar,
  	"version_image_license_license" varchar,
  	"version_image_license_acquire_license_page" varchar,
  	"version_image_license_ai_disclosure" varchar,
  	"version_info_pages_about_allow_indexing" boolean DEFAULT false,
  	"version_info_pages_about_title" varchar,
  	"version_info_pages_about_h1" varchar,
  	"version_info_pages_about_meta_description" varchar,
  	"version_info_pages_about_body" jsonb,
  	"version_info_pages_terms_allow_indexing" boolean DEFAULT false,
  	"version_info_pages_terms_title" varchar,
  	"version_info_pages_terms_h1" varchar,
  	"version_info_pages_terms_meta_description" varchar,
  	"version_info_pages_terms_body" jsonb,
  	"version_info_pages_contacts_allow_indexing" boolean DEFAULT false,
  	"version_info_pages_contacts_title" varchar,
  	"version_info_pages_contacts_h1" varchar,
  	"version_info_pages_contacts_meta_description" varchar,
  	"version_info_pages_contacts_body" jsonb,
  	"version_counters_enabled" boolean DEFAULT false,
  	"version_counters_code" varchar,
  	"version_audit_changed_at" timestamp(3) with time zone,
  	"version_audit_author_role" "enum__site_settings_v_version_audit_author_role",
  	"version_audit_changed_by_id" integer,
  	"version_audit_via_api_key" boolean,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "seo_link_audit_records" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"url" varchar,
  	"reason" "enum_seo_link_audit_records_reason",
  	"document_collection" "enum_seo_link_audit_records_document_collection",
  	"document_id" varchar,
  	"title" varchar,
  	"depth" numeric,
  	"in_sitemap" varchar
  );
  
  CREATE TABLE "seo_link_audit_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"url" varchar,
  	"kind" "enum_seo_link_audit_links_kind",
  	"status" numeric,
  	"location" varchar,
  	"referrers" varchar
  );
  
  CREATE TABLE "seo_link_audit_warnings" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "seo_link_audit" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"started_at" timestamp(3) with time zone,
  	"finished_at" timestamp(3) with time zone,
  	"origin" varchar,
  	"reliable" boolean DEFAULT false,
  	"crawl_requested" numeric,
  	"crawl_truncated" boolean DEFAULT false,
  	"counts_published_records" numeric,
  	"counts_orphans" numeric,
  	"counts_broken" numeric,
  	"counts_redirected" numeric,
  	"counts_unhealthy" numeric,
  	"counts_not_measured" numeric,
  	"sitemap_index_status" numeric,
  	"sitemap_urls" numeric,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "_seo_link_audit_v_version_records" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"url" varchar,
  	"reason" "enum__seo_link_audit_v_version_records_reason",
  	"document_collection" "enum__seo_link_audit_v_version_records_document_collection",
  	"document_id" varchar,
  	"title" varchar,
  	"depth" numeric,
  	"in_sitemap" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_seo_link_audit_v_version_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"url" varchar,
  	"kind" "enum__seo_link_audit_v_version_links_kind",
  	"status" numeric,
  	"location" varchar,
  	"referrers" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_seo_link_audit_v_version_warnings" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"text" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_seo_link_audit_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"version_started_at" timestamp(3) with time zone,
  	"version_finished_at" timestamp(3) with time zone,
  	"version_origin" varchar,
  	"version_reliable" boolean DEFAULT false,
  	"version_crawl_requested" numeric,
  	"version_crawl_truncated" boolean DEFAULT false,
  	"version_counts_published_records" numeric,
  	"version_counts_orphans" numeric,
  	"version_counts_broken" numeric,
  	"version_counts_redirected" numeric,
  	"version_counts_unhealthy" numeric,
  	"version_counts_not_measured" numeric,
  	"version_sitemap_index_status" numeric,
  	"version_sitemap_urls" numeric,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_jobs_stats" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"stats" jsonb,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "cards_meta_conflict_conflicts" ADD CONSTRAINT "cards_meta_conflict_conflicts_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cards_visual_duplicate_similar" ADD CONSTRAINT "cards_visual_duplicate_similar_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cards_visual_duplicate_similar" ADD CONSTRAINT "cards_visual_duplicate_similar_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cards_derivative_variants" ADD CONSTRAINT "cards_derivative_variants_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cards" ADD CONSTRAINT "cards_image_id_card_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."card_images"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cards" ADD CONSTRAINT "cards_meta_conflict_confirmed_by_id_users_id_fk" FOREIGN KEY ("meta_conflict_confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cards" ADD CONSTRAINT "cards_visual_duplicate_decided_by_id_users_id_fk" FOREIGN KEY ("visual_duplicate_decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cards_rels" ADD CONSTRAINT "cards_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cards_rels" ADD CONSTRAINT "cards_rels_collections_fk" FOREIGN KEY ("collections_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "collections_meta_conflict_conflicts" ADD CONSTRAINT "collections_meta_conflict_conflicts_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "collections" ADD CONSTRAINT "collections_parent_id_collections_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "collections" ADD CONSTRAINT "collections_meta_conflict_confirmed_by_id_users_id_fk" FOREIGN KEY ("meta_conflict_confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "collections" ADD CONSTRAINT "collections_responsible_editor_id_users_id_fk" FOREIGN KEY ("responsible_editor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "collections_rels" ADD CONSTRAINT "collections_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "collections_rels" ADD CONSTRAINT "collections_rels_collections_fk" FOREIGN KEY ("collections_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "card_images_variants" ADD CONSTRAINT "card_images_variants_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."card_images"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "redirects" ADD CONSTRAINT "redirects_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "seo_history" ADD CONSTRAINT "seo_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_jobs_log" ADD CONSTRAINT "payload_jobs_log_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."payload_jobs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cards_fk" FOREIGN KEY ("cards_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_collections_fk" FOREIGN KEY ("collections_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_card_images_fk" FOREIGN KEY ("card_images_id") REFERENCES "public"."card_images"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_redirects_fk" FOREIGN KEY ("redirects_id") REFERENCES "public"."redirects"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_seo_history_fk" FOREIGN KEY ("seo_history_id") REFERENCES "public"."seo_history"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_content_path_claims_fk" FOREIGN KEY ("content_path_claims_id") REFERENCES "public"."content_path_claims"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_image_name_claims_fk" FOREIGN KEY ("image_name_claims_id") REFERENCES "public"."image_name_claims"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_settings_organization_same_as" ADD CONSTRAINT "site_settings_organization_same_as_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_settings_ad_slots" ADD CONSTRAINT "site_settings_ad_slots_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_audit_changed_by_id_users_id_fk" FOREIGN KEY ("audit_changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_site_settings_v_version_organization_same_as" ADD CONSTRAINT "_site_settings_v_version_organization_same_as_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_settings_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_settings_v_version_ad_slots" ADD CONSTRAINT "_site_settings_v_version_ad_slots_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_settings_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_settings_v" ADD CONSTRAINT "_site_settings_v_version_audit_changed_by_id_users_id_fk" FOREIGN KEY ("version_audit_changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "seo_link_audit_records" ADD CONSTRAINT "seo_link_audit_records_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."seo_link_audit"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "seo_link_audit_links" ADD CONSTRAINT "seo_link_audit_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."seo_link_audit"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "seo_link_audit_warnings" ADD CONSTRAINT "seo_link_audit_warnings_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."seo_link_audit"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_seo_link_audit_v_version_records" ADD CONSTRAINT "_seo_link_audit_v_version_records_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_seo_link_audit_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_seo_link_audit_v_version_links" ADD CONSTRAINT "_seo_link_audit_v_version_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_seo_link_audit_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_seo_link_audit_v_version_warnings" ADD CONSTRAINT "_seo_link_audit_v_version_warnings_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_seo_link_audit_v"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "cards_meta_conflict_conflicts_order_idx" ON "cards_meta_conflict_conflicts" USING btree ("_order");
  CREATE INDEX "cards_meta_conflict_conflicts_parent_id_idx" ON "cards_meta_conflict_conflicts" USING btree ("_parent_id");
  CREATE INDEX "cards_visual_duplicate_similar_order_idx" ON "cards_visual_duplicate_similar" USING btree ("_order");
  CREATE INDEX "cards_visual_duplicate_similar_parent_id_idx" ON "cards_visual_duplicate_similar" USING btree ("_parent_id");
  CREATE INDEX "cards_visual_duplicate_similar_card_idx" ON "cards_visual_duplicate_similar" USING btree ("card_id");
  CREATE INDEX "cards_derivative_variants_order_idx" ON "cards_derivative_variants" USING btree ("_order");
  CREATE INDEX "cards_derivative_variants_parent_id_idx" ON "cards_derivative_variants" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "cards_pilot_import_key_idx" ON "cards" USING btree ("pilot_import_key");
  CREATE UNIQUE INDEX "cards_source_import_key_idx" ON "cards" USING btree ("source_import_key");
  CREATE UNIQUE INDEX "cards_slug_idx" ON "cards" USING btree ("slug");
  CREATE INDEX "cards_image_idx" ON "cards" USING btree ("image_id");
  CREATE INDEX "cards_status_idx" ON "cards" USING btree ("status");
  CREATE INDEX "cards_published_at_idx" ON "cards" USING btree ("published_at");
  CREATE INDEX "cards_title_key_idx" ON "cards" USING btree ("title_key");
  CREATE INDEX "cards_meta_description_key_idx" ON "cards" USING btree ("meta_description_key");
  CREATE INDEX "cards_meta_conflict_meta_conflict_confirmed_by_idx" ON "cards" USING btree ("meta_conflict_confirmed_by_id");
  CREATE INDEX "cards_visual_duplicate_visual_duplicate_decided_by_idx" ON "cards" USING btree ("visual_duplicate_decided_by_id");
  CREATE INDEX "cards_p_hash_idx" ON "cards" USING btree ("p_hash");
  CREATE INDEX "cards_updated_at_idx" ON "cards" USING btree ("updated_at");
  CREATE INDEX "cards_created_at_idx" ON "cards" USING btree ("created_at");
  CREATE INDEX "cards_rels_order_idx" ON "cards_rels" USING btree ("order");
  CREATE INDEX "cards_rels_parent_idx" ON "cards_rels" USING btree ("parent_id");
  CREATE INDEX "cards_rels_path_idx" ON "cards_rels" USING btree ("path");
  CREATE INDEX "cards_rels_collections_id_idx" ON "cards_rels" USING btree ("collections_id");
  CREATE INDEX "collections_meta_conflict_conflicts_order_idx" ON "collections_meta_conflict_conflicts" USING btree ("_order");
  CREATE INDEX "collections_meta_conflict_conflicts_parent_id_idx" ON "collections_meta_conflict_conflicts" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "collections_pilot_import_key_idx" ON "collections" USING btree ("pilot_import_key");
  CREATE UNIQUE INDEX "collections_source_import_key_idx" ON "collections" USING btree ("source_import_key");
  CREATE INDEX "collections_slug_idx" ON "collections" USING btree ("slug");
  CREATE UNIQUE INDEX "collections_path_idx" ON "collections" USING btree ("path");
  CREATE INDEX "collections_node_kind_idx" ON "collections" USING btree ("node_kind");
  CREATE INDEX "collections_parent_idx" ON "collections" USING btree ("parent_id");
  CREATE INDEX "collections_status_idx" ON "collections" USING btree ("status");
  CREATE INDEX "collections_published_at_idx" ON "collections" USING btree ("published_at");
  CREATE INDEX "collections_title_key_idx" ON "collections" USING btree ("title_key");
  CREATE INDEX "collections_meta_description_key_idx" ON "collections" USING btree ("meta_description_key");
  CREATE INDEX "collections_meta_conflict_meta_conflict_confirmed_by_idx" ON "collections" USING btree ("meta_conflict_confirmed_by_id");
  CREATE INDEX "collections_responsible_editor_idx" ON "collections" USING btree ("responsible_editor_id");
  CREATE INDEX "collections_updated_at_idx" ON "collections" USING btree ("updated_at");
  CREATE INDEX "collections_created_at_idx" ON "collections" USING btree ("created_at");
  CREATE INDEX "collections_rels_order_idx" ON "collections_rels" USING btree ("order");
  CREATE INDEX "collections_rels_parent_idx" ON "collections_rels" USING btree ("parent_id");
  CREATE INDEX "collections_rels_path_idx" ON "collections_rels" USING btree ("path");
  CREATE INDEX "collections_rels_collections_id_idx" ON "collections_rels" USING btree ("collections_id");
  CREATE INDEX "card_images_variants_order_idx" ON "card_images_variants" USING btree ("_order");
  CREATE INDEX "card_images_variants_parent_id_idx" ON "card_images_variants" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "card_images_pilot_import_key_idx" ON "card_images" USING btree ("pilot_import_key");
  CREATE UNIQUE INDEX "card_images_source_import_key_idx" ON "card_images" USING btree ("source_import_key");
  CREATE INDEX "card_images_p_hash_idx" ON "card_images" USING btree ("p_hash");
  CREATE UNIQUE INDEX "card_images_name_stem_idx" ON "card_images" USING btree ("name_stem");
  CREATE UNIQUE INDEX "card_images_storage_id_idx" ON "card_images" USING btree ("storage_id");
  CREATE INDEX "card_images_updated_at_idx" ON "card_images" USING btree ("updated_at");
  CREATE INDEX "card_images_created_at_idx" ON "card_images" USING btree ("created_at");
  CREATE UNIQUE INDEX "card_images_filename_idx" ON "card_images" USING btree ("filename");
  CREATE UNIQUE INDEX "redirects_from_idx" ON "redirects" USING btree ("from");
  CREATE INDEX "redirects_created_by_idx" ON "redirects" USING btree ("created_by_id");
  CREATE INDEX "redirects_updated_at_idx" ON "redirects" USING btree ("updated_at");
  CREATE INDEX "redirects_created_at_idx" ON "redirects" USING btree ("created_at");
  CREATE INDEX "seo_history_document_collection_idx" ON "seo_history" USING btree ("document_collection");
  CREATE INDEX "seo_history_document_id_idx" ON "seo_history" USING btree ("document_id");
  CREATE INDEX "seo_history_document_path_idx" ON "seo_history" USING btree ("document_path");
  CREATE INDEX "seo_history_field_idx" ON "seo_history" USING btree ("field");
  CREATE INDEX "seo_history_author_role_idx" ON "seo_history" USING btree ("author_role");
  CREATE INDEX "seo_history_changed_by_idx" ON "seo_history" USING btree ("changed_by_id");
  CREATE INDEX "seo_history_changed_at_idx" ON "seo_history" USING btree ("changed_at");
  CREATE INDEX "seo_history_updated_at_idx" ON "seo_history" USING btree ("updated_at");
  CREATE INDEX "seo_history_created_at_idx" ON "seo_history" USING btree ("created_at");
  CREATE UNIQUE INDEX "content_path_claims_path_idx" ON "content_path_claims" USING btree ("path");
  CREATE INDEX "content_path_claims_owner_key_idx" ON "content_path_claims" USING btree ("owner_key");
  CREATE INDEX "content_path_claims_updated_at_idx" ON "content_path_claims" USING btree ("updated_at");
  CREATE INDEX "content_path_claims_created_at_idx" ON "content_path_claims" USING btree ("created_at");
  CREATE UNIQUE INDEX "image_name_claims_stem_idx" ON "image_name_claims" USING btree ("stem");
  CREATE INDEX "image_name_claims_updated_at_idx" ON "image_name_claims" USING btree ("updated_at");
  CREATE INDEX "image_name_claims_created_at_idx" ON "image_name_claims" USING btree ("created_at");
  CREATE INDEX "users_sessions_order_idx" ON "users_sessions" USING btree ("_order");
  CREATE INDEX "users_sessions_parent_id_idx" ON "users_sessions" USING btree ("_parent_id");
  CREATE INDEX "users_updated_at_idx" ON "users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");
  CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_jobs_log_order_idx" ON "payload_jobs_log" USING btree ("_order");
  CREATE INDEX "payload_jobs_log_parent_id_idx" ON "payload_jobs_log" USING btree ("_parent_id");
  CREATE INDEX "payload_jobs_completed_at_idx" ON "payload_jobs" USING btree ("completed_at");
  CREATE INDEX "payload_jobs_total_tried_idx" ON "payload_jobs" USING btree ("total_tried");
  CREATE INDEX "payload_jobs_has_error_idx" ON "payload_jobs" USING btree ("has_error");
  CREATE INDEX "payload_jobs_task_slug_idx" ON "payload_jobs" USING btree ("task_slug");
  CREATE INDEX "payload_jobs_queue_idx" ON "payload_jobs" USING btree ("queue");
  CREATE INDEX "payload_jobs_wait_until_idx" ON "payload_jobs" USING btree ("wait_until");
  CREATE INDEX "payload_jobs_processing_idx" ON "payload_jobs" USING btree ("processing");
  CREATE INDEX "payload_jobs_updated_at_idx" ON "payload_jobs" USING btree ("updated_at");
  CREATE INDEX "payload_jobs_created_at_idx" ON "payload_jobs" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_cards_id_idx" ON "payload_locked_documents_rels" USING btree ("cards_id");
  CREATE INDEX "payload_locked_documents_rels_collections_id_idx" ON "payload_locked_documents_rels" USING btree ("collections_id");
  CREATE INDEX "payload_locked_documents_rels_card_images_id_idx" ON "payload_locked_documents_rels" USING btree ("card_images_id");
  CREATE INDEX "payload_locked_documents_rels_redirects_id_idx" ON "payload_locked_documents_rels" USING btree ("redirects_id");
  CREATE INDEX "payload_locked_documents_rels_seo_history_id_idx" ON "payload_locked_documents_rels" USING btree ("seo_history_id");
  CREATE INDEX "payload_locked_documents_rels_content_path_claims_id_idx" ON "payload_locked_documents_rels" USING btree ("content_path_claims_id");
  CREATE INDEX "payload_locked_documents_rels_image_name_claims_id_idx" ON "payload_locked_documents_rels" USING btree ("image_name_claims_id");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");
  CREATE INDEX "site_settings_organization_same_as_order_idx" ON "site_settings_organization_same_as" USING btree ("_order");
  CREATE INDEX "site_settings_organization_same_as_parent_id_idx" ON "site_settings_organization_same_as" USING btree ("_parent_id");
  CREATE INDEX "site_settings_ad_slots_order_idx" ON "site_settings_ad_slots" USING btree ("_order");
  CREATE INDEX "site_settings_ad_slots_parent_id_idx" ON "site_settings_ad_slots" USING btree ("_parent_id");
  CREATE INDEX "site_settings_audit_audit_changed_by_idx" ON "site_settings" USING btree ("audit_changed_by_id");
  CREATE INDEX "_site_settings_v_version_organization_same_as_order_idx" ON "_site_settings_v_version_organization_same_as" USING btree ("_order");
  CREATE INDEX "_site_settings_v_version_organization_same_as_parent_id_idx" ON "_site_settings_v_version_organization_same_as" USING btree ("_parent_id");
  CREATE INDEX "_site_settings_v_version_ad_slots_order_idx" ON "_site_settings_v_version_ad_slots" USING btree ("_order");
  CREATE INDEX "_site_settings_v_version_ad_slots_parent_id_idx" ON "_site_settings_v_version_ad_slots" USING btree ("_parent_id");
  CREATE INDEX "_site_settings_v_version_audit_version_audit_changed_by_idx" ON "_site_settings_v" USING btree ("version_audit_changed_by_id");
  CREATE INDEX "_site_settings_v_created_at_idx" ON "_site_settings_v" USING btree ("created_at");
  CREATE INDEX "_site_settings_v_updated_at_idx" ON "_site_settings_v" USING btree ("updated_at");
  CREATE INDEX "seo_link_audit_records_order_idx" ON "seo_link_audit_records" USING btree ("_order");
  CREATE INDEX "seo_link_audit_records_parent_id_idx" ON "seo_link_audit_records" USING btree ("_parent_id");
  CREATE INDEX "seo_link_audit_links_order_idx" ON "seo_link_audit_links" USING btree ("_order");
  CREATE INDEX "seo_link_audit_links_parent_id_idx" ON "seo_link_audit_links" USING btree ("_parent_id");
  CREATE INDEX "seo_link_audit_warnings_order_idx" ON "seo_link_audit_warnings" USING btree ("_order");
  CREATE INDEX "seo_link_audit_warnings_parent_id_idx" ON "seo_link_audit_warnings" USING btree ("_parent_id");
  CREATE INDEX "_seo_link_audit_v_version_records_order_idx" ON "_seo_link_audit_v_version_records" USING btree ("_order");
  CREATE INDEX "_seo_link_audit_v_version_records_parent_id_idx" ON "_seo_link_audit_v_version_records" USING btree ("_parent_id");
  CREATE INDEX "_seo_link_audit_v_version_links_order_idx" ON "_seo_link_audit_v_version_links" USING btree ("_order");
  CREATE INDEX "_seo_link_audit_v_version_links_parent_id_idx" ON "_seo_link_audit_v_version_links" USING btree ("_parent_id");
  CREATE INDEX "_seo_link_audit_v_version_warnings_order_idx" ON "_seo_link_audit_v_version_warnings" USING btree ("_order");
  CREATE INDEX "_seo_link_audit_v_version_warnings_parent_id_idx" ON "_seo_link_audit_v_version_warnings" USING btree ("_parent_id");
  CREATE INDEX "_seo_link_audit_v_created_at_idx" ON "_seo_link_audit_v" USING btree ("created_at");
  CREATE INDEX "_seo_link_audit_v_updated_at_idx" ON "_seo_link_audit_v" USING btree ("updated_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "cards_meta_conflict_conflicts" CASCADE;
  DROP TABLE "cards_visual_duplicate_similar" CASCADE;
  DROP TABLE "cards_derivative_variants" CASCADE;
  DROP TABLE "cards" CASCADE;
  DROP TABLE "cards_rels" CASCADE;
  DROP TABLE "collections_meta_conflict_conflicts" CASCADE;
  DROP TABLE "collections" CASCADE;
  DROP TABLE "collections_rels" CASCADE;
  DROP TABLE "card_images_variants" CASCADE;
  DROP TABLE "card_images" CASCADE;
  DROP TABLE "redirects" CASCADE;
  DROP TABLE "seo_history" CASCADE;
  DROP TABLE "content_path_claims" CASCADE;
  DROP TABLE "image_name_claims" CASCADE;
  DROP TABLE "users_sessions" CASCADE;
  DROP TABLE "users" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_jobs_log" CASCADE;
  DROP TABLE "payload_jobs" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TABLE "site_settings_organization_same_as" CASCADE;
  DROP TABLE "site_settings_ad_slots" CASCADE;
  DROP TABLE "site_settings" CASCADE;
  DROP TABLE "_site_settings_v_version_organization_same_as" CASCADE;
  DROP TABLE "_site_settings_v_version_ad_slots" CASCADE;
  DROP TABLE "_site_settings_v" CASCADE;
  DROP TABLE "seo_link_audit_records" CASCADE;
  DROP TABLE "seo_link_audit_links" CASCADE;
  DROP TABLE "seo_link_audit_warnings" CASCADE;
  DROP TABLE "seo_link_audit" CASCADE;
  DROP TABLE "_seo_link_audit_v_version_records" CASCADE;
  DROP TABLE "_seo_link_audit_v_version_links" CASCADE;
  DROP TABLE "_seo_link_audit_v_version_warnings" CASCADE;
  DROP TABLE "_seo_link_audit_v" CASCADE;
  DROP TABLE "payload_jobs_stats" CASCADE;
  DROP TYPE "public"."enum_cards_meta_conflict_conflicts_field";
  DROP TYPE "public"."enum_cards_meta_conflict_conflicts_document_collection";
  DROP TYPE "public"."enum_cards_derivative_variants_format";
  DROP TYPE "public"."enum_cards_status";
  DROP TYPE "public"."enum_cards_robots";
  DROP TYPE "public"."enum_cards_withdrawal_mode";
  DROP TYPE "public"."enum_cards_visual_duplicate_decision";
  DROP TYPE "public"."enum_collections_meta_conflict_conflicts_field";
  DROP TYPE "public"."enum_collections_meta_conflict_conflicts_document_collection";
  DROP TYPE "public"."enum_collections_node_kind";
  DROP TYPE "public"."enum_collections_status";
  DROP TYPE "public"."enum_collections_robots";
  DROP TYPE "public"."enum_collections_withdrawal_mode";
  DROP TYPE "public"."enum_card_images_variants_format";
  DROP TYPE "public"."enum_redirects_code";
  DROP TYPE "public"."enum_seo_history_document_collection";
  DROP TYPE "public"."enum_seo_history_field";
  DROP TYPE "public"."enum_seo_history_operation";
  DROP TYPE "public"."enum_seo_history_author_role";
  DROP TYPE "public"."enum_content_path_claims_owner_collection";
  DROP TYPE "public"."enum_users_role";
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  DROP TYPE "public"."enum_payload_jobs_log_state";
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  DROP TYPE "public"."enum_site_settings_ad_slots_position";
  DROP TYPE "public"."enum_site_settings_image_license_creator_kind";
  DROP TYPE "public"."enum_site_settings_audit_author_role";
  DROP TYPE "public"."enum__site_settings_v_version_ad_slots_position";
  DROP TYPE "public"."enum__site_settings_v_version_image_license_creator_kind";
  DROP TYPE "public"."enum__site_settings_v_version_audit_author_role";
  DROP TYPE "public"."enum_seo_link_audit_records_reason";
  DROP TYPE "public"."enum_seo_link_audit_records_document_collection";
  DROP TYPE "public"."enum_seo_link_audit_links_kind";
  DROP TYPE "public"."enum__seo_link_audit_v_version_records_reason";
  DROP TYPE "public"."enum__seo_link_audit_v_version_records_document_collection";
  DROP TYPE "public"."enum__seo_link_audit_v_version_links_kind";`)
}
