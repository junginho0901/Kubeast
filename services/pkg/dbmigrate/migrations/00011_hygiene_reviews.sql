-- +goose Up
-- Cluster hygiene report (k8s-service): each sign-off keeps the report of one
-- cluster as it stood, with who signed and when. Deleted after
-- RETENTION_REVIEW_DAYS by auth-service, like access_reviews.
CREATE TABLE IF NOT EXISTS hygiene_reviews (
    id                VARCHAR PRIMARY KEY,
    cluster           VARCHAR NOT NULL,
    reviewed_by       VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
    reviewed_by_email VARCHAR NOT NULL,
    reviewed_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    note              TEXT NOT NULL DEFAULT '',
    counts            JSONB NOT NULL DEFAULT '{}',
    snapshot          JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_hygiene_reviews_cluster_at ON hygiene_reviews(cluster, reviewed_at DESC);

-- +goose Down
DROP TABLE IF EXISTS hygiene_reviews;
