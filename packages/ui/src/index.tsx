import type { PropsWithChildren, ReactNode } from "react";

export function PageShell({
  title,
  subtitle,
  children,
}: PropsWithChildren<{ title: string; subtitle?: string }>) {
  return (
    <main
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top left, #ffefd6 0%, #f4f0e8 30%, #dbe5ec 100%)",
        color: "#16212d",
        fontFamily: "Georgia, 'Times New Roman', serif",
        padding: "48px 24px 72px",
      }}
    >
      <div style={{ margin: "0 auto", maxWidth: 1120 }}>
        <header style={{ marginBottom: 32 }}>
          <p
            style={{
              letterSpacing: "0.14em",
              fontSize: 12,
              textTransform: "uppercase",
              margin: "0 0 12px",
              color: "#4a5a6a",
            }}
          >
            Automakit
          </p>
          <h1 style={{ fontSize: 48, margin: 0 }}>{title}</h1>
          {subtitle ? (
            <p style={{ fontSize: 20, lineHeight: 1.5, maxWidth: 720, marginTop: 12 }}>
              {subtitle}
            </p>
          ) : null}
        </header>
        {children}
      </div>
    </main>
  );
}

export function Card({
  heading,
  children,
}: PropsWithChildren<{ heading: string; children: ReactNode }>) {
  return (
    <section
      style={{
        background: "rgba(255,255,255,0.72)",
        border: "1px solid rgba(22,33,45,0.12)",
        borderRadius: 18,
        padding: 20,
        boxShadow: "0 12px 40px rgba(22,33,45,0.08)",
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: 22 }}>{heading}</h2>
      {children}
    </section>
  );
}
