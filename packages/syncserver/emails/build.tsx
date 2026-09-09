import { render } from "@react-email/render";
import { mkdirSync, writeFileSync } from "node:fs";
import { VerifyEmail } from "./VerifyEmail";
import { ResetPassword } from "./ResetPassword";

// Renders each email template to static HTML with {{placeholder}} props. The Go sync server
// (packages/syncserver, shared by the open-core server and the cloud) embeds these files and
// substitutes the placeholders per recipient before sending. The rendered dist/ is committed
// so `go build` needs no Node; re-run `make emails` after editing a template.
const templates: { file: string; html: Promise<string> }[] = [
  {
    file: "verify-email.html",
    html: render(<VerifyEmail verifyUrl="{{verifyUrl}}" firstName="{{firstName}}" />, { pretty: true }),
  },
  {
    file: "reset-password.html",
    html: render(<ResetPassword resetUrl="{{resetUrl}}" firstName="{{firstName}}" />, { pretty: true }),
  },
];

mkdirSync("dist", { recursive: true });
for (const t of templates) {
  writeFileSync(`dist/${t.file}`, await t.html);
  console.log(`rendered dist/${t.file}`);
}
