export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>MITAoE PYQ Analytics</h1>
      <p>The API is up. The chat UI is coming next.</p>
      <ul>
        <li>
          <code>GET /api/subjects</code> — subjects with question counts
        </li>
        <li>
          <code>GET /api/stats</code> — pipeline / corpus statistics
        </li>
        <li>
          <code>POST /api/ask</code> — <code>{"{ subject, question }"}</code>
        </li>
      </ul>
    </main>
  );
}
