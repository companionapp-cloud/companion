import { Button } from "@companion/design-system";
import { useState } from "react";
import { usePostHog } from "posthog-js/react";

/** "Was this page helpful?" row at the end of docs articles. */
export function FeedbackRow() {
  const posthog = usePostHog();
  const [answered, setAnswered] = useState(false);

  const handleFeedback = (helpful: boolean) => {
    posthog.capture("doc_feedback_submitted", {
      helpful,
      path: typeof window !== "undefined" ? window.location.pathname : null,
    });
    setAnswered(true);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        padding: "24px 0",
        borderTop: "1px solid #ededea",
        borderBottom: "1px solid #ededea",
      }}
    >
      <span style={{ fontFamily: "'Geist', sans-serif", fontSize: 16, fontWeight: 500, color: "#1a1a18" }}>
        Was this page helpful?
      </span>
      {answered ? (
        <span style={{ fontFamily: "'Geist', sans-serif", fontSize: 14, color: "#7b7b75" }}>
          Thanks for the feedback!
        </span>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" size="sm" label="Yes" onPress={() => handleFeedback(true)} />
          <Button variant="secondary" size="sm" label="No" onPress={() => handleFeedback(false)} />
        </div>
      )}
    </div>
  );
}
