// src/lib/investmentConsistencyGuard.ts

export type OfferingStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "published"
  | "archived";

/**
 * @notice Statuses that allow investments to be made
 * @dev Only published offerings can receive investments
 */
export const INVESTABLE_STATUSES: OfferingStatus[] = ["published"];

/**
 * @notice Checks if an offering can receive investments
 */
export function canInvest(offeringStatus: OfferingStatus): boolean {
  return INVESTABLE_STATUSES.includes(offeringStatus);
}

/**
 * @notice Validates investment amount
 * @dev Amount must be a positive number
 */
export function isValidAmount(amount: number): boolean {
  return typeof amount === "number" && amount > 0 && isFinite(amount);
}

/**
 * @notice Enforces all investment consistency rules
 * @throws Error if any rule is violated
 */
export function enforceInvestmentConsistency(input: {
  offeringStatus: OfferingStatus;
  amount: number;
  investorId: string;
  offeringId: string;
}): void {
  const { offeringStatus, amount, investorId, offeringId } = input;

  if (!offeringId) {
    throw new Error("Offering ID is required");
  }

  if (!investorId) {
    throw new Error("Investor ID is required");
  }

  if (!offeringStatus) {
    throw new Error("Offering status is required");
  }

  if (!INVESTABLE_STATUSES.includes(offeringStatus)) {
    throw new Error(
      `Offering is not open for investment. Current status: ${offeringStatus}`
    );
  }

  if (amount === undefined || amount === null) {
    throw new Error("Investment amount is required");
  }

  if (!isValidAmount(amount)) {
    throw new Error(
      "Investment amount must be a positive number"
    );
  }
}