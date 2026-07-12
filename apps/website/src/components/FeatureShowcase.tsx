import { useState } from "react";
import { usePostHog } from "posthog-js/react";
import { FeatureMockups, type FeatureKey } from "./FeatureMockups";

const FEATURES: { key: FeatureKey; label: string }[] = [
  { key: "chat", label: "Ask AI" },
  { key: "notes", label: "Notes" },
  { key: "tasks", label: "Tasks" },
  { key: "habits", label: "Habits" },
];

function chipStyle(on: boolean): React.CSSProperties {
  return {
    padding: "9px 18px",
    borderRadius: 999,
    fontFamily: "'Geist', sans-serif",
    fontSize: 14,
    fontWeight: 550,
    cursor: "pointer",
    whiteSpace: "nowrap",
    border: `1px solid ${on ? "#f76808" : "#e0e0dc"}`,
    background: on ? "#f76808" : "#ffffff",
    color: on ? "#ffffff" : "#595954",
    transition: "all .15s ease",
  };
}

/** Feature chips + the faux Safari window that previews each feature. */
export function FeatureShowcase() {
  const posthog = usePostHog();
  const [feature, setFeature] = useState<FeatureKey>("chat");

  const handleFeatureClick = (key: FeatureKey) => {
    setFeature(key);
    posthog.capture("feature_tab_clicked", { feature_name: key });
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          justifyContent: "center",
          marginTop: 36,
        }}
      >
        {FEATURES.map((f) => (
          <button key={f.key} type="button" onClick={() => handleFeatureClick(f.key)} style={chipStyle(f.key === feature)}>
            {f.label}
          </button>
        ))}
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: 980,
          marginTop: 40,
          borderRadius: 14,
          background: "#ffffff",
          border: "1px solid #e0e0dc",
          boxShadow: "0 18px 40px rgba(17,17,16,0.13), 0 3px 10px rgba(17,17,16,0.05)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            height: 48,
            padding: "0 16px",
            background: "linear-gradient(#f8f8f6,#f1f1ee)",
            borderBottom: "1px solid #e0e0dc",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e" }} />
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
          </div>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                minWidth: 0,
                maxWidth: 380,
                width: "100%",
                height: 30,
                padding: "0 14px",
                background: "#ffffff",
                border: "1px solid #e0e0dc",
                borderRadius: 8,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                <path d="M6 10V8a6 6 0 1 1 12 0v2" stroke="#a7a7a1" strokeWidth="2" strokeLinecap="round" />
                <rect x="4" y="10" width="16" height="10" rx="2" fill="#a7a7a1" />
              </svg>
              <span style={{ fontFamily: "'Geist', sans-serif", fontSize: 13, color: "#595954" }}>
                companion.app/{feature}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexShrink: 0, color: "#a7a7a1" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 3v12M12 3 8 7M12 3l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </div>
        <div style={{ height: 480, background: "#f5f5f3" }}>
          <FeatureMockups feature={feature} />
        </div>
      </div>
    </>
  );
}
