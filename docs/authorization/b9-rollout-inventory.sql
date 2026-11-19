-- Run directly on the approved read-only connection. Worksheet GET can persist staleness.
SELECT d.company_id, d.fiscal_year_id, d.worksheet_id, d.id AS decision_id,
       d.engine_version, d.reference_suite_digest, d.approved_at IS NOT NULL AS reviewed,
       w.status AS worksheet_status,
       EXISTS (SELECT 1 FROM annual_closing_packages p
                WHERE p.company_id=d.company_id AND p.fiscal_year_id=d.fiscal_year_id
                  AND p.status IN ('finalized','handed_off')) AS package_locked
  FROM zakat_regulatory_decisions d
  JOIN zakat_worksheets w ON w.id=d.worksheet_id AND w.company_id=d.company_id
 WHERE d.gate='B9' AND d.ended_at IS NULL AND d.stale_at IS NULL
 ORDER BY d.company_id, d.fiscal_year_id, d.worksheet_id, d.id;
