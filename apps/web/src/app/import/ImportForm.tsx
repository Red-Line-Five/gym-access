"use client";
import { useActionState } from "react";
import Link from "next/link";
import { confirmImport, previewImport, type Preview } from "./actions.ts";

export default function ImportForm() {
  const [preview, previewAction, previewing] = useActionState<Preview | null, FormData>(previewImport, null);
  const [result, confirmAction, saving] = useActionState<Preview | null, FormData>(confirmImport, null);

  if (result?.done) {
    return (<div className="stack"><div className="flash">{result.done}</div><Link className="btn primary" href="/members">Go to members</Link></div>);
  }
  return (
    <div className="stack">
      <form action={previewAction} className="card stack">
        <div>
          <label htmlFor="file">Excel file (.xlsx)</label>
          <div><input id="file" name="file" type="file" accept=".xlsx" style={{ marginTop: 6, paddingTop: 8 }} /></div>
          <div className="muted" style={{ marginTop: 6 }}>Row 1 needs the headings <strong>Name</strong> and <strong>Phone</strong>. Other columns are ignored.</div>
        </div>
        <div><button className="primary" disabled={previewing}>{previewing ? "Reading..." : "Read file"}</button></div>
      </form>

      {preview?.problem && <div className="flash err">{preview.problem}</div>}
      {preview && !preview.problem && (
        <div className="card stack">
          <div className="cards">
            <div><div className="muted">New members</div><div className="big">{preview.fresh.length}</div></div>
            <div><div className="muted">Already here (same phone)</div><div className="big">{preview.duplicates.length}</div></div>
            <div><div className="muted">No phone, skipped</div><div className="big">{preview.noPhone.length}</div></div>
          </div>
          {preview.fresh.length > 0 && (
            <div className="scroll"><table>
              <thead><tr><th>Name</th><th>Phone</th></tr></thead>
              <tbody>{preview.fresh.slice(0, 50).map((r, i) => <tr key={i}><td>{r.name}</td><td className="num">{r.phone}</td></tr>)}</tbody>
            </table>{preview.fresh.length > 50 && <div className="muted">... and {preview.fresh.length - 50} more</div>}</div>
          )}
          <form action={confirmAction}>
            <input type="hidden" name="rows" value={JSON.stringify(preview.fresh)} />
            <button className="primary" disabled={saving || preview.fresh.length === 0}>{saving ? "Adding..." : `Add ${preview.fresh.length} members`}</button>
          </form>
        </div>
      )}
    </div>
  );
}
