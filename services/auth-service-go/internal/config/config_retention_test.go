package config

import "testing"

// RETENTION_AUDIT_DAYS / RETENTION_CHAT_DAYS feed internal/retention; 0 keeps rows forever.
func TestLoadRetentionSettings(t *testing.T) {
	t.Run("defaults keep everything", func(t *testing.T) {
		t.Setenv("RETENTION_AUDIT_DAYS", "")
		t.Setenv("RETENTION_CHAT_DAYS", "")
		cfg := Load()
		if cfg.RetentionAuditDays != 0 || cfg.RetentionChatDays != 0 {
			t.Fatalf("defaults = %d/%d, want 0/0", cfg.RetentionAuditDays, cfg.RetentionChatDays)
		}
	})
	t.Run("days from the environment", func(t *testing.T) {
		t.Setenv("RETENTION_AUDIT_DAYS", "365")
		t.Setenv("RETENTION_CHAT_DAYS", "180")
		cfg := Load()
		if cfg.RetentionAuditDays != 365 || cfg.RetentionChatDays != 180 {
			t.Fatalf("got %d/%d, want 365/180", cfg.RetentionAuditDays, cfg.RetentionChatDays)
		}
	})
	t.Run("an unparsable value falls back to 0", func(t *testing.T) {
		t.Setenv("RETENTION_AUDIT_DAYS", "one-year")
		if Load().RetentionAuditDays != 0 {
			t.Fatal("unparsable RETENTION_AUDIT_DAYS should fall back to 0")
		}
	})
}
