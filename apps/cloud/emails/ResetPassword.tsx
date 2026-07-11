import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

// ResetPassword is the forgot-password email. Rendered to static HTML at build time with
// {{placeholder}} props the Go cloud binary substitutes per recipient before sending.
export function ResetPassword(props: { resetUrl: string; firstName: string; baseUrl: string }) {
  return (
    <Html>
      <Head />
      <Preview>Reset your Companion Cloud password</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section>
            <img src={`${props.baseUrl}/brandmark.png`} width="28" height="28" alt="Companion" style={logo} />
            <Heading style={heading}>Reset your password</Heading>
            <Text style={text}>Hi {props.firstName},</Text>
            <Text style={text}>
              We received a request to reset your Companion Cloud password. Click below to
              choose a new one. This link expires in one hour.
            </Text>
            <Button style={button} href={props.resetUrl}>
              Reset password
            </Button>
            <Text style={muted}>
              Or paste this link into your browser:
              <br />
              {props.resetUrl}
            </Text>
            <Hr style={hr} />
            <Text style={muted}>
              If you didn’t request this, you can safely ignore this email — your password
              won’t change.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default ResetPassword;

const body = { backgroundColor: "#f5f5f3", fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" };
const container = { backgroundColor: "#ffffff", borderRadius: "12px", padding: "40px", maxWidth: "480px", margin: "40px auto" };
const logo = { width: "28px", height: "28px", borderRadius: "8px", backgroundColor: "#f76808", marginBottom: "24px", display: "block" as const };
const heading = { fontSize: "22px", fontWeight: 700, color: "#1a1a18", margin: "0 0 16px" };
const text = { fontSize: "15px", lineHeight: "24px", color: "#1a1a18", margin: "0 0 12px" };
const button = { backgroundColor: "#f76808", color: "#ffffff", fontSize: "15px", fontWeight: 600, borderRadius: "8px", padding: "11px 20px", textDecoration: "none", display: "inline-block", margin: "12px 0" };
const muted = { fontSize: "13px", lineHeight: "20px", color: "#7b7b75", margin: "12px 0 0", wordBreak: "break-all" as const };
const hr = { borderColor: "#e2e2dd", margin: "24px 0" };
