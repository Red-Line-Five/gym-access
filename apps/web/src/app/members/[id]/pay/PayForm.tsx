"use client";
import { useState } from "react";
import { formatDMY, nextPeriod, quotePayment, type Currency } from "@gym/core";
import { ll, usd } from "@/lib/format.ts";

interface Props { action: (fd: FormData) => Promise<void>; name: string; priceUsd: number; rate: number; credit: number; endDate: string | null; today: string }

const group = (x: number) => Math.round(x).toLocaleString("en-US");

export default function PayForm({ action, name, priceUsd, rate, credit, endDate, today }: Props) {
  const [mode, setMode] = useState<"sub" | "credit">("sub");
  const [months, setMonths] = useState(1);
  const [currency, setCurrency] = useState<Currency>("USD");
  const [useCredit, setUseCredit] = useState(credit > 0);
  const [typed, setTyped] = useState<string | null>(null);

  const isSub = mode === "sub";
  const base = quotePayment({ priceUsd, months, lbpRate: rate, creditUsd: credit, useCredit: isSub && useCredit });
  const auto = currency === "USD" ? String(base.due) : group(base.due * rate);
  const shown = typed ?? (isSub ? auto : "");
  const received = Number(shown.replace(/,/g, "")) || 0;
  const q = quotePayment({ priceUsd, months, lbpRate: rate, creditUsd: credit, useCredit: isSub && useCredit, received, currency });
  const creditAfter = isSub ? q.creditAfter : Math.round((credit + q.receivedUsd) * 100) / 100;

  let note = "Enter the amount to keep as credit. Use this for a gift or a payment made in advance.";
  let tone = "gray";
  if (isSub) {
    if (q.creditAdded > 0) { note = `${usd(q.creditAdded)} extra is kept as credit for ${name}. It can be used next month or moved to another member.`; tone = "ok"; }
    else if (q.discount > 0) { note = `Discount of ${usd(q.discount)}. The subscription is still given in full.`; tone = "warn"; }
    else { note = "Exact amount. Nothing is left over."; }
  } else if (q.receivedUsd > 0) { note = `${usd(q.receivedUsd)} is added to ${name}'s credit. The subscription does not change.`; tone = "ok"; }

  // same rule as the database (and as record_payment): early renewal starts the day after the current end
  const period = nextPeriod(endDate, today, months);
  const fmt = formatDMY;

  return (
    <form action={action} className="stack">
      <div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>What is this payment?</div>
        <div className="seg">
          <label><input type="radio" name="mode" value="sub" checked={isSub} onChange={() => { setMode("sub"); setTyped(null); }} /><span>Subscription</span></label>
          <label><input type="radio" name="mode" value="credit" checked={!isSub} onChange={() => { setMode("credit"); setTyped(null); }} /><span>Keep as credit (gift or advance)</span></label>
        </div>
      </div>

      {isSub && (
        <>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>How long?</div>
            <div className="seg">
              {[1, 3, 6, 12].map((m) => (
                <label key={m}><input type="radio" name="months" value={m} checked={months === m} onChange={() => { setMonths(m); setTyped(null); }} /><span>{m} {m === 1 ? "month" : "months"}</span></label>
              ))}
            </div>
          </div>
          {credit > 0 && (
            <label className="row" style={{ gap: 10 }}>
              <input type="checkbox" name="useCredit" checked={useCredit} onChange={(e) => { setUseCredit(e.target.checked); setTyped(null); }} />
              <span>Use {name}'s {usd(credit)} credit for this payment</span>
            </label>
          )}
        </>
      )}

      <div>
        <label htmlFor="received">Amount received</label>
        <div className="row" style={{ marginTop: 6 }}>
          <input id="received" name="received" inputMode="decimal" value={shown} onChange={(e) => setTyped(e.target.value)} style={{ width: 200, fontSize: 16 }} />
          <div className="seg">
            {(["USD", "LBP"] as const).map((c) => (
              <label key={c}><input type="radio" name="currency" value={c} checked={currency === c} onChange={() => { setCurrency(c); setTyped(null); }} /><span>{c === "LBP" ? "LL" : "USD"}</span></label>
            ))}
          </div>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>{currency === "USD" ? `= ${ll(received * rate)}` : `= ${usd(received / rate)}`} at {group(rate)} LL per $1</div>
      </div>

      <dl className="sum num">
        {isSub && <><dt>Price, {months} {months === 1 ? "month" : "months"}</dt><dd>{usd(q.price)}</dd></>}
        {isSub && q.creditUsed > 0 && <><dt>Credit used</dt><dd>-{usd(q.creditUsed)}</dd></>}
        {isSub && <><dt><strong>To pay</strong></dt><dd><strong>{usd(q.due)} · {ll(q.dueLbp)}</strong></dd></>}
        <dt><strong>Received</strong></dt><dd><strong>{usd(q.receivedUsd)}</strong></dd>
        <dt style={{ color: "var(--teal-d)" }}><strong>Credit after saving</strong></dt><dd style={{ color: "var(--teal-d)" }}><strong>{usd(creditAfter)}</strong></dd>
      </dl>

      <div className={`note ${tone}`} aria-live="polite">{note}</div>

      {isSub && (
        <div className="note ok" style={{ background: "var(--tint)" }}>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 600 }}>The door will allow {name} from</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 700 }}>{fmt(period.start)} to {fmt(period.end)}</div>
          <div style={{ fontWeight: 400, marginTop: 6 }}>{endDate && endDate >= today ? `Paid before the current end (${fmt(endDate)}), so no days are lost.` : "Starts today."}</div>
        </div>
      )}

      <button className="primary" style={{ minHeight: 52 }}>{isSub ? "Save payment" : "Save as credit"}</button>
    </form>
  );
}
