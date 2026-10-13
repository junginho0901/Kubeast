"""Alert → AI investigation (features.alertInvestigation): Alertmanager's
webhook queues alerts, one worker investigates each with the read-only tools
as the kubeast:investigator identity, and the report is stored and audited."""
