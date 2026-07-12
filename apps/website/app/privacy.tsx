import { LegalPage } from "../src/components/LegalPage";

export default function Privacy() {
  return (
    <LegalPage
      heading="Privacy Policy"
      updated="July 12, 2026"
      intro="Companion is local-first and open source. Your notes, tasks, and habits live on your own devices by default — this policy explains what little we collect, and why."
      toc={[
        { href: "#collect", label: "What we collect" },
        { href: "#use", label: "How we use it" },
        { href: "#content", label: "Your content & where it lives" },
        { href: "#sharing", label: "Sharing & disclosure" },
        { href: "#rights", label: "Your rights" },
        { href: "#changes", label: "Changes to this policy" },
      ]}
    >
      <h2 id="collect">What we collect</h2>
      <p>
        We collect as little as possible. If you use Companion entirely on your own devices, we collect{" "}
        <strong>nothing</strong>. When you opt into features that need a server, we collect only what's required to run
        them:
      </p>
      <ul>
        <li>
          <strong>Companion Cloud account.</strong> If you sign up for hosted sync, we store your email address and an
          encrypted copy of your synced data.
        </li>
        <li>
          <strong>Diagnostics (optional).</strong> If you turn on crash and usage reporting, we receive anonymized
          diagnostics to help fix bugs. This is off by default.
        </li>
        <li>
          <strong>Support messages.</strong> When you contact us, we keep your message and email so we can reply.
        </li>
      </ul>

      <h2 id="use">How we use it</h2>
      <p>
        We use this information only to provide and improve Companion: to sync your data across your devices, to respond
        to your support requests, and to diagnose problems. We do not use your content to train models, build
        advertising profiles, or anything unrelated to running the app.
      </p>

      <h2 id="content">Your content &amp; where it lives</h2>
      <p>
        Your notes, tasks, and habits are yours. By default they're stored locally on your device. If you enable sync,
        they're encrypted and stored on <a href="/docs">Companion Cloud</a> — or on <strong>your own server</strong> if
        you self-host. We can't read the contents of your synced data.
      </p>

      <h2 id="sharing">Sharing &amp; disclosure</h2>
      <p>
        We do not sell your data, and we don't share it with third parties for advertising. We may disclose information
        only when required by law, or to a service provider that helps us operate the cloud under strict
        confidentiality. Because Companion is open source, you can always verify exactly how your data is handled in the
        code.
      </p>

      <h2 id="rights">Your rights</h2>
      <p>You're in control of your data at all times. You can:</p>
      <ul>
        <li>
          <strong>Export</strong> everything as plain files, any time, from within the app.
        </li>
        <li>
          <strong>Delete</strong> your Companion Cloud account and all associated data — see{" "}
          <a href="/docs">Delete account &amp; data</a>.
        </li>
        <li>
          <strong>Self-host</strong> to keep your data entirely under your own control.
        </li>
      </ul>

      <h2 id="changes">Changes to this policy</h2>
      <p>
        If we make material changes, we'll update the date above and note them in the repository. Questions?{" "}
        <a href="/contact">Get in touch</a> — we're happy to explain anything here.
      </p>
    </LegalPage>
  );
}
