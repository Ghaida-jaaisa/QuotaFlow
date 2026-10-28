-- Cross-checks every account's counters against the decision ledger.
-- Run: docker compose exec -T postgres psql -U quotaflow -d quotaflow < load-tests/verify-accounting.sql
-- Every query must return zero rows.

\echo 'Account counters that disagree with the sum of accepted ledger units:'
SELECT a.account_id, a.month, a.used_units, COALESCE(SUM(r.units), 0) AS ledger_units
FROM account_monthly_usage a
LEFT JOIN usage_requests r
  ON r.account_id = a.account_id AND r.usage_month = a.month AND r.status = 'accepted'
GROUP BY a.account_id, a.month, a.used_units
HAVING a.used_units <> COALESCE(SUM(r.units), 0);

\echo 'Account counters that disagree with the sum of their users'' counters:'
SELECT a.account_id, a.month, a.used_units, COALESCE(SUM(u.used_units), 0) AS users_sum
FROM account_monthly_usage a
LEFT JOIN user_monthly_usage u ON u.account_id = a.account_id AND u.month = a.month
GROUP BY a.account_id, a.month, a.used_units
HAVING a.used_units <> COALESCE(SUM(u.used_units), 0);

\echo 'Accepted decisions that exceeded the limit snapshot they were evaluated against:'
SELECT id, request_id FROM usage_requests
WHERE status = 'accepted'
  AND (account_used_after > account_monthly_limit OR user_used_after > user_monthly_limit
       OR units > account_per_request_limit OR units > user_per_request_limit);

\echo 'Duplicate request IDs within an account (impossible by constraint):'
SELECT account_id, request_id, COUNT(*) FROM usage_requests GROUP BY 1, 2 HAVING COUNT(*) > 1;

\echo 'Summary:'
SELECT COUNT(*) AS decisions,
       COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
       COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
FROM usage_requests;
