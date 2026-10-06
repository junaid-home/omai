// Frozen source contract from opencode-new-feature-omai- (11), 2026-10-02.
// This manifest validates the input; the importer never runs SQLite migrations.
export const sourceTables = {
  account: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "email",
      type: "TEXT",
    },
    {
      name: "url",
      type: "TEXT",
    },
    {
      name: "access_token",
      type: "TEXT",
    },
    {
      name: "refresh_token",
      type: "TEXT",
    },
    {
      name: "token_expiry",
      type: "INTEGER",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
  ],
  account_state: [
    {
      name: "id",
      type: "INTEGER",
    },
    {
      name: "active_account_id",
      type: "TEXT",
    },
    {
      name: "active_org_id",
      type: "TEXT",
    },
  ],
  control_account: [
    {
      name: "email",
      type: "TEXT",
    },
    {
      name: "url",
      type: "TEXT",
    },
    {
      name: "access_token",
      type: "TEXT",
    },
    {
      name: "refresh_token",
      type: "TEXT",
    },
    {
      name: "token_expiry",
      type: "INTEGER",
    },
    {
      name: "active",
      type: "INTEGER",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
  ],
  credential: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "integration_id",
      type: "TEXT",
    },
    {
      name: "label",
      type: "TEXT",
    },
    {
      name: "value",
      type: "TEXT",
    },
    {
      name: "connector_id",
      type: "TEXT",
    },
    {
      name: "method_id",
      type: "TEXT",
    },
    {
      name: "active",
      type: "INTEGER",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
  ],
  data_migration: [
    {
      name: "name",
      type: "TEXT",
    },
    {
      name: "time_completed",
      type: "INTEGER",
    },
  ],
  event: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "aggregate_id",
      type: "TEXT",
    },
    {
      name: "seq",
      type: "INTEGER",
    },
    {
      name: "type",
      type: "TEXT",
    },
    {
      name: "data",
      type: "TEXT",
    },
  ],
  event_sequence: [
    {
      name: "aggregate_id",
      type: "TEXT",
    },
    {
      name: "seq",
      type: "INTEGER",
    },
    {
      name: "owner_id",
      type: "TEXT",
    },
  ],
  message: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "session_id",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
    {
      name: "data",
      type: "TEXT",
    },
  ],
  migration: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "time_completed",
      type: "INTEGER",
    },
  ],
  part: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "message_id",
      type: "TEXT",
    },
    {
      name: "session_id",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
    {
      name: "data",
      type: "TEXT",
    },
  ],
  permission: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "project_id",
      type: "TEXT",
    },
    {
      name: "action",
      type: "TEXT",
    },
    {
      name: "resource",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
  ],
  project: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "worktree",
      type: "TEXT",
    },
    {
      name: "vcs",
      type: "TEXT",
    },
    {
      name: "name",
      type: "TEXT",
    },
    {
      name: "icon_url",
      type: "TEXT",
    },
    {
      name: "icon_url_override",
      type: "TEXT",
    },
    {
      name: "icon_color",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
    {
      name: "time_initialized",
      type: "INTEGER",
    },
    {
      name: "sandboxes",
      type: "TEXT",
    },
    {
      name: "commands",
      type: "TEXT",
    },
  ],
  project_directory: [
    {
      name: "project_id",
      type: "TEXT",
    },
    {
      name: "directory",
      type: "TEXT",
    },
    {
      name: "type",
      type: "TEXT",
    },
    {
      name: "strategy",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
  ],
  publish_deployment: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "project_id",
      type: "TEXT",
    },
    {
      name: "session_id",
      type: "TEXT",
    },
    {
      name: "name",
      type: "TEXT",
    },
    {
      name: "label",
      type: "TEXT",
    },
    {
      name: "url",
      type: "TEXT",
    },
    {
      name: "cf_project_name",
      type: "TEXT",
    },
    {
      name: "cf_deployment_id",
      type: "TEXT",
    },
    {
      name: "status",
      type: "TEXT",
    },
    {
      name: "custom_domain",
      type: "TEXT",
    },
    {
      name: "custom_domain_status",
      type: "TEXT",
    },
    {
      name: "runtime",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
  ],
  session: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "project_id",
      type: "TEXT",
    },
    {
      name: "workspace_id",
      type: "TEXT",
    },
    {
      name: "parent_id",
      type: "TEXT",
    },
    {
      name: "slug",
      type: "TEXT",
    },
    {
      name: "directory",
      type: "TEXT",
    },
    {
      name: "path",
      type: "TEXT",
    },
    {
      name: "title",
      type: "TEXT",
    },
    {
      name: "version",
      type: "TEXT",
    },
    {
      name: "share_url",
      type: "TEXT",
    },
    {
      name: "summary_additions",
      type: "INTEGER",
    },
    {
      name: "summary_deletions",
      type: "INTEGER",
    },
    {
      name: "summary_files",
      type: "INTEGER",
    },
    {
      name: "summary_diffs",
      type: "TEXT",
    },
    {
      name: "metadata",
      type: "TEXT",
    },
    {
      name: "cost",
      type: "REAL",
    },
    {
      name: "tokens_input",
      type: "INTEGER",
    },
    {
      name: "tokens_output",
      type: "INTEGER",
    },
    {
      name: "tokens_reasoning",
      type: "INTEGER",
    },
    {
      name: "tokens_cache_read",
      type: "INTEGER",
    },
    {
      name: "tokens_cache_write",
      type: "INTEGER",
    },
    {
      name: "revert",
      type: "TEXT",
    },
    {
      name: "permission",
      type: "TEXT",
    },
    {
      name: "agent",
      type: "TEXT",
    },
    {
      name: "model",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
    {
      name: "time_compacting",
      type: "INTEGER",
    },
    {
      name: "time_archived",
      type: "INTEGER",
    },
  ],
  session_context_epoch: [
    {
      name: "session_id",
      type: "TEXT",
    },
    {
      name: "baseline",
      type: "TEXT",
    },
    {
      name: "snapshot",
      type: "TEXT",
    },
    {
      name: "baseline_seq",
      type: "INTEGER",
    },
  ],
  session_input: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "session_id",
      type: "TEXT",
    },
    {
      name: "prompt",
      type: "TEXT",
    },
    {
      name: "delivery",
      type: "TEXT",
    },
    {
      name: "admitted_seq",
      type: "INTEGER",
    },
    {
      name: "promoted_seq",
      type: "INTEGER",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
  ],
  session_message: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "session_id",
      type: "TEXT",
    },
    {
      name: "type",
      type: "TEXT",
    },
    {
      name: "seq",
      type: "INTEGER",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
    {
      name: "data",
      type: "TEXT",
    },
  ],
  session_share: [
    {
      name: "session_id",
      type: "TEXT",
    },
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "secret",
      type: "TEXT",
    },
    {
      name: "url",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
  ],
  todo: [
    {
      name: "session_id",
      type: "TEXT",
    },
    {
      name: "content",
      type: "TEXT",
    },
    {
      name: "status",
      type: "TEXT",
    },
    {
      name: "priority",
      type: "TEXT",
    },
    {
      name: "position",
      type: "INTEGER",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
  ],
  user: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "username",
      type: "TEXT",
    },
    {
      name: "email",
      type: "TEXT",
    },
    {
      name: "password_hash",
      type: "TEXT",
    },
    {
      name: "time_created",
      type: "INTEGER",
    },
    {
      name: "time_updated",
      type: "INTEGER",
    },
  ],
  workspace: [
    {
      name: "id",
      type: "TEXT",
    },
    {
      name: "type",
      type: "TEXT",
    },
    {
      name: "name",
      type: "TEXT",
    },
    {
      name: "branch",
      type: "TEXT",
    },
    {
      name: "directory",
      type: "TEXT",
    },
    {
      name: "extra",
      type: "TEXT",
    },
    {
      name: "project_id",
      type: "TEXT",
    },
    {
      name: "time_used",
      type: "INTEGER",
    },
  ],
} as const

