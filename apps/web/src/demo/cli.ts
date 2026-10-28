import { describeError, QuotaFlowClient } from '../api';
import { runDemoScenario } from './scenario';

// Headless runner for the same scenario the web UI's "Run demo" button uses.
// Usage: npm run demo -- [baseUrl]   (default http://localhost:8080/api)
const baseUrl = process.argv[2] ?? process.env.QUOTAFLOW_URL ?? 'http://localhost:8080/api';
const adminToken = process.env.ADMIN_TOKEN || undefined;

console.log(`QuotaFlow demo against ${baseUrl}\n`);
runDemoScenario(new QuotaFlowClient(baseUrl, undefined, adminToken), (step) => {
  console.log(`${step.passed ? 'PASS' : 'FAIL'}  ${step.title}`);
  console.log(`      ${step.explanation}`);
  console.log(`      expected: ${step.expected}`);
  console.log(`      actual:   ${step.actual}\n`);
})
  .then((outcome) => {
    console.log(`${outcome.passed ? 'All steps passed.' : 'Some steps FAILED.'} Account: ${outcome.accountName}`);
    console.log(`Explore it in the web client with API key: ${outcome.apiKey}`);
    process.exitCode = outcome.passed ? 0 : 1;
  })
  .catch((error: unknown) => {
    console.error(`Demo failed: ${describeError(error)}`);
    process.exitCode = 1;
  });
