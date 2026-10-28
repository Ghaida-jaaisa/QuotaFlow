import type { Account, ConsumeResult, CreatedAccount, Decision, Page, Plan, Scope, User, UserDetail } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Thin typed wrapper over the QuotaFlow REST API. Uses only `fetch`, so the
 * same client runs in the browser and in Node (the CLI demo).
 */
export class QuotaFlowClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly adminToken?: string,
  ) {}

  withApiKey(apiKey: string): QuotaFlowClient {
    return new QuotaFlowClient(this.baseUrl, apiKey, this.adminToken);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    if (this.adminToken) headers['X-Admin-Token'] = this.adminToken;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new ApiError(response.status, error?.code ?? 'HTTP_ERROR', error?.message ?? response.statusText, error?.details);
    }
    return json as T;
  }

  createAccount(name: string, planId?: string) {
    return this.request<CreatedAccount>('POST', '/v1/accounts', { name, ...(planId ? { planId } : {}) });
  }
  getAccount() {
    return this.request<Account>('GET', '/v1/account');
  }
  assignAccountPlan(planId: string) {
    return this.request<Account>('PUT', '/v1/account/plan', { planId });
  }
  listPredefinedPlans() {
    return this.request<{ data: Plan[] }>('GET', '/v1/plans/predefined');
  }
  listPlans() {
    return this.request<{ data: Plan[] }>('GET', '/v1/plans');
  }
  createPlan(input: { name: string; scope: Scope; monthlyLimit: number; perRequestLimit: number }) {
    return this.request<Plan>('POST', '/v1/plans', input);
  }
  updatePlan(planId: string, input: { name?: string; monthlyLimit?: number; perRequestLimit?: number }) {
    return this.request<Plan>('PATCH', `/v1/plans/${planId}`, input);
  }
  createUser(name: string, planId?: string) {
    return this.request<User>('POST', '/v1/users', { name, ...(planId ? { planId } : {}) });
  }
  listUsers(limit = 100) {
    return this.request<Page<User>>('GET', `/v1/users?limit=${limit}`);
  }
  getUser(userId: string) {
    return this.request<UserDetail>('GET', `/v1/users/${userId}`);
  }
  assignUserPlan(userId: string, planId: string) {
    return this.request<UserDetail>('PUT', `/v1/users/${userId}/plan`, { planId });
  }
  consume(userId: string, units: number, requestId: string) {
    return this.request<ConsumeResult>('POST', '/v1/usage/consume', { userId, units, requestId });
  }
  listRequests(params: { limit?: number; cursor?: string; userId?: string } = {}) {
    const query = new URLSearchParams();
    query.set('limit', String(params.limit ?? 20));
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.userId) query.set('userId', params.userId);
    return this.request<Page<Decision>>('GET', `/v1/usage/requests?${query.toString()}`);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${error.status} ${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
