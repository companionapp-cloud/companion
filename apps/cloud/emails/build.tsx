import { render } from "@react-email/render";
import { mkdirSync, writeFileSync } from "node:fs";
import { VerifyEmail } from "./VerifyEmail";
import { ResetPassword } from "./ResetPassword";

// Renders each email template to static HTML with {{placeholder}} props. The Go cloud
// binary embeds these files and substitutes the placeholders per recipient before sending.
// Keeping the render at build time means the runtime needs no Node/React.
const templates: { file: string; html: Promise<string> }[] = [
  {
    file: "verify-email.html",
    html: render(<VerifyEmail verifyUrl="{{verifyUrl}}" firstName="{{firstName}}" baseUrl="{{baseUrl}}" />, { pretty: true }),
  },
  {
    file: "reset-password.html",
    html: render(<ResetPassword resetUrl="{{resetUrl}}" firstName="{{firstName}}" baseUrl="{{baseUrl}}" />, { pretty: true }),
  },
];

mkdirSync("dist", { recursive: true });
for (const t of templates) {
  writeFileSync(`dist/${t.file}`, await t.html);
  console.log(`rendered dist/${t.file}`);
}
