/**
 * Money rules for one subscription payment. Mirrors record_payment() in supabase/schema.sql so the
 * screen can show the same numbers before saving. All amounts are USD rounded to cents.
 */

export type Currency = "USD" | "LBP";

export interface QuoteInput {
  priceUsd: number; // price of ONE month
  months: number;
  lbpRate: number; // LL per $1
  creditUsd: number; // balance the member already has
  useCredit: boolean;
  /** What the employee typed. Omit to use the exact amount due. */
  received?: number;
  currency?: Currency;
}

export interface Quote {
  price: number;
  creditUsed: number;
  due: number;
  dueLbp: number;
  receivedUsd: number;
  /** Extra money, kept as credit. */
  creditAdded: number;
  /** Less money than due; the full months are still given. */
  discount: number;
  creditAfter: number;
}

const cents = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

export function quotePayment(input: QuoteInput): Quote {
  const { priceUsd, months, lbpRate, creditUsd, useCredit } = input;
  if (!(priceUsd > 0) || !(lbpRate > 0)) throw new RangeError("price and rate must be above zero");
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new RangeError("months must be 1 to 24");
  if (creditUsd < 0) throw new RangeError("credit cannot be negative");

  const price = cents(priceUsd * months);
  const creditUsed = useCredit ? cents(Math.min(creditUsd, price)) : 0;
  const due = cents(price - creditUsed);
  const currency = input.currency ?? "USD";
  const receivedInput = input.received ?? (currency === "USD" ? due : due * lbpRate);
  if (receivedInput < 0) throw new RangeError("received cannot be negative");
  const receivedUsd = cents(currency === "USD" ? receivedInput : receivedInput / lbpRate);

  const diff = cents(receivedUsd - due);
  const creditAdded = diff >= 0.01 ? diff : 0;
  const discount = diff < -0.005 ? cents(-diff) : 0;
  return {
    price,
    creditUsed,
    due,
    dueLbp: Math.round(due * lbpRate),
    receivedUsd,
    creditAdded,
    discount,
    creditAfter: cents(creditUsd - creditUsed + creditAdded),
  };
}
