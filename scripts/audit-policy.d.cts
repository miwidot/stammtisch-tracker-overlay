type AcceptedAdvisory = {
  package: string;
  reason: string;
  expires: string;
};

type AuditOutcome = {
  accepted: string[];
  failures: string[];
  warnings: string[];
};

export const AUDIT_LEVEL: string;

export function readAuditReport(
  stdout: string,
  status: number | null
): { report: Record<string, unknown>; error?: undefined } | { error: string; report?: undefined };

export function evaluateAuditReport(
  report: Record<string, unknown>,
  accepted: Record<string, AcceptedAdvisory>,
  today: string,
  level?: string
): AuditOutcome;

type AuditRun = {
  error?: Error;
  signal: string | null;
  status: number | null;
  stdout: string;
};

export function assessAuditRun(
  result: AuditRun,
  accepted: Record<string, AcceptedAdvisory>,
  today: string,
  level?: string
): { exitCode: number; stdout: string[]; stderr: string[] };
