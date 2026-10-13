export type OverlayComparisonStatus = 'same' | 'different' | 'unverified' | 'invalid';

export interface OverlayComparisonDetail {
  field: string;
  status: OverlayComparisonStatus;
  overlayValue: unknown;
  upstreamValue: unknown;
  reason: string;
}

export interface OverlayComparisonOptions {
  /** Compared normally, with an explanation that these fields identify the record. */
  identityFields?: string[];
  /** Explicit metadata exclusions remain visible and unverified. */
  ignoreFields?: string[];
}

export declare function compareOverlayFields(
  patch: unknown,
  upstream: unknown,
  options?: OverlayComparisonOptions
): OverlayComparisonDetail[];

export declare function comparisonSummary(details: readonly OverlayComparisonDetail[]): {
  same: number;
  different: number;
  unverified: number;
  invalid: number;
};
