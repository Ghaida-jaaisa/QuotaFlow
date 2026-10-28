// Mirrors the API's response shapes (see the README API reference).

export type Scope = 'account' | 'user';
export type RejectionCode =
  | 'ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED'
  | 'USER_PER_REQUEST_LIMIT_EXCEEDED'
  | 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED'
  | 'USER_MONTHLY_LIMIT_EXCEEDED';

export interface Plan {
  id: string;
  code: string | null;
  name: string;
  scope: Scope;
  kind: 'predefined' | 'custom';
  monthlyLimit: number;
  perRequestLimit: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface UsageSnapshot {
  month: string;
  usedUnits: number;
  monthlyLimit: number;
  perRequestLimit: number;
  remaining: number;
}

export interface Account {
  id: string;
  name: string;
  apiKeyPrefix: string;
  createdAt: string;
  plan: Plan;
  usage: UsageSnapshot;
}

export interface CreatedAccount extends Account {
  apiKey: string;
}

export interface User {
  id: string;
  accountId: string;
  name: string;
  createdAt: string;
  plan: Plan;
  usage: UsageSnapshot;
}

export interface UserDetail extends User {
  accountUsage: UsageSnapshot;
  effective: { maxUnitsPerRequest: number; availableThisMonth: number };
}

export interface LevelDecision {
  planId: string;
  planVersion: number;
  monthlyLimit: number;
  perRequestLimit: number;
  usedUnits: number;
  remaining: number;
}

export interface Decision {
  id: string;
  requestId: string;
  decision: 'accepted' | 'rejected';
  userId: string;
  units: number;
  unitsAccepted: number;
  month: string;
  processedAt: string;
  rejection: {
    code: RejectionCode;
    level: Scope;
    limitType: 'per_request' | 'monthly';
    limit: number;
    available: number | null;
    message: string;
  } | null;
  account: LevelDecision;
  user: LevelDecision;
}

export interface ConsumeResult extends Decision {
  replayed: boolean;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
