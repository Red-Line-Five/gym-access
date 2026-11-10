export const usd = (x: number): string =>
  "$" + (Math.abs(x - Math.round(x)) < 0.005 ? Math.round(x).toLocaleString("en-US") : x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const ll = (x: number): string => Math.round(x).toLocaleString("en-US") + " LL";
export const dmy = (iso: string | null): string => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (iso: string): string => MONTHS[Number(iso.slice(5, 7)) - 1] + " " + iso.slice(0, 4);