export const sourceMigrations = [
  "20260127222353_familiar_lady_ursula",
  "20260211171708_add_project_commands",
  "20260213144116_wakeful_the_professor",
  "20260225215848_workspace",
  "20260227213759_add_session_workspace_id",
  "20260228203230_blue_harpoon",
  "20260303231226_add_workspace_fields",
  "20260309230000_move_org_to_state",
  "20260312043431_session_message_cursor",
  "20260323234822_events",
  "20260410174513_workspace-name",
  "20260413175956_chief_energizer",
  "20260423070820_add_icon_url_override",
  "20260427172553_slow_nightmare",
  "20260428004200_add_session_path",
  "20260501142318_next_venus",
  "20260504145000_add_sync_owner",
  "20260507164347_add_workspace_time",
  "20260510033149_session_usage",
  "20260511000411_data_migration_state",
  "20260511173437_session-metadata",
  "20260601010001_normalize_storage_paths",
  "20260601202201_amazing_prowler",
  "20260602002951_lowly_union_jack",
  "20260602182828_add_project_directories",
  "20260603001617_session_message_projection_indexes",
  "20260603040000_session_message_projection_order",
  "20260603141458_session_input_inbox",
  "20260603160727_jittery_ezekiel_stane",
  "20260604172448_event_sourced_session_input",
  "20260605003541_add_session_context_snapshot",
  "20260605042240_add_context_epoch_agent",
  "20260611035744_credential",
  "20260611192811_lush_chimera",
  "20260612174303_project_dir_strategy",
  "20260622142730_simplify_session_context_epoch",
  "20260622170816_reset_v2_session_state",
  "20260622202450_simplify_session_input",
  "20260723000000_add_user_table",
  "20260915000000_add_publish_deployment_table",
  "20260917000000_add_custom_domain_to_publish",
  "20260924145240_add_runtime_to_publish",
] as const
