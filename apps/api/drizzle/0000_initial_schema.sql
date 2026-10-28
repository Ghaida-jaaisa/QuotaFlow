CREATE TYPE "public"."decision_status" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."limit_level" AS ENUM('account', 'user');--> statement-breakpoint
CREATE TYPE "public"."plan_scope" AS ENUM('account', 'user');--> statement-breakpoint
CREATE TYPE "public"."rejection_reason" AS ENUM('ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED', 'USER_PER_REQUEST_LIMIT_EXCEEDED', 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED', 'USER_MONTHLY_LIMIT_EXCEEDED');--> statement-breakpoint
CREATE TABLE "account_monthly_usage" (
	"account_id" uuid NOT NULL,
	"month" date NOT NULL,
	"used_units" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_monthly_usage_pk" PRIMARY KEY("account_id","month"),
	CONSTRAINT "account_monthly_usage_non_negative" CHECK ("account_monthly_usage"."used_units" >= 0),
	CONSTRAINT "account_monthly_usage_first_of_month" CHECK (EXTRACT(DAY FROM "account_monthly_usage"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_scope" "plan_scope" DEFAULT 'account' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "accounts_api_key_hash_unique" UNIQUE("api_key_hash"),
	CONSTRAINT "accounts_plan_scope_is_account" CHECK ("accounts"."plan_scope" = 'account')
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"code" text,
	"scope" "plan_scope" NOT NULL,
	"name" text NOT NULL,
	"monthly_limit" integer NOT NULL,
	"per_request_limit" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code"),
	CONSTRAINT "plans_id_scope_unique" UNIQUE("id","scope"),
	CONSTRAINT "plans_account_scope_name_unique" UNIQUE("account_id","scope","name"),
	CONSTRAINT "plans_monthly_limit_positive" CHECK ("plans"."monthly_limit" > 0),
	CONSTRAINT "plans_per_request_limit_positive" CHECK ("plans"."per_request_limit" > 0),
	CONSTRAINT "plans_version_positive" CHECK ("plans"."version" > 0),
	CONSTRAINT "plans_predefined_xor_owned" CHECK (("plans"."account_id" IS NULL) = ("plans"."code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "usage_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"units" integer NOT NULL,
	"status" "decision_status" NOT NULL,
	"rejection_reason" "rejection_reason",
	"rejection_level" "limit_level",
	"usage_month" date NOT NULL,
	"processed_at" timestamp with time zone NOT NULL,
	"account_plan_id" uuid NOT NULL,
	"account_plan_version" integer NOT NULL,
	"account_monthly_limit" integer NOT NULL,
	"account_per_request_limit" integer NOT NULL,
	"account_used_before" integer NOT NULL,
	"account_used_after" integer NOT NULL,
	"user_plan_id" uuid NOT NULL,
	"user_plan_version" integer NOT NULL,
	"user_monthly_limit" integer NOT NULL,
	"user_per_request_limit" integer NOT NULL,
	"user_used_before" integer NOT NULL,
	"user_used_after" integer NOT NULL,
	CONSTRAINT "usage_requests_account_request_unique" UNIQUE("account_id","request_id"),
	CONSTRAINT "usage_requests_units_positive" CHECK ("usage_requests"."units" > 0),
	CONSTRAINT "usage_requests_first_of_month" CHECK (EXTRACT(DAY FROM "usage_requests"."usage_month") = 1),
	CONSTRAINT "usage_requests_rejection_consistent" CHECK (("usage_requests"."status" = 'accepted' AND "usage_requests"."rejection_reason" IS NULL AND "usage_requests"."rejection_level" IS NULL)
        OR ("usage_requests"."status" = 'rejected' AND "usage_requests"."rejection_reason" IS NOT NULL AND "usage_requests"."rejection_level" IS NOT NULL)),
	CONSTRAINT "usage_requests_usage_delta_consistent" CHECK ("usage_requests"."account_used_after" = "usage_requests"."account_used_before" + CASE WHEN "usage_requests"."status" = 'accepted' THEN "usage_requests"."units" ELSE 0 END
        AND "usage_requests"."user_used_after" = "usage_requests"."user_used_before" + CASE WHEN "usage_requests"."status" = 'accepted' THEN "usage_requests"."units" ELSE 0 END)
);
--> statement-breakpoint
CREATE TABLE "user_monthly_usage" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"month" date NOT NULL,
	"used_units" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_monthly_usage_pk" PRIMARY KEY("user_id","month"),
	CONSTRAINT "user_monthly_usage_non_negative" CHECK ("user_monthly_usage"."used_units" >= 0),
	CONSTRAINT "user_monthly_usage_first_of_month" CHECK (EXTRACT(DAY FROM "user_monthly_usage"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_scope" "plan_scope" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "users_plan_scope_is_user" CHECK ("users"."plan_scope" = 'user')
);
--> statement-breakpoint
ALTER TABLE "account_monthly_usage" ADD CONSTRAINT "account_monthly_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_fk" FOREIGN KEY ("plan_id","plan_scope") REFERENCES "public"."plans"("id","scope") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_requests" ADD CONSTRAINT "usage_requests_account_plan_id_plans_id_fk" FOREIGN KEY ("account_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_requests" ADD CONSTRAINT "usage_requests_user_plan_id_plans_id_fk" FOREIGN KEY ("user_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_requests" ADD CONSTRAINT "usage_requests_user_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_monthly_usage" ADD CONSTRAINT "user_monthly_usage_user_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_fk" FOREIGN KEY ("plan_id","plan_scope") REFERENCES "public"."plans"("id","scope") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_plan_id_idx" ON "accounts" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "usage_requests_account_history_idx" ON "usage_requests" USING btree ("account_id","processed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_requests_user_history_idx" ON "usage_requests" USING btree ("user_id","processed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_account_created_idx" ON "users" USING btree ("account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "users_plan_id_idx" ON "users" USING btree ("plan_id");