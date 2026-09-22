import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

// AccountDeletion confirms that an account is scheduled for deletion and how to take it back.
// Rendered to static HTML at build time with {{placeholder}} props the Go sync server
// substitutes per recipient before sending. deleteDate is a human date in UTC.
export function AccountDeletion(props: { firstName: string; deleteDate: string }) {
  return (
    <Html>
      <Head />
      <Preview>{`Your Companion account will be deleted on ${props.deleteDate}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section>
            <div style={logo} />
            <Heading style={heading}>Your account is scheduled for deletion</Heading>
            <Text style={text}>Hi {props.firstName},</Text>
            <Text style={text}>
              Your Companion account and everything in it will be permanently deleted on{" "}
              {props.deleteDate}.
            </Text>
            <Text style={text}>
              Changed your mind? Sign in before then and your account will be restored.
            </Text>
            <Hr style={hr} />
            <Text style={muted}>If you didn’t ask for this, sign in and change your password.</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default AccountDeletion;

const body = { backgroundColor: "#f5f5f3", fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" };
const container = { backgroundColor: "#ffffff", borderRadius: "12px", padding: "40px", maxWidth: "480px", margin: "40px auto" };
const logo = { width: "28px", height: "28px", borderRadius: "8px", backgroundColor: "#f76808", marginBottom: "24px", display: "block" as const };
const heading = { fontSize: "22px", fontWeight: 700, color: "#1a1a18", margin: "0 0 16px" };
const text = { fontSize: "15px", lineHeight: "24px", color: "#1a1a18", margin: "0 0 12px" };
const muted = { fontSize: "13px", lineHeight: "20px", color: "#7b7b75", margin: "12px 0 0", wordBreak: "break-all" as const };
const hr = { borderColor: "#e2e2dd", margin: "24px 0" };
