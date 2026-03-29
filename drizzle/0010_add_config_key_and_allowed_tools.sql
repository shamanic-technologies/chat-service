-- Add key and allowed_tools columns to app_configs
ALTER TABLE "app_configs" ADD COLUMN "key" text NOT NULL DEFAULT 'default';
ALTER TABLE "app_configs" ADD COLUMN "allowed_tools" jsonb NOT NULL DEFAULT '["request_user_input", "update_workflow", "validate_workflow", "get_prompt_template", "update_prompt_template", "update_workflow_node_config", "get_workflow_details", "generate_workflow", "get_workflow_required_providers", "list_workflows", "list_services", "list_service_endpoints", "list_org_keys", "get_key_source", "list_key_sources", "check_provider_requirements"]'::jsonb;

-- Drop old unique constraint on orgId only, add new one on (orgId, key)
ALTER TABLE "app_configs" DROP CONSTRAINT IF EXISTS "app_configs_org_id_unique";
ALTER TABLE "app_configs" ADD CONSTRAINT "app_configs_org_id_key_unique" UNIQUE ("org_id", "key");

-- Remove the default now that existing rows are migrated
ALTER TABLE "app_configs" ALTER COLUMN "key" DROP DEFAULT;
ALTER TABLE "app_configs" ALTER COLUMN "allowed_tools" DROP DEFAULT;

-- Add allowed_tools to platform_configs
ALTER TABLE "platform_configs" ADD COLUMN "allowed_tools" jsonb NOT NULL DEFAULT '["request_user_input", "update_workflow", "validate_workflow", "get_prompt_template", "update_prompt_template", "update_workflow_node_config", "get_workflow_details", "generate_workflow", "get_workflow_required_providers", "list_workflows", "list_services", "list_service_endpoints", "list_org_keys", "get_key_source", "list_key_sources", "check_provider_requirements"]'::jsonb;
ALTER TABLE "platform_configs" ALTER COLUMN "allowed_tools" DROP DEFAULT;
