import { requireSession } from "@/lib/session.ts";
import ImportForm from "./ImportForm.tsx";

export default async function ImportPage() {
  await requireSession();
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <h1>Import members from Excel</h1>
      <p className="muted" style={{ margin: 0 }}>You see what will be added before anything is saved. People whose phone is already in the list are skipped.</p>
      <ImportForm />
    </div>
  );
}
