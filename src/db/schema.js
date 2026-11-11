// Every table that holds client data carries workspace_id, so each client's
// brand, posts and usage stay separate.
export const migrations = [
  [
    `CREATE TABLE IF NOT EXISTS users (
      id {{PK}},
      email VARCHAR(191) NOT NULL UNIQUE,
      name VARCHAR(191) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL,
      workspace_id BIGINT NULL,
      created_at {{DT}} NOT NULL
    ){{END}}`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(64) PRIMARY KEY,
      user_id BIGINT NOT NULL,
      csrf VARCHAR(64) NOT NULL,
      expires_at {{DT}} NOT NULL,
      created_at {{DT}} NOT NULL
    ){{END}}`,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id {{PK}},
      name VARCHAR(191) NOT NULL,
      timezone VARCHAR(64) NOT NULL,
      primary_color VARCHAR(9) NOT NULL,
      secondary_color VARCHAR(9) NOT NULL,
      tone {{TEXT}},
      audience {{TEXT}},
      banned_words {{TEXT}},
      sample_posts {{TEXT}},
      slack_channel VARCHAR(64) NULL,
      created_at {{DT}} NOT NULL,
      updated_at {{DT}} NOT NULL
    ){{END}}`,
    `CREATE TABLE IF NOT EXISTS settings (
      skey VARCHAR(100) PRIMARY KEY,
      svalue {{TEXT}},
      updated_at {{DT}} NOT NULL
    ){{END}}`,
    `CREATE TABLE IF NOT EXISTS posts (
      id {{PK}},
      workspace_id BIGINT NOT NULL,
      created_by VARCHAR(191) NOT NULL,
      status VARCHAR(30) NOT NULL,
      version INT NOT NULL,
      brief {{TEXT}},
      content {{TEXT}},
      platforms VARCHAR(255) NOT NULL,
      publish_at {{DT}} NULL,
      error {{TEXT}},
      slack_channel VARCHAR(64) NULL,
      slack_ts VARCHAR(64) NULL,
      decided_by VARCHAR(191) NULL,
      decided_at {{DT}} NULL,
      created_at {{DT}} NOT NULL,
      updated_at {{DT}} NOT NULL
    ){{END}}`,
    `CREATE INDEX idx_posts_ws ON posts (workspace_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS post_events (
      id {{PK}},
      post_id BIGINT NOT NULL,
      kind VARCHAR(40) NOT NULL,
      actor VARCHAR(191) NOT NULL,
      note {{TEXT}},
      created_at {{DT}} NOT NULL
    ){{END}}`,
    `CREATE INDEX idx_events_post ON post_events (post_id, id)`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id {{PK}},
      kind VARCHAR(40) NOT NULL,
      post_id BIGINT NULL,
      payload {{TEXT}},
      status VARCHAR(20) NOT NULL,
      attempts INT NOT NULL,
      run_at {{DT}} NOT NULL,
      locked_at {{DT}} NULL,
      error {{TEXT}},
      created_at {{DT}} NOT NULL,
      updated_at {{DT}} NOT NULL
    ){{END}}`,
    `CREATE INDEX idx_jobs_due ON jobs (status, run_at)`,
    `CREATE TABLE IF NOT EXISTS usage_log (
      id {{PK}},
      workspace_id BIGINT NOT NULL,
      post_id BIGINT NULL,
      kind VARCHAR(40) NOT NULL,
      model VARCHAR(100) NULL,
      input_tokens INT NOT NULL,
      output_tokens INT NOT NULL,
      created_at {{DT}} NOT NULL
    ){{END}}`,
    `CREATE INDEX idx_usage_ws ON usage_log (workspace_id, created_at)`,
  ],
];
