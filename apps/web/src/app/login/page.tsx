import { login } from "../actions.ts";

export default function Login() {
  return (
    <div className="card" style={{ maxWidth: 460, margin: "40px auto" }}>
      <h1>Gym Access</h1>
      <p className="muted">Demo mode: no password. Pick who you are. In the live version this is a normal email and password login.</p>
      <form action={login} className="stack">
        <div className="seg">
          <label><input type="radio" name="who" value="employee" defaultChecked /><span>Reception</span></label>
          <label><input type="radio" name="who" value="owner" /><span>Owner</span></label>
        </div>
        <button className="primary">Continue</button>
      </form>
    </div>
  );
}
